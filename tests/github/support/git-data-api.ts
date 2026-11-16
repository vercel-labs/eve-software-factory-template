import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface TreeEntry {
  mode: string;
  path: string;
  sha: string | null;
}

// biome-ignore lint/suspicious/noExplicitAny: request bodies are untyped JSON
type Body = Record<string, any>;

interface Reply {
  body: object;
  status: number;
}

/** One request the stand-in received, as the script sent it. */
export interface RecordedRequest {
  readonly authorization: string | undefined;
  readonly body: Body;
  readonly method: string;
  /** The path after `/repos/<owner>/<repo>`. */
  readonly path: string;
  /** The `<owner>/<repo>` the request named, or null when it named none. */
  readonly repository: string | null;
}

const ZERO_SHA = "0".repeat(40);
const REPO_PREFIX = /^\/repos\/([^/]+\/[^/]+)/;
const BRANCH_REF = /^\/git\/refs\/heads\/(.+)$/;
const BRANCH_LOOKUP = /^\/git\/ref\/heads\/(.+)$/;
const COMMIT_LOOKUP = /^\/git\/commits\/([0-9a-f]{40})$/;

/**
 * A stand-in for GitHub's Git Data API (blobs, trees, commits, refs) that
 * writes into a local bare repository, so a test can push through the
 * signed-push script and inspect the result with plain git.
 *
 * @remarks
 * It behaves like GitHub where the script depends on it:
 *
 * - Commits get the app's identity as author, as commits a GitHub App
 *   creates do. That identity is how a test tells a recreated commit from
 *   one that was pushed as it was.
 * - A tree with no entries is rejected, and so is a tree that names an
 *   object the repository does not have.
 * - A ref update that is not a fast-forward is rejected unless forced, and
 *   a ref cannot be created at a commit the repository does not have.
 *
 * Every request is recorded, with its authorization header.
 *
 * @param bareRepo - The bare repository standing in for GitHub.
 * @param options.failures - What to answer the next requests with, in
 * order, to exercise the script's retries: a status refuses that request
 * without handling it, and `null` lets it through.
 */
export async function startGitDataApi(
  bareRepo: string,
  options: { failures?: (number | null)[] } = {}
) {
  const requests: RecordedRequest[] = [];
  const failures = [...(options.failures ?? [])];
  const scratch = mkdtempSync(join(tmpdir(), "factory-git-data-api-"));
  const index = { GIT_INDEX_FILE: join(scratch, "index") };
  const git = (args: string[], input?: Buffer | string, env?: object) =>
    execFileSync("git", ["--git-dir", bareRepo, ...args], {
      env: { ...process.env, ...env },
      input,
      stdio: ["pipe", "pipe", "ignore"],
    })
      .toString()
      .trim();
  const has = (object: string) => {
    try {
      git(["cat-file", "-e", object]);
      return true;
    } catch {
      return false;
    }
  };
  const isAncestor = (ancestor: string, commit: string) => {
    try {
      git(["merge-base", "--is-ancestor", ancestor, commit]);
      return true;
    } catch {
      return false;
    }
  };

  const createBlob = (body: Body): Reply => {
    const content = Buffer.from(body.content, "base64");
    return {
      body: { sha: git(["hash-object", "-w", "--stdin"], content) },
      status: 201,
    };
  };

  const createTree = (body: Body): Reply => {
    const entries = body.tree as TreeEntry[];
    if (entries.length === 0) {
      return { body: { message: "Invalid tree info" }, status: 422 };
    }
    const missing = entries.find(
      (entry) =>
        entry.sha !== null && entry.mode !== "160000" && !has(entry.sha)
    );
    if (missing || (body.base_tree && !has(body.base_tree))) {
      return {
        body: { message: "tree.sha is not a valid blob or tree" },
        status: 422,
      };
    }
    const base = body.base_tree ? [body.base_tree] : ["--empty"];
    git(["read-tree", ...base], undefined, index);
    const lines = entries.map((entry) =>
      entry.sha === null
        ? `0 ${ZERO_SHA}\t${entry.path}`
        : `${entry.mode} ${entry.sha}\t${entry.path}`
    );
    git(["update-index", "--index-info"], `${lines.join("\n")}\n`, index);
    return {
      body: { sha: git(["write-tree"], undefined, index) },
      status: 201,
    };
  };

  const createCommit = (body: Body): Reply => {
    const parents = body.parents as string[];
    if (!has(body.tree) || parents.some((parent) => !has(parent))) {
      return { body: { message: "Object does not exist" }, status: 422 };
    }
    const sha = git(
      [
        "commit-tree",
        body.tree,
        ...parents.flatMap((parent) => ["-p", parent]),
        "-F",
        "-",
      ],
      body.message,
      {
        GIT_AUTHOR_EMAIL: "app[bot]@users.noreply.github.com",
        GIT_AUTHOR_NAME: "app[bot]",
        GIT_COMMITTER_EMAIL: "noreply@github.com",
        GIT_COMMITTER_NAME: "GitHub",
      }
    );
    return { body: { sha }, status: 201 };
  };

  const createRef = (body: Body): Reply => {
    if (!has(body.sha)) {
      return { body: { message: "Object does not exist" }, status: 422 };
    }
    if (has(body.ref)) {
      return { body: { message: "Reference already exists" }, status: 422 };
    }
    git(["update-ref", body.ref, body.sha]);
    return { body: { ref: body.ref }, status: 201 };
  };

  const getRef = (branch: string): Reply => {
    try {
      const sha = git([
        "rev-parse",
        "--verify",
        "--quiet",
        `refs/heads/${branch}`,
      ]);
      return { body: { object: { sha } }, status: 200 };
    } catch {
      return { body: { message: "Not Found" }, status: 404 };
    }
  };

  const updateRef = (branch: string, body: Body): Reply => {
    const current = git(["rev-parse", `refs/heads/${branch}`]);
    if (!has(body.sha)) {
      return { body: { message: "Object does not exist" }, status: 422 };
    }
    if (!(body.force || isAncestor(current, body.sha))) {
      return { body: { message: "Update is not a fast forward" }, status: 422 };
    }
    git(["update-ref", `refs/heads/${branch}`, body.sha]);
    return { body: { ref: `refs/heads/${branch}` }, status: 200 };
  };

  const post = (path: string, body: Body): Reply | null => {
    switch (path) {
      case "/git/blobs":
        return createBlob(body);
      case "/git/commits":
        return createCommit(body);
      case "/git/refs":
        return createRef(body);
      case "/git/trees":
        return createTree(body);
      default:
        return null;
    }
  };

  const handle = (method: string, path: string, body: Body): Reply => {
    const posted = method === "POST" ? post(path, body) : null;
    if (posted) {
      return posted;
    }
    const lookup = path.match(BRANCH_LOOKUP)?.[1];
    if (method === "GET" && lookup) {
      return getRef(decodeURIComponent(lookup));
    }
    const commit = path.match(COMMIT_LOOKUP)?.[1];
    if (method === "GET" && commit) {
      return has(`${commit}^{commit}`)
        ? { body: { sha: commit }, status: 200 }
        : { body: { message: "Not Found" }, status: 404 };
    }
    const branch = path.match(BRANCH_REF)?.[1];
    if (method === "PATCH" && branch) {
      return updateRef(decodeURIComponent(branch), body);
    }
    return { body: { message: "Not Found" }, status: 404 };
  };

  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      const url = request.url ?? "";
      const method = request.method ?? "GET";
      let reply: Reply;
      try {
        const body = raw ? JSON.parse(raw) : {};
        requests.push({
          authorization: request.headers.authorization,
          body,
          method,
          path: url.replace(REPO_PREFIX, ""),
          repository: url.match(REPO_PREFIX)?.[1] ?? null,
        });
        const failure = failures.shift();
        reply =
          failure === undefined || failure === null
            ? handle(method, url.replace(REPO_PREFIX, ""), body)
            : { body: { message: "injected failure" }, status: failure };
      } catch (error) {
        reply = { body: { message: String(error) }, status: 500 };
      }
      response.writeHead(reply.status, { "content-type": "application/json" });
      response.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    async close() {
      await new Promise((resolve) => server.close(resolve));
      rmSync(scratch, { force: true, recursive: true });
    },
    /** The requests so far that used `method` on a path starting with `prefix`. */
    count: (method: string, prefix: string) =>
      requests.filter(
        (request) =>
          request.method === method && request.path.startsWith(prefix)
      ).length,
    requests,
    url: `http://127.0.0.1:${port}`,
  };
}
