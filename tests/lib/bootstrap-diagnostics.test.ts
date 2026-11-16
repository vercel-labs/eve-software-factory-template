import { describe, expect, test } from "vitest";
import {
  appAccessMessage,
  describeCloneFailure,
  missingRepoMessage,
  safeErrorMessage,
  sanitizeCommandOutput,
} from "#lib/github/bootstrap-diagnostics.js";

const REPO = "acme/widgets";

// Credential-shaped fixtures. None is a real credential.
const INSTALLATION_TOKEN = `ghs_${"A1b2C3d4".repeat(4)}`;
const PERSONAL_TOKEN = `ghp_${"Z9y8X7w6".repeat(4)}`;
const FINE_GRAINED_TOKEN = `github_pat_${"11ABCDEFG0".repeat(2)}_${"q".repeat(30)}`;
const OPAQUE_TOKEN = `v1.${"0a1b2c3d".repeat(5)}`;
const BASIC_VALUE = btoa(`x-access-token:${INSTALLATION_TOKEN}`);
const JWT = "eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiIxMjM0NSJ9.c2lnbmF0dXJlLWJ5dGVz";

const REDACTED = "[redacted]";

describe("sanitizeCommandOutput", () => {
  test.each([
    ["an installation token (ghs_)", INSTALLATION_TOKEN],
    ["a personal access token (ghp_)", PERSONAL_TOKEN],
    ["an OAuth token (gho_)", `gho_${"k".repeat(36)}`],
    ["a user-to-server token (ghu_)", `ghu_${"m".repeat(36)}`],
    ["a refresh token (ghr_)", `ghr_${"n".repeat(36)}`],
    ["a fine-grained token (github_pat_)", FINE_GRAINED_TOKEN],
  ])("redacts %s wherever it appears", (_case, token) => {
    const output = sanitizeCommandOutput(
      `fatal: could not use token ${token} for 'https://github.com/${REPO}.git'\nGH_TOKEN=${token}\n"${token}"`
    );

    expect(output).not.toContain(token);
    expect(output).toBe(
      `fatal: could not use token ${REDACTED} for 'https://github.com/${REPO}.git'\nGH_TOKEN=${REDACTED}\n"${REDACTED}"`
    );
  });

  test.each([
    ["a GitHub token", INSTALLATION_TOKEN],
    ["an opaque token", OPAQUE_TOKEN],
  ])(
    "redacts %s embedded in a remote URL as x-access-token",
    (_case, token) => {
      const output = sanitizeCommandOutput(
        `fatal: unable to access 'https://x-access-token:${token}@github.com/${REPO}.git/': The requested URL returned error: 403`
      );

      expect(output).not.toContain(token);
      expect(output).toContain(REDACTED);
      expect(output).toContain(`@github.com/${REPO}.git/`);
      expect(output).toContain("The requested URL returned error: 403");
    }
  );

  test("redacts an x-access-token credential whatever the case of the username", () => {
    const output = sanitizeCommandOutput(
      `https://X-Access-Token:${OPAQUE_TOKEN}@github.com/${REPO}.git`
    );

    expect(output).not.toContain(OPAQUE_TOKEN);
  });

  // Outside a URL only the x-access-token rule applies, and the token is
  // opaque, so no other rule can redact it in that rule's place.
  test.each(["x-access-token", "X-Access-Token", "X-ACCESS-TOKEN"])(
    "redacts a %s credential that is not part of a URL",
    (username) => {
      expect(
        sanitizeCommandOutput(
          `credential ${username}:${OPAQUE_TOKEN} was rejected`
        )
      ).toBe(`credential ${REDACTED} was rejected`);
    }
  );

  // Any other username: only the rule for credentials in a URL applies.
  test.each([
    ["https", "oauth2"],
    ["https", "octocat"],
    ["http", "git"],
    ["HTTPS", "oauth2"],
  ])(
    "redacts an opaque credential in an %s URL whose username is %s",
    (scheme, username) => {
      expect(
        sanitizeCommandOutput(
          `fatal: unable to access '${scheme}://${username}:${OPAQUE_TOKEN}@github.com/${REPO}.git/': 403`
        )
      ).toBe(
        `fatal: unable to access '${scheme}://${REDACTED}@github.com/${REPO}.git/': 403`
      );
    }
  );

  test.each([
    ["Authorization: token", `Authorization: token ${OPAQUE_TOKEN}`],
    ["Authorization: Bearer", `Authorization: Bearer ${OPAQUE_TOKEN}`],
    ["Authorization: Basic", `Authorization: Basic ${BASIC_VALUE}`],
    [
      "a lowercase authorization header",
      `authorization: bearer ${OPAQUE_TOKEN}`,
    ],
    [
      "an uppercase AUTHORIZATION header",
      `AUTHORIZATION: basic ${BASIC_VALUE}`,
    ],
    ["Proxy-Authorization", `Proxy-Authorization: Basic ${BASIC_VALUE}`],
    ["a curl trace header", `> Authorization: Bearer ${OPAQUE_TOKEN}`],
    [
      "a git extraheader setting",
      `http.extraheader=Authorization: Basic ${BASIC_VALUE}`,
    ],
    ["an authorization assignment", `authorization=${OPAQUE_TOKEN}`],
    [
      "a header with spaces before the colon",
      `Authorization  :   ${OPAQUE_TOKEN}`,
    ],
  ])("redacts the value of %s", (_case, line) => {
    const output = sanitizeCommandOutput(`before\n${line}\nafter`);

    expect(output).not.toContain(OPAQUE_TOKEN);
    expect(output).not.toContain(BASIC_VALUE);
    expect(output).toContain(REDACTED);
    expect(output.startsWith("before\n")).toBe(true);
    expect(output.endsWith("\nafter")).toBe(true);
  });

  test("redacts an authorization header up to a CRLF line ending, and no further", () => {
    const output = sanitizeCommandOutput(
      `Authorization: Bearer ${OPAQUE_TOKEN}\r\nContent-Type: application/json\r\n`
    );

    expect(output).toBe(`${REDACTED}\r\nContent-Type: application/json\r\n`);
  });

  test.each([
    ["Bearer", `Bearer ${JWT}`, JWT],
    ["bearer in lower case", `bearer ${OPAQUE_TOKEN}`, OPAQUE_TOKEN],
    ["BEARER in upper case", `BEARER ${OPAQUE_TOKEN}`, OPAQUE_TOKEN],
    ["Basic", `Basic ${BASIC_VALUE}`, BASIC_VALUE],
    ["basic in lower case", `basic ${BASIC_VALUE}`, BASIC_VALUE],
  ])(
    "redacts a bare %s credential outside any header",
    (_case, credential, secret) => {
      const output = sanitizeCommandOutput(`sent ${credential} to the remote`);

      expect(output).not.toContain(secret);
      expect(output).toBe(`sent ${REDACTED} to the remote`);
    }
  );

  test("redacts every credential in output that carries several", () => {
    const output = sanitizeCommandOutput(
      [
        `clone https://x-access-token:${INSTALLATION_TOKEN}@github.com/${REPO}.git`,
        `retry with ${PERSONAL_TOKEN} and ${FINE_GRAINED_TOKEN}`,
        `Authorization: Basic ${BASIC_VALUE}`,
        `again ${INSTALLATION_TOKEN} ${INSTALLATION_TOKEN}`,
      ].join("\n")
    );

    for (const secret of [
      INSTALLATION_TOKEN,
      PERSONAL_TOKEN,
      FINE_GRAINED_TOKEN,
      BASIC_VALUE,
    ]) {
      expect(output).not.toContain(secret);
    }
    expect(output.split(REDACTED).length - 1).toBeGreaterThanOrEqual(6);
  });

  test("redacts the same way on every call", () => {
    const text = `token ${INSTALLATION_TOKEN} and Bearer ${OPAQUE_TOKEN}`;
    const first = sanitizeCommandOutput(text);

    expect(sanitizeCommandOutput(text)).toBe(first);
    expect(sanitizeCommandOutput(text)).toBe(first);
    expect(first).toBe(`token ${REDACTED} and ${REDACTED}`);
  });

  test("leaves already-sanitized output unchanged", () => {
    const once = sanitizeCommandOutput(
      `https://x-access-token:${INSTALLATION_TOKEN}@github.com/${REPO}.git`
    );

    expect(sanitizeCommandOutput(once)).toBe(once);
  });

  test.each([
    "Cloning into 'widgets'...",
    "remote: Repository not found.",
    `fatal: repository 'https://github.com/${REPO}.git/' not found`,
    "error: pathspec 'ghs' did not match any file(s) known to git",
    "The basic idea is to bear with the bearer of bad news.",
    "commit 9fceb02d0ae598e95dc970b74767f19372d61af8",
    "",
  ])("leaves ordinary output %j unchanged", (text) => {
    expect(sanitizeCommandOutput(text)).toBe(text);
  });
});

describe("appAccessMessage and missingRepoMessage", () => {
  test("the app-access message names the repository and the fix", () => {
    expect(appAccessMessage(REPO)).toContain(REPO);
    expect(appAccessMessage(REPO)).toMatch(/install/i);
  });

  test("the missing-repository message names the repository, FACTORY_REPO, and both fixes", () => {
    const message = missingRepoMessage(REPO);

    expect(message).toContain(REPO);
    expect(message).toContain("FACTORY_REPO");
    expect(message).toMatch(/not found/);
    expect(message).toMatch(/private repository/);
  });

  test("the two messages are different, so the caller can tell the cases apart", () => {
    expect(appAccessMessage(REPO)).not.toBe(missingRepoMessage(REPO));
  });
});

describe("describeCloneFailure", () => {
  test.each([
    [
      "git's not-found pair",
      `remote: Repository not found.\nfatal: repository 'https://github.com/${REPO}.git/' not found`,
    ],
    ["a not-found remote line alone", "remote: Repository not found."],
    [
      "a not-found fatal line alone",
      `fatal: repository 'https://github.com/${REPO}.git/' not found`,
    ],
    [
      "an unreadable remote",
      "fatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.",
    ],
    ["not-found in another case", "REMOTE: REPOSITORY NOT FOUND."],
    [
      "a 404 that names the repository",
      `error: Not Found: the repository ${REPO} does not exist`,
    ],
  ])("explains %s as a missing or invisible repository", (_case, detail) => {
    expect(describeCloneFailure(REPO, detail)).toBe(missingRepoMessage(REPO));
  });

  test.each([
    [
      "a failed authentication",
      `fatal: Authentication failed for 'https://github.com/${REPO}.git/'`,
    ],
    [
      "an HTTP 403",
      `fatal: unable to access 'https://github.com/${REPO}.git/': The requested URL returned error: 403`,
    ],
    ["a forbidden response", "remote: HTTP 403 Forbidden"],
    ["a denied permission", "remote: Permission denied to installation."],
    ["denied access", "remote: Access denied"],
    ["invalid credentials", "remote: Invalid username or credentials."],
    ["an authorization failure", "remote: Authorization failed."],
  ])("explains %s as the app lacking access", (_case, detail) => {
    expect(describeCloneFailure(REPO, detail)).toBe(appAccessMessage(REPO));
  });

  test("prefers the not-found explanation when the output shows both kinds of evidence", () => {
    const detail = `fatal: Authentication failed for 'https://github.com/${REPO}.git/'\nfatal: Could not read from remote repository.`;

    expect(describeCloneFailure(REPO, detail)).toBe(missingRepoMessage(REPO));
  });

  test.each([
    [
      "a network failure",
      "fatal: unable to access 'https://github.com/': Could not resolve host: github.com",
    ],
    ["a full disk", "fatal: write error: No space left on device"],
    [
      "an early hang-up",
      "error: RPC failed; curl 92 HTTP/2 stream 5 was not closed cleanly\nfatal: early EOF",
    ],
    [
      "a not-found that is not about the repository",
      "bash: git: command not found",
    ],
  ])("quotes the output for %s, naming the repository", (_case, detail) => {
    const message = describeCloneFailure(REPO, detail);

    expect(message).toContain(`Failed to clone ${REPO}`);
    expect(message).toContain(detail.trim());
    expect(message).not.toBe(missingRepoMessage(REPO));
    expect(message).not.toBe(appAccessMessage(REPO));
  });

  test("trims surrounding whitespace from the output it quotes", () => {
    const message = describeCloneFailure(REPO, "\n\n  fatal: early EOF  \n\n");

    expect(message.endsWith("fatal: early EOF")).toBe(true);
  });

  test("still names the repository when there is no output at all", () => {
    expect(describeCloneFailure(REPO, "")).toContain(`Failed to clone ${REPO}`);
  });

  test("bounds how much output it quotes", () => {
    const message = describeCloneFailure(
      REPO,
      "fatal: early EOF ".repeat(5000)
    );

    expect(message).toContain(`Failed to clone ${REPO}`);
    expect(message.length).toBeLessThan(2500);
  });

  test.each([
    [
      "a generic failure",
      (token: string) =>
        `fatal: unable to access 'https://x-access-token:${token}@github.com/${REPO}.git/': Could not resolve host`,
    ],
    [
      "a not-found failure",
      (token: string) =>
        `fatal: repository 'https://x-access-token:${token}@github.com/${REPO}.git/' not found`,
    ],
    [
      "an access failure",
      (token: string) =>
        `fatal: Authentication failed for 'https://x-access-token:${token}@github.com/${REPO}.git/'`,
    ],
    [
      "a header dump",
      (token: string) => `> Authorization: Bearer ${token}\nfatal: early EOF`,
    ],
    [
      "a bare token",
      (token: string) => `GH_TOKEN=${token} git clone failed with exit 128`,
    ],
  ])("never repeats a token that appears in %s", (_case, detail) => {
    for (const token of [
      INSTALLATION_TOKEN,
      PERSONAL_TOKEN,
      FINE_GRAINED_TOKEN,
    ]) {
      const message = describeCloneFailure(REPO, detail(token));

      expect(message).not.toContain(token);
      expect(message).not.toContain(token.slice(0, 16));
      expect(message).toContain(REPO);
    }
  });

  test("still classifies a not-found failure whose URL carried a token", () => {
    const detail = `fatal: repository 'https://x-access-token:${INSTALLATION_TOKEN}@github.com/${REPO}.git/' not found`;

    expect(describeCloneFailure(REPO, detail)).toBe(missingRepoMessage(REPO));
  });

  test("does not leak any part of a token that straddles the quoting limit", () => {
    for (const padding of [1950, 1975, 1990, 1996, 1999, 2000]) {
      const detail = `${"x".repeat(padding)} ${INSTALLATION_TOKEN} trailing output`;
      const message = describeCloneFailure(REPO, detail);

      expect(message, `padding ${padding}`).not.toContain(
        INSTALLATION_TOKEN.slice(0, 8)
      );
      expect(message, `padding ${padding}`).not.toContain("A1b2C3d4");
    }
  });
});

describe("safeErrorMessage", () => {
  test("returns an error's message with credentials redacted", () => {
    const error = new Error(
      `clone of https://x-access-token:${INSTALLATION_TOKEN}@github.com/${REPO}.git failed`
    );

    expect(safeErrorMessage(error)).not.toContain(INSTALLATION_TOKEN);
    expect(safeErrorMessage(error)).toContain(`@github.com/${REPO}.git failed`);
  });

  test("returns a plain error's message unchanged", () => {
    expect(safeErrorMessage(new TypeError("fetch failed"))).toBe(
      "fetch failed"
    );
  });

  test.each([
    ["a string", `boom ${PERSONAL_TOKEN}`, `boom ${REDACTED}`],
    ["a number", 128, "128"],
    ["null", null, "null"],
    ["undefined", undefined, "undefined"],
    ["an object", { code: 128 }, "[object Object]"],
  ])("describes a thrown value that is %s", (_case, thrown, message) => {
    expect(safeErrorMessage(thrown)).toBe(message);
  });
});
