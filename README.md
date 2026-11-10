<img width="100%" alt="eve Software Factory Banner" src=".github/banner.png" />

# eve Software Factory Template

[![Docs](https://img.shields.io/badge/Documentation-000?style=flat-square&logo=readthedocs&logoColor=FFF&labelColor=000&color=000)](https://ask-foreman.dev/docs)
[![Agent Stack](https://img.shields.io/badge/Agent%20Stack-000?style=flat-square&logo=vercel&logoColor=FFF&labelColor=000&color=000)](https://vercel.com/kb/agent-stack)
[![MIT License](https://img.shields.io/badge/License-MIT-000?style=flat-square&logo=opensourceinitiative&logoColor=white&labelColor=000&color=000)](LICENSE)

Meet **Foreman**, an eve software factory that puts AI agents on every stage of the development loop and keeps people on the judgment calls.

Foreman takes tasks from GitHub, Linear, or a plain HTTP request, triages each one, moves it through its stations, and delivers a reviewed draft pull request on your repository. You review, mark ready, and merge.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?demo-title=eve+Software+Factory&demo-description=Software+factory+built+on+eve%3A+AI+agents+work+each+stage+of+the+development+loop%2C+and+people+make+the+judgment+calls.&project-name=eve-software-factory&repository-name=eve-software-factory-template&repository-url=https%3A%2F%2Fgithub.com%2Fvercel-labs%2Feve-software-factory-template&env=FACTORY_REPO%2CFACTORY_LABEL&envDefaults=%7B%22FACTORY_LABEL%22%3A%22factory%22%7D&envDescription=FACTORY_REPO+is+the+owner%2Frepo+the+factory+works+on.+FACTORY_LABEL+is+the+issue+label+that+hands+an+issue+to+the+factory%3B+the+default+label+is+fine.&connect=%5B%7B%22type%22%3A%22github%22%2C%22env%22%3A%22GITHUB_CONNECTOR%22%2C%22triggers%22%3Atrue%2C%22triggerPath%22%3A%22%2Feve%2Fv1%2Fgithub%22%7D%2C%7B%22type%22%3A%22linear%22%2C%22env%22%3A%22LINEAR_CONNECTOR%22%2C%22triggers%22%3Atrue%2C%22triggerPath%22%3A%22%2Feve%2Fv1%2Flinear%22%7D%5D&stores=%5B%7B%22type%22%3A%22blob%22%2C%22access%22%3A%22public%22%7D%5D&demo-image=%2F%2Fimages.ctfassets.net%2Fe5382hct74si%2F45PVqbeL5egwsqBRpGt6SQ%2F99e9f270dc22e07f499236af3a11a190%2Fimage.png&redirect-url=https%3A%2F%2Fask-foreman.dev%2Fwelcome)

## How it works

- **Triage** sorts the task in one fast step: type, priority, complexity, labels from your repository's own set, and whether an existing issue already covers it. When the task is too thin to build, the **Classifier** writes the questions and Foreman asks the requester instead of building the wrong thing.
- **Researcher** steps in only when the task turns on an outside fact, and hands back cited findings.
- **Analyst** turns the task into a plan with acceptance criteria, working from a live checkout of your repository.
- **Implementer** executes the plan in its own sandbox, verifies with your repo's own checks, and pushes a branch.
- **Reviewer** independently judges everything against the real diff, with evidence for each verdict.

Each station is its own agent with its own instructions, sandbox, and tools. The Reviewer sees only the pushed branch, never the Implementer's reasoning. Foreman works on GitHub with the real `gh` and `git` command-line tools, held to an allowlist of commands and a credential that is attached for one command at a time and scoped to your one repository. Between runs, Foreman keeps a **factory brain**: notes about your repository that every run starts from. See [the pipeline](https://ask-foreman.dev/docs/pipeline) and [factory memory](https://ask-foreman.dev/docs/memory) for the full picture.

## How work arrives

- **Label an issue `factory`.** The pipeline runs on its own, posts progress as stations complete, and ends with a draft PR linked to the issue.
- **@mention it on an issue or PR.** Mentions from repo owners, members, and collaborators start an interactive session.
- **Delegate in Linear.** Linear Agent Sessions run the same pipeline and report progress back in Linear.
- **POST a ticket.** Any system that can send JSON can hand Foreman a task over HTTP and poll for the result. See [Submit work over HTTP](#submit-work-over-http).
- **The dev TUI.** Hand it a task locally. Labels, comments, and other writes to GitHub wait for your approval.
- **Red CI on a factory PR.** Foreman diagnoses the failure and, when the code is the cause, pushes a fix to its own branches, never yours. A flaky test or a broken runner gets a comment instead of a fix.
- **Someone opens a pull request.** Foreman posts one orienting comment for reviewers: a summary, not a review.

## Deploy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?demo-title=eve+Software+Factory&demo-description=Software+factory+built+on+eve%3A+AI+agents+work+each+stage+of+the+development+loop%2C+and+people+make+the+judgment+calls.&project-name=eve-software-factory&repository-name=eve-software-factory-template&repository-url=https%3A%2F%2Fgithub.com%2Fvercel-labs%2Feve-software-factory-template&env=FACTORY_REPO%2CFACTORY_LABEL&envDefaults=%7B%22FACTORY_LABEL%22%3A%22factory%22%7D&envDescription=FACTORY_REPO+is+the+owner%2Frepo+the+factory+works+on.+FACTORY_LABEL+is+the+issue+label+that+hands+an+issue+to+the+factory%3B+the+default+label+is+fine.&connect=%5B%7B%22type%22%3A%22github%22%2C%22env%22%3A%22GITHUB_CONNECTOR%22%2C%22triggers%22%3Atrue%2C%22triggerPath%22%3A%22%2Feve%2Fv1%2Fgithub%22%7D%2C%7B%22type%22%3A%22linear%22%2C%22env%22%3A%22LINEAR_CONNECTOR%22%2C%22triggers%22%3Atrue%2C%22triggerPath%22%3A%22%2Feve%2Fv1%2Flinear%22%7D%5D&stores=%5B%7B%22type%22%3A%22blob%22%2C%22access%22%3A%22public%22%7D%5D&demo-image=%2F%2Fimages.ctfassets.net%2Fe5382hct74si%2F45PVqbeL5egwsqBRpGt6SQ%2F99e9f270dc22e07f499236af3a11a190%2Fimage.png&redirect-url=https%3A%2F%2Fask-foreman.dev%2Fwelcome)

The Vercel deploy flow sets up the basics: the **GitHub** connector, **Linear** connector, **Vercel Blob** store, and a prompt for the `FACTORY_REPO` and `FACTORY_LABEL` environment variables.

After the first deploy, finish the setup from the linked project (`vercel link`, as in [Local development](#local-development)):

1. Run `eve integration setup file-memory`, then redeploy with `eve deploy`. This provisions the private Blob store that holds Foreman's memory (user preferences and the factory brain) and sets `EVE_MEMORY_BLOB_STORE_ID` for you.
2. Check the GitHub App's permissions: read and write on contents, issues, and pull requests, plus read on Actions, Checks, and Commit statuses so Foreman can diagnose red CI.
3. Optional: set `FACTORY_INTAKE_TOKEN` to a random secret of at least 32 characters if you want to submit work over HTTP from outside Vercel.
4. Recommended: protect your default branch on GitHub. Foreman's tools refuse pushes to `main` and `master`, and branch protection enforces the same rule on GitHub's side, whatever code runs in a sandbox.

Two things must line up before Foreman can do any real work. `FACTORY_REPO` must name a real repository in `owner/repo` format, and the GitHub App behind the connector you select must be installed with access to that repository. A station's sandbox clones `FACTORY_REPO` on its first session, not at deploy time, so a repository the app cannot reach surfaces as a `Cannot access <owner/repo>` error on the first task you hand it, not the deploy itself; install the app on the repository (or fix the value), then try again.

Configuration (see `.env.example`):

| Variable | Required | Default | What it does |
| --- | --- | --- | --- |
| `FACTORY_REPO` | Yes | none | An existing GitHub repository in `owner/repo` format; the selected GitHub App must have access to it (a station's first session fails otherwise) |
| `FACTORY_SETUP_COMMAND` | No | none | Runs once per session inside the station sandbox checkout (e.g. `pnpm install`), so the station starts with dependencies already installed. It runs with network access but no GitHub credential |
| `FACTORY_LABEL` | No | `factory` | The issue label that hands an issue to the factory |
| `FACTORY_BRANCH_PREFIX` | No | `factory/` | Branch prefix marking the factory's own PRs, which are the only branches automated CI fixes touch |
| `FACTORY_BOT_NAME` | No | the GitHub App's slug | The `@mention` name, resolved from the connector automatically when unset |
| `FACTORY_INTAKE_TOKEN` | No | none | Shared secret (32 characters or more) for the HTTP intake API. Unset, only callers with a Vercel OIDC token for the project can submit |
| `FACTORY_INTAKE_CALLBACK_HOSTS` | No | none | Comma-separated hosts (`host` or `host:port`, exact match) a ticket's `callbackUrl` may point at |
| `FACTORY_INTAKE_CALLBACK_SECRET` | No | none | Signs status callbacks (HMAC-SHA256 in `x-factory-signature`). No callbacks are sent without it |
| `FACTORY_STRICT_TOKEN_SCOPES` | No | off | Set to `1` to fail instead of falling back to a wider GitHub token when a narrowed one is refused |
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

The answer is `202` with a `ticketId`. The run is unattended: Foreman can read, label, and open a draft pull request, and anything that would need a person's approval is refused. Poll for the result:

```bash
curl "https://<your-deployment>/intake/v1/tickets/<ticketId>" \
  -H "Authorization: Bearer $FACTORY_INTAKE_TOKEN"
```

`status` moves through `queued`, `running`, and `completed` (or `failed`, `cancelled`, `awaiting-input`), and `result` carries Foreman's final message: the draft pull request link, or the questions it needs answered. The other optional fields are `source`, `requester`, `labels`, and `callbackUrl`; unknown fields are rejected.

## Upgrading from an earlier version of this template

- **Node 24 and eve 1.0.** This version runs on eve 1.0 (`eve@^1.0.0-rc.8`), which needs Node 24.
- **GitHub tools.** The `@github-tools/eve-extension` dependency and its `github__*` tools were removed. Foreman now runs `gh` and `git` in its sandboxes; if you customized the old extension's allowlist, the equivalent now lives in `agent/lib/github/cli.ts`.
- **Memory is not migrated.** Preferences and the factory brain moved to eve's built-in memory. Documents written by earlier versions under the Blob prefixes `user-preferences/` and `factory-brain/` stay where they are and are no longer read. Run `eve integration setup file-memory`, redeploy, then carry the brain over by hand: open the old document in your Blob store, paste it into a trusted session on the deployment (an @mention from a maintainer, or a Linear session), and ask Foreman to save the facts to the factory brain, one per entry. Each user restates their own preferences the same way.
- **GitHub App permissions.** Contents, issues, and pull requests still need read and write. Add read on Actions, Checks, and Commit statuses if the app doesn't have them, or CI diagnosis has no logs to read.
- **`FACTORY_SETUP_COMMAND` can still be `pnpm install`.** eve's sandbox image no longer ships pnpm, so the factory installs it into the image when the sandbox template is built. One difference: the setup command used to run while the GitHub App's token was attached to every request to github.com from the sandbox, and it no longer does. If your install reads a private GitHub repository (a git dependency, a submodule), give it its own credential.
- **Session budget.** A session that crosses its token budget now asks whether to continue instead of stopping.

## Resources

- [Foreman Docs](https://ask-foreman.dev/docs)
- [Vercel Connect](https://vercel.com/docs/connect)
- [eve Documentation](https://eve.dev/docs/introduction)
- [GitHub CLI manual](https://cli.github.com/manual/)

## Explore more templates

- [eve Marketing Team](https://vercel.com/templates/eve/eve-marketing-team)
- [eve Personal Agent](https://vercel.com/templates/nuxt/eve-personal-agent)
- [eve Sanity Copilot](https://vercel.com/templates/eve/eve-sanity-copilot)
