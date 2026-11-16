# eve Software Factory Template

[![Agent Stack](https://img.shields.io/badge/Agent%20Stack-000?style=flat-square&logo=vercel&logoColor=FFF&labelColor=000&color=000)](https://vercel.com/kb/agent-stack)
[![MIT License](https://img.shields.io/badge/License-MIT-000?style=flat-square&logo=opensourceinitiative&logoColor=white&labelColor=000&color=000)](LICENSE)

Meet **Foreman**, an eve software factory that puts AI agents on every stage of the development loop and keeps people on the judgment calls.

Foreman takes tasks from GitHub, Linear, or a plain HTTP request, triages each one, moves it through its stations, and delivers a reviewed draft pull request on your repository. You review, mark ready, and merge.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?demo-title=eve+Software+Factory&demo-description=Software+factory+built+on+eve%3A+AI+agents+work+each+stage+of+the+development+loop%2C+and+people+make+the+judgment+calls.&project-name=eve-software-factory&repository-name=eve-software-factory-template&repository-url=https%3A%2F%2Fgithub.com%2Fvercel-labs%2Feve-software-factory-template&env=FACTORY_REPO%2CFACTORY_LABEL&envDefaults=%7B%22FACTORY_LABEL%22%3A%22factory%22%7D&envDescription=FACTORY_REPO+is+the+owner%2Frepo+the+factory+works+on.+FACTORY_LABEL+is+the+issue+label+that+hands+an+issue+to+the+factory%3B+the+default+label+is+fine.&connect=%5B%7B%22type%22%3A%22github%22%2C%22env%22%3A%22GITHUB_CONNECTOR%22%2C%22triggers%22%3Atrue%2C%22triggerPath%22%3A%22%2Feve%2Fv1%2Fgithub%22%7D%2C%7B%22type%22%3A%22linear%22%2C%22env%22%3A%22LINEAR_CONNECTOR%22%2C%22triggers%22%3Atrue%2C%22triggerPath%22%3A%22%2Feve%2Fv1%2Flinear%22%7D%5D&stores=%5B%7B%22type%22%3A%22blob%22%2C%22access%22%3A%22private%22%7D%5D&demo-image=%2F%2Fimages.ctfassets.net%2Fe5382hct74si%2F45PVqbeL5egwsqBRpGt6SQ%2F99e9f270dc22e07f499236af3a11a190%2Fimage.png&redirect-url=https%3A%2F%2Fask-foreman.dev%2Fwelcome)

## How it works

- **Triage** sorts the task in one fast step: type, priority, complexity, labels from your repository's own set, and whether an existing issue already covers it. When the task is too thin to build, the **Classifier** writes the questions and Foreman asks the requester instead of building the wrong thing.
- **Researcher** steps in only when the task turns on an outside fact, and hands back cited findings.
- **Analyst** turns the task into a plan with acceptance criteria, working from a live checkout of your repository.
- **Implementer** executes the plan in its own sandbox, verifies with your repo's own checks, and pushes a branch.
- **Reviewer** independently judges everything against the real diff, with evidence for each verdict.

Each station is its own agent with its own instructions, sandbox, and tools. The Reviewer sees only the pushed branch, never the Implementer's reasoning. Between runs, Foreman keeps a **factory brain**: notes about your repository that every run starts from. See [the pipeline](https://ask-foreman.dev/docs/pipeline) and [factory memory](https://ask-foreman.dev/docs/memory) for the full picture.

Foreman and its stations work on GitHub with the real `git` and `gh`. Foreman types `gh` commands, and there is no shell behind them on any run: the factory checks each command against its allowlist and against who is asking, then runs it itself. The stations have a shell of their own, and anything a shell runs gets a credential that only reads. No token is ever inside a sandbox: a credential is attached for one command at a time and scoped to your one repository.

- Every command Foreman issues, reads included, is a whole command: one `gh` command, or up to 12 joined with `&&`, with every argument written out and no pipes, variables, or other programs. `--json` and `--jq` shape the output, and long text goes through `--body "$(cat <<'EOF' ... EOF)"`. Only Foreman changes issues and pull requests.
- On a station, reading works anywhere in a command, pipes included: `gh issue view`, `gh pr diff`, `git fetch`. `gh` only reads there.
- `git push origin <branch>` must be the whole command too. Only the Implementer can push, and only to branches under the factory's prefix.

## How work arrives

- **Label an issue `factory`.** The pipeline runs on its own, posts progress as stations complete, and ends with a draft PR linked to the issue.
- **@mention it on an issue or PR.** Mentions from repo owners, members, and collaborators start an interactive session.
- **Delegate in Linear.** Linear Agent Sessions run the same pipeline and report progress back in Linear.
- **POST a ticket.** Any system that can send JSON can hand Foreman a task over HTTP and poll for the result. See [Submit work over HTTP](#submit-work-over-http).
- **The dev TUI.** Hand it a task locally. Labels, comments, and other writes to GitHub wait for your approval.
- **Red CI on a factory PR.** Foreman diagnoses the failure and, when the code is the cause, pushes a fix to its own branches, never yours. A flaky test or a broken runner gets a comment instead of a fix. When the failing checks' logs can't be read, Foreman says the cause is unknown and asks a person to look.
- **Someone opens a pull request.** Foreman posts one orienting comment for reviewers: a summary, not a review. That run can read the pull request and comment on it, and nothing else: no labels, no stations, no branch.

## Deploy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?demo-title=eve+Software+Factory&demo-description=Software+factory+built+on+eve%3A+AI+agents+work+each+stage+of+the+development+loop%2C+and+people+make+the+judgment+calls.&project-name=eve-software-factory&repository-name=eve-software-factory-template&repository-url=https%3A%2F%2Fgithub.com%2Fvercel-labs%2Feve-software-factory-template&env=FACTORY_REPO%2CFACTORY_LABEL&envDefaults=%7B%22FACTORY_LABEL%22%3A%22factory%22%7D&envDescription=FACTORY_REPO+is+the+owner%2Frepo+the+factory+works+on.+FACTORY_LABEL+is+the+issue+label+that+hands+an+issue+to+the+factory%3B+the+default+label+is+fine.&connect=%5B%7B%22type%22%3A%22github%22%2C%22env%22%3A%22GITHUB_CONNECTOR%22%2C%22triggers%22%3Atrue%2C%22triggerPath%22%3A%22%2Feve%2Fv1%2Fgithub%22%7D%2C%7B%22type%22%3A%22linear%22%2C%22env%22%3A%22LINEAR_CONNECTOR%22%2C%22triggers%22%3Atrue%2C%22triggerPath%22%3A%22%2Feve%2Fv1%2Flinear%22%7D%5D&stores=%5B%7B%22type%22%3A%22blob%22%2C%22access%22%3A%22private%22%7D%5D&demo-image=%2F%2Fimages.ctfassets.net%2Fe5382hct74si%2F45PVqbeL5egwsqBRpGt6SQ%2F99e9f270dc22e07f499236af3a11a190%2Fimage.png&redirect-url=https%3A%2F%2Fask-foreman.dev%2Fwelcome)

The Vercel deploy flow sets up the basics: the **GitHub** connector, **Linear** connector, a private **Vercel Blob** store, and a prompt for the `FACTORY_REPO` and `FACTORY_LABEL` environment variables.

After the first deploy, finish the setup from the linked project (`vercel link`, as in [Local development](#local-development)):

1. Run `eve integration setup file-memory`, then redeploy with `eve deploy`. This provisions the private Blob store that holds Foreman's memory (user preferences and the factory brain) and sets `EVE_MEMORY_BLOB_STORE_ID` for you.
2. Check the GitHub App's permissions: read and write on contents, issues, and pull requests, plus read on Actions, Checks, and Commit statuses so Foreman can diagnose red CI. Each command asks for a token narrowed to what it needs, and by default a command fails when GitHub refuses that token; the error names the permissions to check (see `FACTORY_TOKEN_FALLBACK` below).
3. Optional: set `FACTORY_INTAKE_TOKEN` to a random secret of at least 32 characters if you want to submit work over HTTP from outside Vercel.
4. Protect your default branch on GitHub (branch protection or a ruleset that requires pull requests). This is required, not optional. Foreman pushes only to branches under `FACTORY_BRANCH_PREFIX` (default `factory/`) and refuses `main` and `master` whatever the prefix is, but that rule lives in Foreman's own code. It is a second layer, not a replacement: branch protection is what holds on GitHub's side, whatever code runs in a sandbox. That matters because a push runs in the same sandbox as the Implementer's shell, so a run taken over by what it reads could use the push credential on any branch GitHub leaves open.

Two things must line up before Foreman can do any real work. `FACTORY_REPO` must name a real repository in `owner/repo` format, and the GitHub App behind the connector you select must be installed with access to that repository. A station's sandbox clones `FACTORY_REPO` on its first session, not at deploy time, so a repository the app cannot reach surfaces as a `Cannot access <owner/repo>` error on the first task you hand it, not the deploy itself; install the app on the repository (or fix the value), then try again.

Configuration (see `.env.example`):

| Variable | Required | Default | What it does |
| --- | --- | --- | --- |
| `FACTORY_REPO` | Yes | none | An existing GitHub repository in `owner/repo` format; the selected GitHub App must have access to it (a station's first session fails otherwise) |
| `FACTORY_SETUP_COMMAND` | No | none | Runs once per session inside the station sandbox checkout (e.g. `pnpm install`), so the station starts with dependencies already installed. It runs with no GitHub credential, with install scripts off, and with network access to GitHub and the public package registries only (see `FACTORY_SANDBOX_EGRESS` and `FACTORY_ALLOW_INSTALL_SCRIPTS` below) |
| `FACTORY_LABEL` | No | `factory` | The issue label that hands an issue to the factory |
| `FACTORY_BRANCH_PREFIX` | No | `factory/` | Prefix of the factory's own branches. They are the only branches the implementer can push to and the only ones automated CI fixes touch; `main` and `master` are refused whatever the prefix is |
| `FACTORY_BOT_NAME` | No | the GitHub App's slug | The `@mention` name, resolved from the connector automatically when unset |
| `FACTORY_INTAKE_TOKEN` | No | none | Shared secret (32 characters or more) for the HTTP intake API. Unset, only callers with a Vercel OIDC token for the project can submit |
| `FACTORY_INTAKE_CALLBACK_HOSTS` | No | none | Comma-separated hosts (`host` or `host:port`, exact match) a ticket's `callbackUrl` may point at |
| `FACTORY_INTAKE_CALLBACK_SECRET` | No | none | Signs status callbacks (HMAC-SHA256 in `x-factory-signature`). Without it no callbacks are sent, and a ticket that carries a `callbackUrl` is refused with `callback_not_configured` |
| `FACTORY_TOKEN_FALLBACK` | No | `none` | What happens when GitHub refuses a narrowed, per-command token. Unset or `none` fails closed: the command fails with a message naming the permissions to check. `repository` also allows a token with every permission the app holds, still limited to `FACTORY_REPO`. `installation` allows that, then the connector's plain installation token (every permission, every repository the installation covers). Each use of a wider token logs a warning. A command a station runs in its shell never gets a wider token: when no read-only token can be issued, a station cannot use `gh` at all, and reaches GitHub only through `git fetch origin <branch>` as a whole command, which the firewall holds to fetching `FACTORY_REPO` |
| `FACTORY_ALLOW_WORKFLOW_CHANGES` | No | off | Set to `1` to add Workflows write to the implementer's push token. Without it GitHub rejects a push that changes `.github/workflows` |
| `FACTORY_SANDBOX_EGRESS` | No | restricted | Unset, the sandboxes Foreman defines (the orchestrator's and the Analyst's, Implementer's, and Reviewer's, which are the ones that hold your code) reach GitHub and the public package registries (npm, PyPI, crates.io, Go, RubyGems, Maven, Gradle, and the image's apt archive) and nothing else, so a run cannot send your code to an arbitrary host. The Classifier and the Researcher have no checkout and run in eve's default sandbox, which this does not restrict. Set to `open` to allow every host |
| `FACTORY_SANDBOX_ALLOWED_DOMAINS` | No | none | Comma-separated hostnames to allow on top of the defaults, such as a private registry or an API your tests call (`npm.example.com,api.example.com`). Full hostnames only: no scheme, port, path, or wildcard. An entry that is not a hostname stops sandboxes from opening, with a message that names it |
| `FACTORY_ALLOW_INSTALL_SCRIPTS` | No | off | Station sandboxes tell npm, pnpm, and Yarn not to run install scripts (`postinstall` and the like), a dependency's or your own. This also overrides a pnpm build allowlist (`allowBuilds`) in your repository, and the install still succeeds, so a skipped native build shows up later as a failing test. If your install step does real work in a script, name it in `FACTORY_SETUP_COMMAND` (`pnpm install && pnpm run generate`), or set this to `1` to let install scripts run |
| `FACTORY_SIGNED_COMMITS` | No | off | Set to `1` if a ruleset requires signed commits on Foreman's branches. The push then recreates each commit through GitHub's API so GitHub signs it as the app; commit SHAs change, file contents do not. Git LFS files cannot be pushed this way |
| `GITHUB_CONNECTOR` / `LINEAR_CONNECTOR` | Yes | none | Set automatically from Vercel Connect connector UIDs |

## Local development

Link the project you deployed (or a fresh one), pull its environment, and start the TUI:

```bash
vercel link
vercel env pull
pnpm dev
```

Hand the agent a task ("users report the password reset email arrives twice, fix it") and watch triage and the stations fire in order, ending in a draft PR on `FACTORY_REPO`. Local runs are treated as untrusted, so labels, comments, and other writes to GitHub wait for your approval in the TUI. Memory in the TUI lives in the local process and is gone when it exits.

Before you push a change to the factory itself:

```bash
pnpm test       # the offline test suite: no model, no GitHub, no sandbox
pnpm validate   # lint, typecheck, tests, and eve's discovery check
```

## Submit work over HTTP

Send a ticket with a title and a body. `externalId` makes the request safe to retry: the same id from the same caller always lands on the same ticket.

```bash
curl -X POST "https://<your-deployment>/intake/v1/tickets" \
  -H "Authorization: Bearer $FACTORY_INTAKE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Password reset email arrives twice",
    "body": "Users report two identical reset emails a few seconds apart.",
    "externalId": "HELP-1042",
    "priority": "high"
  }'
```

The answer is `202` with a `ticketId` (a retry of the same `externalId` answers `200` with `duplicate: true` and the same `ticketId`). The run is unattended: Foreman can read, label, close or reopen an issue, and open a draft pull request, and anything that would need a person's approval is refused. Poll for the result:

```bash
curl "https://<your-deployment>/intake/v1/tickets/<ticketId>" \
  -H "Authorization: Bearer $FACTORY_INTAKE_TOKEN"
```

`status` moves through `queued`, `running`, and `completed` (or `failed`, `cancelled`, `awaiting-input`), and `result` carries Foreman's final message: the draft pull request link, or the questions it needs answered. The other optional fields are `source`, `requester`, `labels`, and `callbackUrl`; unknown fields are rejected, and every field except `body` must be a single line.

A ticket belongs to the caller that submitted it: another caller asking for the same `ticketId` gets a `404`, the same answer as for an unknown id. Everyone who presents the shared `FACTORY_INTAKE_TOKEN` counts as one caller. A ticket is also one run. When `result` is a list of questions, send the answers as a new ticket with a new `externalId`; resubmitting the same `externalId` returns the original ticket and starts nothing.

With a `callbackUrl` on a host listed in `FACTORY_INTAKE_CALLBACK_HOSTS`, Foreman also POSTs status updates to that URL. Each one is signed in `x-factory-signature` (hex HMAC-SHA256 of the body), carries `sentAt` inside the signed body so a receiver can refuse an old one replayed later, and has an `idempotency-key` header so a receiver can drop a repeat. A `callbackUrl` on a host that isn't listed is refused with `400` `callback_not_allowed`, and one sent to a deployment with no `FACTORY_INTAKE_CALLBACK_SECRET` with `400` `callback_not_configured`.

## Resources

- [Foreman Docs](https://ask-foreman.dev/docs)
- [Vercel Connect](https://vercel.com/docs/connect)
- [eve Documentation](https://eve.dev/docs/introduction)
- [GitHub CLI manual](https://cli.github.com/manual/)

## Explore more templates

- [eve Marketing Team](https://vercel.com/templates/eve/eve-marketing-team)
- [eve Personal Agent](https://vercel.com/templates/nuxt/eve-personal-agent)
- [eve Sanity Copilot](https://vercel.com/templates/eve/eve-sanity-copilot)
