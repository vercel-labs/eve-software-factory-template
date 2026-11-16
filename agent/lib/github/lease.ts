import { randomUUID } from "node:crypto";
import { getToken } from "@vercel/connect";
import type { SandboxNetworkPolicy, SandboxNetworkRule } from "eve/sandbox";
import { factoryRepo } from "../constants.js";
import {
  bodiesToFiles,
  GH_ENVIRONMENT,
  type GhInvocation,
  ghCommandLine,
  RUNNER_PATH,
} from "./cli.js";
import { GITHUB_CONNECTOR, githubCredentials } from "./credentials.js";
import { basePolicy, withBasePolicy } from "./egress.js";
import { pushCommandLine } from "./git-cli.js";
import { mintInstallationToken } from "./git-remote.js";
import {
  PUSH_SIGNED_SCRIPT,
  SIGNED_PUSH_TIMEOUT_MS,
  signedCommits,
  signedPushCommandLine,
  signedPushEnvironment,
} from "./push-signed.js";

/**
 * Credential leases: how the real `gh` and `git` binaries in a sandbox get
 * to act on GitHub without the token ever entering the sandbox.
 *
 * @remarks
 * A lease lasts one command. The process is handed a random placeholder as
 * its credential; the sandbox firewall recognizes a request carrying that
 * exact placeholder and swaps in the real installation token on the way out.
 * When the command returns, the firewall goes back to the sandbox's base
 * policy (`egress.ts`) and the placeholder is worthless. This mirrors how
 * eve's own tooling brokers GitHub credentials, built here on the plain
 * binaries.
 *
 * The token is minted per lease and scoped twice: to the factory repository
 * alone, and to the permissions that class of command needs
 * ({@link TOKEN_SCOPES}). A scope never widens on its own (see
 * {@link mintScopedToken}). The scope is the backstop behind the allowlist
 * in `cli.ts`: where an agent has a shell in its sandbox, whatever a
 * process there might do with a lease is bounded by what the leased token
 * can do. No scope outside `repo-push` can write repository contents, which
 * is what merging and pushing both need.
 *
 * Who gets which scope follows from who wrote the command. A command an
 * agent wrote runs in its shell under `repo-read` and nothing wider
 * ({@link withShellLease}). The scopes that write are leased only to
 * commands the runtime parsed and runs itself, by absolute path
 * ({@link runGh}, {@link runGitPush}).
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
 * - `repo-read`: every command an agent runs in its shell, the runtime's
 *   own `gh` reads, and the clone: issues, pull requests, CI, and contents.
 * - `repo-triage`: the orchestrator's `gh` commands that change GitHub:
 *   issues and pull requests, with repository contents read-only, so this
 *   token cannot merge or push.
 * - `repo-push`: the implementer pushing its feature branch. It cannot change
 *   workflow files unless {@link WORKFLOW_CHANGES_ENV} is set: a pushed
 *   workflow runs with the repository's secrets, so that permission is
 *   something a deployer turns on, not something a branch push comes with.
 */
export const TOKEN_SCOPES: Readonly<Record<TokenScope, ScopePermissions>> = {
  "repo-push": { optional: [], required: ["contents:write"] },
  "repo-read": {
    optional: CI_READS,
    required: ["contents:read", "issues:read", "pull_requests:read"],
  },
  "repo-triage": {
    optional: CI_READS,
    required: ["contents:read", "issues:write", "pull_requests:write"],
  },
};

/** Set to `1` to let the implementer's push change `.github/workflows`. */
export const WORKFLOW_CHANGES_ENV = "FACTORY_ALLOW_WORKFLOW_CHANGES";

/**
 * The permissions to request for `scope` right now: the table's, plus
 * `workflows:write` on a push when the deployer opted in
 * ({@link WORKFLOW_CHANGES_ENV}).
 */
export const permissionsFor = (scope: TokenScope): ScopePermissions => {
  const base = TOKEN_SCOPES[scope];
  return scope === "repo-push" && process.env[WORKFLOW_CHANGES_ENV] === "1"
    ? { optional: ["workflows:write"], required: base.required }
    : base;
};

export type TokenMinter = (
  permissions: readonly string[] | null
) => Promise<string>;

/**
 * Mints an installation token for the factory repository through Vercel
 * Connect.
 *
 * @param permissions - The permissions to limit the token to, or null for
 * every permission the app holds.
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
 * The connector's own installation token, not narrowed: every permission
 * the app holds, on every repository the installation covers. The last
 * rung of the ladder, and the channel's fallback ({@link mintChannelToken}).
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
 * the same from here, and remembering that forever would leave a scope
 * wider than it needs to be until the process restarts.
 */
export const SCOPE_DOWNGRADE_TTL_MS = 10 * 60 * 1000;

interface ResolvedScope {
  /** Epoch milliseconds after which the full set is tried again. */
  readonly expiresAt: number;
  /**
   * The permission list that worked, `null` for repository-scoped only, or
   * `"installation"`.
   */
  readonly permissions: readonly string[] | null | "installation";
}

/** Which permission set last worked for each scope, so a miss is paid once. */
const resolvedScopes = new Map<TokenScope, ResolvedScope>();

/** Clears the per-scope memos. For tests. */
export const resetTokenScopeMemo = (): void => {
  resolvedScopes.clear();
  strictRefusals.clear();
};

/**
 * How far below a scope's own permissions a token may fall when the
 * connector refuses to narrow, from the `FACTORY_TOKEN_FALLBACK` setting.
 *
 * - unset or `none` (the default): never. A scope gets its permissions or
 *   the command fails.
 * - `repository`: every permission the app holds, still limited to the
 *   factory repository.
 * - `installation`: that, and then the connector's plain installation token
 *   (every permission, every repository the installation covers).
 */
export type TokenFallback = "none" | "repository" | "installation";

export const TOKEN_FALLBACK_ENV = "FACTORY_TOKEN_FALLBACK";

/** Reads the setting. Anything unset or unrecognized is `none`. */
export const tokenFallback = (): TokenFallback => {
  const setting = process.env[TOKEN_FALLBACK_ENV]?.trim().toLowerCase();
  return setting === "repository" || setting === "installation"
    ? setting
    : "none";
};

type Rung = ResolvedScope["permissions"];

/** Says so in the logs when a token is wider than its scope asked for. */
const warnIfWidened = (scope: TokenScope, rung: Rung): void => {
  if (rung !== null && rung !== "installation") {
    return;
  }
  console.warn(
    `GitHub token for scope "${scope}" could not be narrowed to [${permissionsFor(scope).required.join(", ")}]; using ${
      rung === null
        ? "the app's full permissions on the factory repository"
        : "the connector's unscoped installation token"
    }, because ${TOKEN_FALLBACK_ENV} allows it. Check the GitHub App's permissions.`
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

export interface MintOptions {
  /**
   * Never accept a token wider than the scope, whatever
   * `FACTORY_TOKEN_FALLBACK` says. For a credential that a shell command
   * will hold: there the scope is the only limit there is.
   */
  readonly strict?: boolean;
}

/** No token could be minted within a scope's own permissions. */
export class NarrowTokenError extends Error {
  constructor(scope: TokenScope, required: readonly string[], cause?: unknown) {
    super(
      `Could not mint a GitHub token for scope "${scope}" with permissions [${required.join(", ")}]. Check that the GitHub connector's app is installed on the factory repository and holds those permissions. If the installation cannot issue narrowed tokens at all, ${TOKEN_FALLBACK_ENV}=repository allows a wider one.`,
      { cause }
    );
    this.name = "NarrowTokenError";
  }
}

/**
 * How long a refusal to narrow is remembered for strict callers.
 *
 * @remarks
 * Short, so that one transient failure does not leave a deployment without
 * a shell credential for long, and long enough that a deployment whose app
 * cannot narrow at all does not pay two failed requests on every command.
 */
export const STRICT_REFUSAL_TTL_MS = 60 * 1000;

const strictRefusals = new Map<TokenScope, number>();

/**
 * Walks a scope's own rungs only, remembering a refusal briefly.
 *
 * @throws When neither rung holds (`NarrowTokenError`).
 */
const mintStrict = async (
  scope: TokenScope,
  request: (rung: Rung) => Promise<string>,
  now: () => number
): Promise<string> => {
  const { optional, required } = permissionsFor(scope);
  const rungs: Rung[] = [
    [...required, ...optional],
    ...(optional.length > 0 ? [required] : []),
  ];
  let lastError: unknown;
  for (const rung of rungs) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: each rung is only tried when the one above it was refused
      return await request(rung);
    } catch (error) {
      lastError = error;
    }
  }
  strictRefusals.set(scope, now() + STRICT_REFUSAL_TTL_MS);
  throw new NarrowTokenError(scope, required, lastError);
};

/**
 * Mints a token for `scope`.
 *
 * @remarks
 * GitHub refuses a token request that names a permission the installation
 * wasn't granted, and installations differ, so this walks down a ladder and
 * takes the first rung that holds:
 *
 * 1. the scope's required and optional permissions, on the factory repository;
 * 2. the required permissions alone.
 *
 * Both rungs are within the scope, and by default the ladder ends there.
 * The scope is the backstop behind the argv allowlist, and a backstop that
 * quietly widens when something goes wrong, including something transient,
 * is not one.
 *
 * A deployer whose installation cannot be narrowed can opt into wider
 * tokens with `FACTORY_TOKEN_FALLBACK` (see {@link TokenFallback}). Each use
 * of a wider rung is logged.
 *
 * The rung that worked is remembered so a refusal is paid once, not on every
 * lease. A remembered rung that stops working is forgotten and the ladder is
 * walked again from the top; a rung below the first is also re-examined
 * after {@link SCOPE_DOWNGRADE_TTL_MS}.
 *
 * @throws When no allowed rung holds (`NarrowTokenError`, whose message
 * says what to check).
 */
export const mintScopedToken = async (
  scope: TokenScope,
  dependencies: MintDependencies = {},
  options: MintOptions = {}
): Promise<string> => (await mintForLease(scope, dependencies, options)).token;

/** A minted token, and whether it is wider than the scope asked for. */
interface MintedToken {
  readonly token: string;
  /**
   * True when the token came from a fallback rung: every permission the app
   * holds, on the factory repository or on the whole installation.
   */
  readonly widened: boolean;
}

const isWide = (rung: Rung): boolean =>
  rung === null || rung === "installation";

/** {@link mintScopedToken}, also reporting whether the token was widened. */
const mintForLease = async (
  scope: TokenScope,
  dependencies: MintDependencies = {},
  options: MintOptions = {}
): Promise<MintedToken> => {
  const strict = options.strict === true;
  const mint = dependencies.mint ?? connectMinter;
  const now = dependencies.now ?? Date.now;
  // An injected minter is a test's whole world: it gets no real fallback
  // unless the test also provides one.
  const installationToken =
    dependencies.installationToken ??
    (dependencies.mint ? undefined : channelInstallationToken);
  const { optional, required } = permissionsFor(scope);

  const request = async (rung: Rung): Promise<string> => {
    const token =
      rung === "installation"
        ? await (installationToken ?? missingInstallationToken)()
        : await mint(rung);
    if (!token) {
      throw new Error("The connector returned an empty token.");
    }
    return token;
  };

  const remembered = resolvedScopes.get(scope);
  if (strict) {
    if ((strictRefusals.get(scope) ?? 0) > now()) {
      // Narrowing was refused moments ago; asking again would only fail
      // twice more.
      throw new NarrowTokenError(scope, required);
    }
    // A wide token that worked for a command the runtime ran says nothing a
    // strict caller can use, so only the scope's own rungs are walked.
    return { token: await mintStrict(scope, request, now), widened: false };
  }
  if (remembered && remembered.expiresAt > now()) {
    try {
      return {
        token: await request(remembered.permissions),
        widened: isWide(remembered.permissions),
      };
    } catch {
      // What worked before no longer does (a permission was removed, say).
      // Forget it and find out afresh what the installation grants.
      resolvedScopes.delete(scope);
    }
  }

  const fallback = tokenFallback();
  const ladder: Rung[] = [
    [...required, ...optional],
    ...(optional.length > 0 ? [required] : []),
    ...(fallback === "none" ? [] : [null]),
    ...(fallback === "installation" ? (["installation"] as const) : []),
  ];
  let lastError: unknown;
  for (const [index, rung] of ladder.entries()) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: each rung is only tried when the one above it was refused
      const token = await request(rung);
      warnIfWidened(scope, rung);
      resolvedScopes.set(scope, {
        expiresAt:
          index === 0
            ? Number.POSITIVE_INFINITY
            : now() + SCOPE_DOWNGRADE_TTL_MS,
        permissions: rung,
      });
      return { token, widened: isWide(rung) };
    } catch (error) {
      lastError = error;
    }
  }
  throw new NarrowTokenError(scope, required, lastError);
};

const missingInstallationToken = (): Promise<string> =>
  Promise.reject(new Error("No installation token source is configured."));

/**
 * The token the GitHub channel itself uses: to read the thread that started
 * a run, post replies and reactions, and check a labeler's permission.
 *
 * @remarks
 * The connector's own installation token carries every permission the app
 * holds on every repository the installation covers. The channel needs far
 * less, so it is handed the `repo-triage` scope instead: issues and pull
 * requests on the factory repository, contents read-only. A webhook handler
 * that goes wrong can then do no more to GitHub than the orchestrator's own
 * `gh` writes can.
 *
 * Unlike a leased scope, this one falls back to the connector's token when
 * it cannot be narrowed, whatever `FACTORY_TOKEN_FALLBACK` says. The channel
 * is how the factory answers at all: without a token it could not even post
 * the error. The token is used by the app runtime only and never enters a
 * sandbox, and the fallback is what the channel used before, so nothing is
 * widened by it. Each fallback is logged.
 *
 * @throws When narrowing fails and no installation token source exists.
 */
export const mintChannelToken = async (
  dependencies: MintDependencies = {}
): Promise<string> => {
  try {
    return await mintScopedToken("repo-triage", dependencies);
  } catch (error) {
    const fallback =
      dependencies.installationToken ??
      (dependencies.mint ? undefined : channelInstallationToken);
    if (fallback === undefined) {
      throw error;
    }
    console.warn(
      `[factory] The GitHub channel's token could not be narrowed to the factory repository (${error instanceof Error ? error.message : String(error)}); using the connector's installation token.`
    );
    return await fallback();
  }
};

const basic = (secret: string): string =>
  `Basic ${Buffer.from(`x-access-token:${secret}`).toString("base64")}`;

const escapeRegex = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The only request paths a fetch-only lease attaches its credential to: the
 * two a `git fetch` or `git clone` of one repository makes, as a pattern
 * for the sandbox firewall.
 *
 * @remarks
 * Git's HTTP transport reads with `info/refs` and `git-upload-pack` and
 * writes with `git-receive-pack`. A lease held to these paths can fetch the
 * factory repository and nothing else, whatever the token behind it could
 * do. The optional query is allowed for a firewall that counts it as part
 * of the path.
 *
 * @param owner - The repository owner, matched literally.
 * @param repo - The repository name, matched literally.
 */
export const fetchPathFor = (owner: string, repo: string): string =>
  `^/?${escapeRegex(owner)}/${escapeRegex(repo)}(?:\\.git)?/(?:info/refs|git-upload-pack)(?:\\?.*)?$`;

/** {@link fetchPathFor} the factory repository. */
export const FETCH_PATH = fetchPathFor(factoryRepo.owner, factoryRepo.repo);

/**
 * Which hosts a lease attaches its credential to: `gh` the API hosts, `git`
 * the git hosts, `shell` both. A shell command may run either program, and
 * a signed push uses both itself.
 */
export type LeaseKind = "gh" | "git" | "shell";

/**
 * The firewall policy for one lease.
 *
 * @remarks
 * Each rule matches only a request whose `authorization` header carries this
 * lease's placeholder, then replaces the header with the real credential.
 * A request from anything else in the sandbox passes through untouched, so
 * a process that never saw the placeholder gets nothing.
 *
 * The rules are laid over the sandbox's base policy (`withBasePolicy` in
 * `egress.ts`), so what else is reachable while the lease is active is what
 * is reachable without it: the allowlist by default, or every host
 * (`"*": []`) for a deployment that opened egress.
 */
export const leasePolicy = (
  kind: LeaseKind,
  token: string,
  placeholder: string,
  options: { readonly fetchOnly?: boolean } = {}
): SandboxNetworkPolicy => {
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
  const git: SandboxNetworkRule[] = [
    {
      match: {
        headers: [
          {
            key: { exact: "authorization" },
            value: { exact: basic(placeholder) },
          },
        ],
        ...(options.fetchOnly ? { path: { regex: FETCH_PATH } } : {}),
      },
      transform: [{ headers: { authorization: basic(token) } }],
    },
  ];
  // `shell` covers both sets of hosts; `gh` and `git` only their own.
  return withBasePolicy({
    ...(kind === "git"
      ? {}
      : { "api.github.com": api, "uploads.github.com": api }),
    ...(kind === "gh" ? {} : { "codeload.github.com": git, "github.com": git }),
  });
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
export const LEASED_GIT_TIMEOUT_MS = 10 * 60 * 1000;

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
 * Redaction is exact, not pattern-based: the secrets are known here, and a
 * pattern would eat the auth code and CI logs an agent needs to read.
 *
 * @param secrets - The exact strings to replace with `[redacted]`.
 * @param keep - Which end survives when the output is too long.
 */
const clean = (
  text: string,
  secrets: readonly string[],
  keep: "head" | "tail"
): { text: string; truncated: boolean } => {
  let cleaned = text;
  for (const secret of secrets) {
    cleaned = cleaned.replaceAll(secret, "[redacted]");
  }
  if (cleaned.length <= MAX_OUTPUT_CHARACTERS) {
    return { text: cleaned, truncated: false };
  }
  return {
    text:
      keep === "tail"
        ? `[earlier output truncated]\n${cleaned.slice(-MAX_OUTPUT_CHARACTERS)}`
        : `${cleaned.slice(0, MAX_OUTPUT_CHARACTERS)}\n[output truncated]`,
    truncated: true,
  };
};

export const LEASE_RESET_ATTEMPTS = 3;

/**
 * Takes the credential off the sandbox's firewall, by putting the base
 * policy back (`basePolicy` in `egress.ts`).
 *
 * @remarks
 * A lease that is not taken off leaves its token attached until the next
 * lease on that sandbox or the token's expiry, so the reset is tried
 * {@link LEASE_RESET_ATTEMPTS} times before the failure is reported.
 */
const endLease = async (
  sandbox: Pick<LeaseSandbox, "setNetworkPolicy">
): Promise<void> => {
  let lastError: unknown;
  for (let attempt = 0; attempt < LEASE_RESET_ATTEMPTS; attempt += 1) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: a retry only follows a failure
      await sandbox.setNetworkPolicy(basePolicy());
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    "The command finished, but its GitHub credential could not be taken off the sandbox's network policy.",
    { cause: lastError }
  );
};

export interface LeaseDependencies extends MintDependencies {
  /** Makes the per-lease placeholder. Injected by tests. */
  readonly id?: () => string;
}

interface LeasedCommand {
  readonly command: string;
  readonly env: Record<string, string>;
  /**
   * Which end of oversized output survives. Most output is read from the
   * top; a log is read from the bottom, where the failure is.
   */
  readonly keep?: "head" | "tail";
  /** Omit for a command with no time limit of its own. */
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
  kind: LeaseKind,
  scope: TokenScope,
  dependencies: LeaseDependencies,
  build: (placeholder: string) => Promise<LeasedCommand> | LeasedCommand
): Promise<CliResult> =>
  serialized(sandbox.name, async () => {
    const placeholder = `factory-${(dependencies.id ?? randomUUID)()}`;
    const { token, widened } = await mintForLease(scope, dependencies);
    const leased = await build(placeholder);
    await sandbox.setNetworkPolicy(
      leasePolicy(kind, token, placeholder, {
        // A read that had to take a wider token (`FACTORY_TOKEN_FALLBACK`)
        // is held to reading at the firewall instead: the sandbox may be a
        // station's, where the placeholder can be read by whatever else is
        // running, and the token could write.
        fetchOnly: kind === "git" && scope === "repo-read" && widened,
      })
    );
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
      const keep = leased.keep ?? "head";
      const stdout = clean(String(result.stdout ?? ""), secrets, keep);
      const stderr = clean(String(result.stderr ?? ""), secrets, keep);
      return {
        exitCode: result.exitCode,
        stderr: stderr.text,
        stdout: stdout.text,
        truncated: stdout.truncated || stderr.truncated,
      };
    } finally {
      await endLease(sandbox);
    }
  });

/** What a shell command run under a lease is given. */
export interface ShellLease {
  /** Stands in for the credential inside the sandbox. */
  readonly placeholder: string;
  /** Removes the real credential from text, should it ever appear there. */
  readonly redact: (text: string) => string;
}

/**
 * Holds a read-only credential lease open while a shell command runs.
 *
 * @remarks
 * This is the lease for a `bash` command that names `gh` or `git`. The
 * command is whatever the model wrote, so the scope is fixed at `repo-read`
 * and is not a parameter: nothing run through here can change GitHub. The
 * mint is strict, so the token is never widened either.
 *
 * @param run - Runs the command. It gets the placeholder to export into the
 * command's environment, where the sandbox's `gh` and `git` wrappers pick it
 * up.
 * @throws When no read-only token can be minted (`NarrowTokenError`).
 */
export const withShellLease = <T>(
  sandbox: Pick<LeaseSandbox, "name" | "setNetworkPolicy">,
  dependencies: LeaseDependencies,
  run: (lease: ShellLease) => Promise<T>
): Promise<T> =>
  serialized(sandbox.name, async () => {
    const placeholder = `factory-${(dependencies.id ?? randomUUID)()}`;
    const token = await mintScopedToken("repo-read", dependencies, {
      strict: true,
    });
    await sandbox.setNetworkPolicy(leasePolicy("shell", token, placeholder));
    try {
      return await run({
        placeholder,
        redact: (text) =>
          text
            .replaceAll(basic(token), "[redacted]")
            .replaceAll(token, "[redacted]"),
      });
    } finally {
      await endLease(sandbox);
    }
  });

/**
 * Runs a validated `gh` invocation in the sandbox under a lease.
 *
 * @remarks
 * Comment and pull request bodies are written to files in the sandbox and
 * passed with `--body-file`, then removed, so model-written prose never sits
 * on a command line.
 *
 * @param invocation - A `parseGh` result; nothing unparsed may reach here.
 * @param scope - `repo-read` for a read, `repo-triage` for a write.
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
      keep: invocation.command === "run view" ? "tail" : "head",
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
    PATH: RUNNER_PATH,
  };
  config.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
};

/**
 * Pushes one branch to the factory repository under a `repo-push` lease.
 *
 * @param branch - A branch name that passed `validateBranch`. Callers get it
 * from `parseGitPush`, or resolve and validate the checked-out branch
 * themselves; nothing unvalidated may reach this function.
 */
export const runGitPush = (
  sandbox: LeaseSandbox,
  branch: string,
  dependencies: LeaseDependencies = {}
): Promise<CliResult> =>
  signedCommits()
    ? runSignedPush(sandbox, branch, dependencies)
    : withLease(sandbox, "git", "repo-push", dependencies, (placeholder) => ({
        command: pushCommandLine(branch),
        env: gitEnvironment(placeholder),
        timeoutMs: GIT_TIMEOUT_MS,
      }));

/**
 * Pushes one branch as commits GitHub signs (`push-signed.ts`), for a
 * deployment that set `FACTORY_SIGNED_COMMITS=1`.
 *
 * @remarks
 * Same scope as a plain push, `repo-push`, and the same git configuration.
 * The differences are the ones the replay needs: the lease covers the API
 * hosts as well as the git hosts, within the same time limit as a plain
 * push, the script is written into the sandbox for this one command and
 * removed after it, and `PATH` is left as the sandbox has it so `node`
 * resolves, with git's own `PATH` handed to the script, which runs git by
 * absolute path.
 *
 * @param branch - A branch name that passed `validateBranch`.
 */
const runSignedPush = (
  sandbox: LeaseSandbox,
  branch: string,
  dependencies: LeaseDependencies
): Promise<CliResult> =>
  withLease(
    sandbox,
    "shell",
    "repo-push",
    dependencies,
    async (placeholder) => {
      const script = `/tmp/${placeholder}-push-signed.cjs`;
      await sandbox.writeTextFile({
        content: PUSH_SIGNED_SCRIPT,
        path: script,
      });
      const { PATH: _gitPath, ...git } = gitEnvironment(placeholder);
      return {
        command: signedPushCommandLine(script),
        env: { ...git, ...signedPushEnvironment(branch, placeholder) },
        timeoutMs: SIGNED_PUSH_TIMEOUT_MS,
      };
    }
  );

/**
 * Runs a fetch the runtime rendered itself (`parseGitFetch`) under a
 * `repo-read` lease.
 *
 * @remarks
 * Only for a deployment that cannot issue a read-only token, where a fetch
 * can't run in the agent's shell. Unlike the shell's lease, this one follows
 * `FACTORY_TOKEN_FALLBACK`. The command is the runtime's own (fixed remote,
 * plain branch names, hooks off), but it runs in a station's sandbox, where
 * the placeholder can be read by anything else running there. So a lease
 * that took a wider token attaches it only to the requests a fetch of the
 * factory repository makes ({@link FETCH_PATH}).
 *
 * @param commandLine - The `commandLine` of a successful `parseGitFetch`.
 */
export const runGitFetch = (
  sandbox: LeaseSandbox,
  commandLine: string,
  dependencies: LeaseDependencies = {}
): Promise<CliResult> =>
  withLease(sandbox, "git", "repo-read", dependencies, (placeholder) => ({
    command: commandLine,
    env: gitEnvironment(placeholder),
    timeoutMs: GIT_TIMEOUT_MS,
  }));

/**
 * Runs a git command line the factory wrote itself under a read-only
 * lease. Used for a station's initial clone.
 *
 * @param commandLine - A fixed command, such as `cloneCommand(REMOTE_URL)`.
 * Nothing model-written may reach this function, since it does no
 * validation of its own.
 */
export const runLeasedGitCommand = (
  sandbox: LeaseSandbox,
  commandLine: string,
  dependencies: LeaseDependencies = {}
): Promise<CliResult> =>
  withLease(sandbox, "git", "repo-read", dependencies, (placeholder) => ({
    command: commandLine,
    env: gitEnvironment(placeholder),
    // Generous, for a first clone of a large repository, but not forever:
    // a stalled fetch would otherwise hold the lease and the sandbox's queue.
    timeoutMs: LEASED_GIT_TIMEOUT_MS,
  }));
