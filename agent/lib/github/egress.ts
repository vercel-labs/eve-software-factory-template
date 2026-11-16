import type { SandboxNetworkPolicy, SandboxNetworkRule } from "eve/sandbox";

/**
 * Which hosts a factory sandbox can reach.
 *
 * @remarks
 * On a private repository, open egress means a run steered by the text it
 * reads (an issue body, a dependency, a file in the repo) can send the
 * source anywhere, and fetch anything to run. The credential leases keep a
 * GitHub token from leaving a sandbox; this keeps the repository's contents
 * from leaving it too.
 *
 * So every factory sandbox opens with an allowlist: GitHub, and the public
 * package registries a setup command or a test run needs. A request to any
 * other host is refused at the sandbox firewall. The list is the base
 * policy: a credential lease is laid over it for one command
 * (`leasePolicy` in `lease.ts`) and the sandbox returns to it when the
 * command ends.
 *
 * Two settings adjust it, both read when a sandbox opens or a lease starts:
 *
 * - {@link ALLOWED_DOMAINS_ENV} adds hosts: a private registry, an internal
 *   API the tests call, a download mirror.
 * - {@link EGRESS_ENV} set to `open` removes the allowlist: every host is
 *   reachable.
 *
 * Hosts are matched exactly as written: every host is listed by its full
 * name and no wildcard is accepted, because an entry that matched more than
 * it says would be a hole nobody chose.
 */

/** Set to `open` to let factory sandboxes reach any host. */
export const EGRESS_ENV = "FACTORY_SANDBOX_EGRESS";

/** Comma-separated hostnames to allow on top of the defaults. */
export const ALLOWED_DOMAINS_ENV = "FACTORY_SANDBOX_ALLOWED_DOMAINS";

export type EgressMode = "open" | "restricted";

/**
 * The egress mode, from {@link EGRESS_ENV}. Anything but `open` is
 * `restricted`, so a typo leaves the allowlist on.
 */
export const egressMode = (): EgressMode =>
  process.env[EGRESS_ENV]?.trim().toLowerCase() === "open"
    ? "open"
    : "restricted";

/**
 * GitHub's own hosts: the web and git endpoint, the API, archive and release
 * downloads, raw file contents, uploads, and the host `gh run view --log`
 * reads Actions logs from, which the CI-fix loop depends on.
 *
 * @remarks
 * `gh run view <id> --log-failed` downloads the run's log archive: the API
 * redirects it to `results-receiver.actions.githubusercontent.com`, which
 * serves the archive itself (traced with gh 2.103.3). The per-job log
 * endpoint (`actions/jobs/<id>/logs`) is different: it redirects to a
 * numbered storage host (`productionresultssa<N>.blob.core.windows.net`),
 * which an exact-host list cannot name, so it is not reachable here. The
 * factory never asks for it; a deployment that needs it opens egress.
 */
export const GITHUB_HOSTS: readonly string[] = [
  "github.com",
  "api.github.com",
  "codeload.github.com",
  "uploads.github.com",
  "objects.githubusercontent.com",
  "raw.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "results-receiver.actions.githubusercontent.com",
];

/**
 * Public package registries and toolchain downloads, by ecosystem. These
 * are what `FACTORY_SETUP_COMMAND` and a repository's build and tests reach
 * for in the common case; anything else is added with
 * {@link ALLOWED_DOMAINS_ENV}.
 */
export const REGISTRY_HOSTS: readonly string[] = [
  // JavaScript: npm, pnpm, Yarn, Bun, JSR, and Node.js downloads (corepack,
  // node-gyp headers).
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "npm.jsr.io",
  "jsr.io",
  "nodejs.org",
  // Python.
  "pypi.org",
  "files.pythonhosted.org",
  // Rust.
  "crates.io",
  "index.crates.io",
  "static.crates.io",
  "static.rust-lang.org",
  // Go.
  "proxy.golang.org",
  "sum.golang.org",
  // Ruby.
  "rubygems.org",
  "index.rubygems.org",
  // JVM.
  "repo.maven.apache.org",
  "repo1.maven.org",
  "plugins.gradle.org",
  "services.gradle.org",
  // The image's own package archive, for a setup command that uses apt.
  "archive.ubuntu.com",
  "security.ubuntu.com",
  "ports.ubuntu.com",
];

/** Most hostnames a deployer may add; a policy has to stay reviewable. */
export const MAX_EXTRA_DOMAINS = 64;

/**
 * A plain DNS hostname: labels of letters, digits, and inner hyphens, at
 * least two of them, no wildcard, no scheme, no port, no path.
 */
const HOSTNAME =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The hosts the deployer added with {@link ALLOWED_DOMAINS_ENV}.
 *
 * @throws When an entry is not a plain hostname, or there are too many. A
 * sandbox then fails to open with a message that names the entry, instead
 * of opening with a policy that quietly dropped it or allows more than was
 * meant.
 */
export const extraDomains = (): readonly string[] => {
  const entries = (process.env[ALLOWED_DOMAINS_ENV] ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== "");
  if (entries.length > MAX_EXTRA_DOMAINS) {
    throw new Error(
      `${ALLOWED_DOMAINS_ENV} lists ${entries.length} hosts; the limit is ${MAX_EXTRA_DOMAINS}. Set ${EGRESS_ENV}=open if the sandbox has to reach anything.`
    );
  }
  for (const entry of entries) {
    if (!HOSTNAME.test(entry)) {
      throw new Error(
        `${ALLOWED_DOMAINS_ENV} entry "${entry.slice(0, 80)}" is not a hostname. List full hostnames separated by commas (registry.example.com), with no scheme, port, path, or wildcard.`
      );
    }
  }
  return [...new Set(entries)];
};

/** Every host a restricted sandbox can reach, defaults first. */
export const allowedHosts = (): readonly string[] => [
  ...new Set([...GITHUB_HOSTS, ...REGISTRY_HOSTS, ...extraDomains()]),
];

/**
 * The policy a factory sandbox opens with, and returns to after a lease.
 *
 * @returns `"allow-all"` in open mode; otherwise the allowlist, each host
 * with no rules of its own.
 */
export const basePolicy = (): SandboxNetworkPolicy =>
  egressMode() === "open"
    ? "allow-all"
    : { allow: Object.fromEntries(allowedHosts().map((host) => [host, []])) };

/**
 * Lays one command's credential rules over the base policy.
 *
 * @remarks
 * A lease's hosts are always reachable while it is active, whether or not
 * the allowlist names them: they are GitHub's, and the command the lease is
 * for cannot run without them.
 *
 * @param rules - The rules a lease attaches, by host.
 * @returns In open mode, the rules plus `"*": []`, which keeps every other
 * host reachable. In restricted mode, the allowlist with the lease's rules
 * on its own hosts, and no `"*"`.
 */
export const withBasePolicy = (
  rules: Readonly<Record<string, readonly SandboxNetworkRule[]>>
): SandboxNetworkPolicy => {
  const base = basePolicy();
  return {
    allow: {
      ...(typeof base === "object" && !Array.isArray(base.allow)
        ? base.allow
        : { "*": [] }),
      ...rules,
    },
  };
};

/** What an agent is told when its sandbox cannot reach every host. */
export const EGRESS_NOTE =
  "This sandbox reaches GitHub and the public package registries only. A request to any other host fails; if the work needs one, say which host in your structured output instead of retrying.";

/** What a failed setup command is followed by, in restricted mode. */
export const EGRESS_SETUP_HINT = `If this is a network failure: the sandbox reaches GitHub and the public package registries only. Add the host it needs to ${ALLOWED_DOMAINS_ENV} (comma-separated hostnames), or set ${EGRESS_ENV}=open to allow every host.`;
