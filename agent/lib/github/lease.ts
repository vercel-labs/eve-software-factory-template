import { randomUUID } from "node:crypto";
import { getToken } from "@vercel/connect";
import type { SandboxNetworkPolicy, SandboxNetworkRule } from "eve/sandbox";
import { factoryRepo } from "../constants.js";
import {
  bodiesToFiles,
  GH_ENVIRONMENT,
  type GhInvocation,
  ghCommandLine,
} from "./cli.js";
import { GITHUB_CONNECTOR, githubCredentials } from "./credentials.js";
import type { GitInvocation } from "./git-cli.js";
import { mintInstallationToken } from "./git-remote.js";

/**
 * Credential leases: how the real `gh` and `git` binaries in a sandbox get
 * to act on GitHub without the token ever entering the sandbox.
 *
 * @remarks
 * A lease lasts one command. The process is handed a random placeholder as
 * its credential; the sandbox firewall recognizes a request carrying that
 * exact placeholder and swaps in the real installation token on the way out.
 * When the command returns, the firewall goes back to plain egress and the
 * placeholder is worthless. This mirrors how eve's own tooling brokers
 * GitHub credentials, built here on the plain binaries.
 *
 * The token itself is minted per lease and scoped twice: to the factory
 * repository alone, and to the permissions that class of command needs
 * ({@link TOKEN_SCOPES}). The scope is the backstop behind the argv
 * allowlist in `cli.ts`: a station can run arbitrary code in its sandbox, so
 * whatever it might do with a lease is bounded by what the leased token can
 * do. No scope outside `repo-push` can write repository contents, which is
 * what merging and pushing both need.
 */

/** What a leased token is for. */
export type TokenScope = "repo-read" | "repo-triage" | "repo-push";

interface ScopePermissions {
  /** Requested when the installation grants them; dropped when it doesn't. */
  readonly optional: readonly string[];
  readonly required: readonly string[];
}

const CI_READS = ["actions:read", "checks:read", "statuses:read"] as const;

/**
 * GitHub App permissions per scope, in `<permission>:<level>` form.
 *
 * - `repo-read`: stations reading issues, pull requests, and CI.
 * - `repo-triage`: the orchestrator's `gh`: issues and pull requests, with
 *   repository contents read-only, so this token cannot merge or push.
 * - `repo-push`: a station pushing its feature branch. `workflows:write`
 *   lets a change touch `.github/workflows` when the app was granted it.
 */
export const TOKEN_SCOPES: Readonly<Record<TokenScope, ScopePermissions>> = {
  "repo-push": { optional: ["workflows:write"], required: ["contents:write"] },
  "repo-read": {
    optional: CI_READS,
    required: ["contents:read", "issues:read", "pull_requests:read"],
  },
  "repo-triage": {
    optional: CI_READS,
    required: ["contents:read", "issues:write", "pull_requests:write"],
  },
};

export type TokenMinter = (
  permissions: readonly string[] | null
) => Promise<string>;

/**
 * Mints an installation token for the factory repository through Vercel
 * Connect, limited to `permissions` (or carrying every permission the app
 * holds when `permissions` is null).
 */
export const connectMinter: TokenMinter = (permissions) =>
  getToken(GITHUB_CONNECTOR, {
    authorizationDetails: [
      {
        org: factoryRepo.owner,
        repositories: [factoryRepo.repo],
        type: "github_app_installation",
        ...(permissions === null ? {} : { permissions: [...permissions] }),
      },
    ],
    subject: { type: "app" },
  });

/**
 * The connector's own installation token, exactly as the GitHub channel
 * uses it: every permission the app holds, on every repository the
 * installation covers.
 */
export const channelInstallationToken = (): Promise<string> =>
  mintInstallationToken(githubCredentials);

/**
 * How long a narrower-than-ideal result is remembered before the full
 * permission set is tried again.
 *
 * @remarks
 * A refusal is usually permanent (the installation lacks a permission), so
 * remembering it saves a failed request per lease. But a network blip looks
 * the same from here, and remembering that forever would quietly leave a
 * scope wider than it needs to be until the process restarts.
 */
export const SCOPE_DOWNGRADE_TTL_MS = 10 * 60 * 1000;

interface ResolvedScope {
  /** Epoch milliseconds after which the full set is tried again. */
  readonly expiresAt: number;
  /** The permission list that worked, `null` for repository-scoped only, or `"installation"`. */
  readonly permissions: readonly string[] | null | "installation";
}

/** Which permission set last worked for each scope, so a miss is paid once. */
const resolvedScopes = new Map<TokenScope, ResolvedScope>();

/** Clears the per-scope memo. For tests. */
export const resetTokenScopeMemo = (): void => {
  resolvedScopes.clear();
};

const strictScopes = (): boolean =>
  process.env.FACTORY_STRICT_TOKEN_SCOPES === "1";

type Rung = ResolvedScope["permissions"];

/** Says so in the logs when a token is wider than its scope asked for. */
const warnIfWidened = (scope: TokenScope, rung: Rung): void => {
  if (rung !== null && rung !== "installation") {
    return;
  }
  console.warn(
    `GitHub token for scope "${scope}" could not be narrowed to [${TOKEN_SCOPES[scope].required.join(", ")}]; using ${
      rung === null
        ? "the app's full permissions on the factory repository"
        : "the connector's unscoped installation token"
    }. Check the GitHub App's permissions, or set FACTORY_STRICT_TOKEN_SCOPES=1 to fail instead.`
  );
};

export interface MintDependencies {
  /**
   * Last-resort token source, used when the connector refuses every scoped
   * request. Defaults to {@link channelInstallationToken} in the app.
   */
  readonly installationToken?: () => Promise<string>;
  readonly mint?: TokenMinter;
  /** Clock, for the downgrade memo. Injected by tests. */
  readonly now?: () => number;
}

/**
 * Mints a token for `scope`, narrowing as far as the installation allows.
 *
 * @remarks
 * GitHub refuses a token request that names a permission the installation
 * wasn't granted, and installations differ, so this walks down a ladder and
 * takes the first rung that holds:
 *
 * 1. the scope's required and optional permissions, on the factory repository;
 * 2. the required permissions alone;
 * 3. every permission the app holds, still limited to the factory repository;
 * 4. the connector's plain installation token.
 *
 * Rungs 3 and 4 are wider than the scope asks for, and each says so in the
 * logs when it is used: a factory that stops working over a hardening step
 * is the worse failure, but it should never widen silently. Set
 * `FACTORY_STRICT_TOKEN_SCOPES=1` to stop at rung 2 and fail instead.
 */
export const mintScopedToken = async (
  scope: TokenScope,
  dependencies: MintDependencies = {}
): Promise<string> => {
  const mint = dependencies.mint ?? connectMinter;
  const now = dependencies.now ?? Date.now;
  // An injected minter is a test's whole world: it gets no real fallback
  // unless the test also provides one.
  const installationToken =
    dependencies.installationToken ??
    (dependencies.mint ? undefined : channelInstallationToken);
  const { optional, required } = TOKEN_SCOPES[scope];

  const request = (rung: Rung): Promise<string> => {
    if (rung === "installation") {
      if (!installationToken) {
        throw new Error("No installation token source is configured.");
      }
      return installationToken();
    }
    return mint(rung);
  };

  const remembered = resolvedScopes.get(scope);
  if (remembered && remembered.expiresAt > now()) {
    return await request(remembered.permissions);
  }

  const ladder: Rung[] = [[...required, ...optional], required];
  if (!strictScopes()) {
    ladder.push(
      null,
      ...(installationToken ? (["installation"] as const) : [])
    );
  }
  let lastError: unknown;
  for (const [index, rung] of ladder.entries()) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: each rung is only tried when the one above it was refused
      const token = await request(rung);
      if (!token) {
        throw new Error("The connector returned an empty token.");
      }
      warnIfWidened(scope, rung);
      resolvedScopes.set(scope, {
        expiresAt:
          index === 0
            ? Number.POSITIVE_INFINITY
            : now() + SCOPE_DOWNGRADE_TTL_MS,
        permissions: rung,
      });
      return token;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `Could not mint a GitHub token for scope "${scope}". Check that the GitHub connector's app is installed on the factory repository with the permissions the factory needs.`,
    { cause: lastError }
  );
};

const basic = (secret: string): string =>
  `Basic ${Buffer.from(`x-access-token:${secret}`).toString("base64")}`;

/**
 * The firewall policy for one lease.
 *
 * @remarks
 * Each rule matches only a request whose `authorization` header carries this
 * lease's placeholder, then replaces the header with the real credential.
 * A request from anything else in the sandbox passes through untouched, so
 * a process that never saw the placeholder gets nothing. `"*": []` keeps
 * ordinary egress open while the lease is active.
 */
export const leasePolicy = (
  kind: "gh" | "git",
  token: string,
  placeholder: string
): SandboxNetworkPolicy => {
  if (kind === "gh") {
    const api: SandboxNetworkRule[] = [
      {
        match: {
          headers: [
            {
              key: { exact: "authorization" },
              value: { regex: `^(?:token|Bearer) ${placeholder}$` },
            },
          ],
        },
        transform: [{ headers: { authorization: `Bearer ${token}` } }],
      },
    ];
    return {
      allow: { "*": [], "api.github.com": api, "uploads.github.com": api },
    };
  }
  const git: SandboxNetworkRule[] = [
    {
      match: {
        headers: [
          {
            key: { exact: "authorization" },
            value: { exact: basic(placeholder) },
          },
        ],
      },
      transform: [{ headers: { authorization: basic(token) } }],
    },
  ];
  return {
    allow: { "*": [], "codeload.github.com": git, "github.com": git },
  };
};

/** The slice of a Vercel sandbox session a lease needs. */
export interface LeaseSandbox {
  readonly name: string;
  readonly run: (options: {
    command: string;
    env?: Record<string, string>;
    signal?: AbortSignal;
    workingDirectory?: string;
  }) => PromiseLike<{ exitCode: number; stderr: string; stdout: string }>;
  readonly setNetworkPolicy: (policy: SandboxNetworkPolicy) => Promise<void>;
  readonly writeTextFile: (options: {
    content: string;
    path: string;
  }) => PromiseLike<void>;
}

export interface CliResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
  /** True when either stream was cut to fit {@link MAX_OUTPUT_CHARACTERS}. */
  readonly truncated: boolean;
}

export const MAX_OUTPUT_CHARACTERS = 60_000;
export const GH_TIMEOUT_MS = 90_000;
export const GIT_TIMEOUT_MS = 110_000;

/**
 * One lease at a time per sandbox.
 *
 * @remarks
 * Setting a network policy replaces the whole policy, so two overlapping
 * leases on one sandbox would clear each other's credential mid-command.
 * The model can issue several tool calls in one step and eve runs them
 * together, so each sandbox gets a queue, keyed by the sandbox's name
 * because every `getSandbox()` call returns a fresh handle.
 */
const queues = new Map<string, Promise<unknown>>();

const serialized = <T>(key: string, work: () => Promise<T>): Promise<T> => {
  const next = (queues.get(key) ?? Promise.resolve()).then(work, work);
  const settled = next.catch(() => undefined);
  queues.set(key, settled);
  settled.then(() => {
    if (queues.get(key) === settled) {
      queues.delete(key);
    }
  });
  return next;
};

/**
 * Removes the lease's own credential from command output and bounds it.
 *
 * @remarks
 * The redaction is exact, not pattern-based. The secrets are known here, and
 * the output is what an agent reads to do its job: a diff of authentication
 * code or a CI log is full of lines that look like credentials to a pattern
 * and are nothing of the kind.
 */
const clean = (
  text: string,
  secrets: readonly string[]
): { text: string; truncated: boolean } => {
  let cleaned = text;
  for (const secret of secrets) {
    cleaned = cleaned.replaceAll(secret, "[redacted]");
  }
  return cleaned.length > MAX_OUTPUT_CHARACTERS
    ? {
        text: `${cleaned.slice(0, MAX_OUTPUT_CHARACTERS)}\n[output truncated]`,
        truncated: true,
      }
    : { text: cleaned, truncated: false };
};

export interface LeaseDependencies extends MintDependencies {
  /** Makes the per-lease placeholder. Injected by tests. */
  readonly id?: () => string;
}

interface LeasedCommand {
  readonly command: string;
  readonly env: Record<string, string>;
  /** Omit for a command with no time limit of its own (the initial clone). */
  readonly timeoutMs?: number;
  readonly workingDirectory?: string;
}

/**
 * Runs one command under a credential lease and always ends the lease.
 *
 * @param build - Receives the placeholder and returns the command to run.
 */
const withLease = (
  sandbox: LeaseSandbox,
  kind: "gh" | "git",
  scope: TokenScope,
  dependencies: LeaseDependencies,
  build: (placeholder: string) => Promise<LeasedCommand> | LeasedCommand
): Promise<CliResult> =>
  serialized(sandbox.name, async () => {
    const placeholder = `factory-${(dependencies.id ?? randomUUID)()}`;
    const token = await mintScopedToken(scope, dependencies);
    const leased = await build(placeholder);
    await sandbox.setNetworkPolicy(leasePolicy(kind, token, placeholder));
    try {
      const result = await sandbox.run({
        command: leased.command,
        env: leased.env,
        ...(leased.timeoutMs === undefined
          ? {}
          : { signal: AbortSignal.timeout(leased.timeoutMs) }),
        ...(leased.workingDirectory
          ? { workingDirectory: leased.workingDirectory }
          : {}),
      });
      const secrets = [token, basic(token)];
      const stdout = clean(String(result.stdout ?? ""), secrets);
      const stderr = clean(String(result.stderr ?? ""), secrets);
      return {
        exitCode: result.exitCode,
        stderr: stderr.text,
        stdout: stdout.text,
        truncated: stdout.truncated || stderr.truncated,
      };
    } finally {
      await sandbox.setNetworkPolicy("allow-all");
    }
  });

/**
 * Runs a validated `gh` invocation in the sandbox under a lease.
 *
 * @remarks
 * Comment and pull request bodies are written to files in the sandbox and
 * passed with `--body-file`, then removed, so model-written prose never sits
 * on a command line.
 */
export const runGh = (
  sandbox: LeaseSandbox,
  invocation: GhInvocation,
  scope: TokenScope,
  dependencies: LeaseDependencies = {}
): Promise<CliResult> =>
  withLease(sandbox, "gh", scope, dependencies, async (placeholder) => {
    const { args, files } = bodiesToFiles(
      invocation,
      (index) => `/tmp/${placeholder}-body-${index}.md`
    );
    await Promise.all(files.map((file) => sandbox.writeTextFile(file)));
    const run = ghCommandLine(args);
    const command =
      files.length === 0
        ? run
        : `${run}; status=$?; rm -f ${files.map((file) => `'${file.path}'`).join(" ")}; exit $status`;
    return {
      command,
      env: {
        ...GH_ENVIRONMENT,
        GH_CONFIG_DIR: `/tmp/${placeholder}-config`,
        GH_TOKEN: placeholder,
      },
      timeoutMs: GH_TIMEOUT_MS,
    };
  });

/**
 * Git configuration for one leased command, passed through the environment
 * so nothing is written to the checkout's own config.
 *
 * @remarks
 * - The `extraheader` carries the placeholder for the firewall to swap.
 * - Hooks are disabled: a `pre-push` hook in the checkout is a file the
 *   model can write, and it would run while the lease is live.
 * - Only HTTPS transport is allowed, so a rewritten remote can't route the
 *   command through another protocol helper.
 */
const gitEnvironment = (placeholder: string): Record<string, string> => {
  const config: [string, string][] = [
    [
      "http.https://github.com/.extraheader",
      `Authorization: ${basic(placeholder)}`,
    ],
    ["core.hooksPath", "/dev/null"],
    ["protocol.allow", "never"],
    ["protocol.https.allow", "always"],
  ];
  const env: Record<string, string> = {
    GIT_CONFIG_COUNT: String(config.length),
    GIT_TERMINAL_PROMPT: "0",
    PATH: "/usr/local/bin:/usr/bin:/bin",
  };
  config.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
};

/** Runs a validated networked git invocation in the sandbox under a lease. */
export const runGitNetwork = (
  sandbox: LeaseSandbox,
  invocation: GitInvocation,
  dependencies: LeaseDependencies = {}
): Promise<CliResult> =>
  withLease(
    sandbox,
    "git",
    invocation.mutatesRemote ? "repo-push" : "repo-read",
    dependencies,
    (placeholder) => ({
      command: invocation.commandLine,
      env: gitEnvironment(placeholder),
      timeoutMs: GIT_TIMEOUT_MS,
    })
  );

/**
 * Runs a git command line the factory wrote itself (not one a model
 * supplied) under a read-only lease. Used for a station's initial clone.
 *
 * @remarks
 * Callers pass a fixed command, such as `cloneCommand(REMOTE_URL)`; nothing
 * model-written may reach this function, since it does no validation of its
 * own.
 */
export const runLeasedGitCommand = (
  sandbox: LeaseSandbox,
  commandLine: string,
  dependencies: LeaseDependencies = {}
): Promise<CliResult> =>
  withLease(sandbox, "git", "repo-read", dependencies, (placeholder) => ({
    command: commandLine,
    env: gitEnvironment(placeholder),
  }));
