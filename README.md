# eve Software Factory Template

[![Agent Stack](https://img.shields.io/badge/Agent%20Stack-000?style=flat-square&logo=vercel&logoColor=FFF&labelColor=000&color=000)](https://vercel.com/kb/agent-stack)
[![MIT License](https://img.shields.io/badge/License-MIT-000?style=flat-square&logo=opensourceinitiative&logoColor=white&labelColor=000&color=000)](LICENSE)

Meet **Foreman**, an eve software factory that puts AI agents on every stage of the development loop and keeps people on the judgment calls.

The orchestrator takes work items from GitHub and Linear, moves each one through four stations, and delivers a reviewed draft pull request on your repository. You review, mark ready, and merge.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?project-name=eve-software-factory&repository-name=eve-software-factory-template&repository-url=https%3A%2F%2Fgithub.com%2Fvercel-labs%2Feve-software-factory-template&env=FACTORY_REPO,FACTORY_LABEL&envDefaults=%7B%22FACTORY_LABEL%22%3A%22factory%22%7D&envDescription=FACTORY_REPO%20is%20the%20owner%2Frepo%20the%20factory%20works%20on.%20FACTORY_LABEL%20is%20the%20issue%20label%20that%20hands%20an%20issue%20to%20the%20factory%3B%20the%20default%20label%20is%20fine.&connect=%5B%7B%22type%22%3A%22github%22%2C%22env%22%3A%22GITHUB_CONNECTOR%22%2C%22triggers%22%3Atrue%2C%22triggerPath%22%3A%22%2Feve%2Fv1%2Fgithub%22%7D%2C%7B%22type%22%3A%22linear%22%2C%22env%22%3A%22LINEAR_CONNECTOR%22%2C%22triggers%22%3Atrue%2C%22triggerPath%22%3A%22%2Feve%2Fv1%2Flinear%22%7D%5D&stores=%5B%7B%22type%22%3A%22blob%22%2C%22access%22%3A%22public%22%7D%5D)

## How it works

- **Classifier** triages the work item: type, priority, complexity, actionable or not. When the item isn't actionable, Foreman asks the requester instead of building the wrong thing.
- **Analyst** turns it into a plan with acceptance criteria, grounded in a live checkout of your repository.
- **Implementer** executes the plan in its own sandbox checkout, runs your repo's own checks, and pushes a feature branch.
- **Reviewer** independently judges the pushed branch against the acceptance criteria, on a different model vendor, and can send the work back for up to 2 revision cycles.
- The **factory brain** isn't a station: it's shared, durable memory of your repo that Foreman reads at the start of a run and records learnings into at the end.

Each station is a declared subagent with its own instructions, sandbox, and tool surface. The reviewer never sees the implementer's reasoning, only its pushed branch. That separation is what makes the review meaningfully independent.

## How work arrives

- **Label an issue `factory`.** The pipeline runs unattended, posts progress comments as stations complete, and links a draft PR from the issue. When clarification is needed, it posts its questions and stops.
- **@Foreman on an issue or PR.** Mentions from repo owners, members, and collaborators start an attended session. Anyone else is ignored.
- **Delegate in Linear.** Linear Agent Sessions run the same pipeline and report back as Agent Activities.
- **@Foreman in Slack.** Mention or DM Foreman in a workspace where the Slack app is installed; it runs the pipeline and replies in the thread. Every workspace member is trusted (optional channel, off until you attach a Slack connector).
- **The dev TUI.** Hand it a work item locally. Writes park on approval cards there, which doubles as a demo of the human gate.
- **Red CI on a factory PR.** When a check suite fails on a pull request the factory pushed, it diagnoses the failure and pushes a fix to the same branch; after 2 unsuccessful attempts it pauses and asks for a person. PRs people pushed are never touched.

## Factory memory

Foreman keeps a **factory brain**: one shared, durable set of notes about the target repository, stored in Vercel Blob.

It's where the factory records what it learns across runs: build quirks, verification steps that aren't obvious, review findings that keep recurring, repo conventions. Later runs start with that context instead of rediscovering it. Foreman reads the brain at the start of a task, weaves the relevant facts into the messages it sends stations, and records durable facts back once the work lands.

The brain is scoped to `FACTORY_REPO`: one brain per deployment, and retargeting a deployment at another repository gets a fresh one. Reads are open to every run. Writes follow the trust model: trusted callers write directly, unattended runs are denied (so an issue body can't poison shared context), and the dev TUI parks the write on approval.

## Deploy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?project-name=eve-software-factory&repository-name=eve-software-factory-template&repository-url=https%3A%2F%2Fgithub.com%2Fvercel-labs%2Feve-software-factory-template&env=FACTORY_REPO,FACTORY_LABEL&envDefaults=%7B%22FACTORY_LABEL%22%3A%22factory%22%7D&envDescription=FACTORY_REPO%20is%20the%20owner%2Frepo%20the%20factory%20works%20on.%20FACTORY_LABEL%20is%20the%20issue%20label%20that%20hands%20an%20issue%20to%20the%20factory%3B%20the%20default%20label%20is%20fine.&connect=%5B%7B%22type%22%3A%22github%22%2C%22env%22%3A%22GITHUB_CONNECTOR%22%2C%22triggers%22%3Atrue%2C%22triggerPath%22%3A%22%2Feve%2Fv1%2Fgithub%22%7D%2C%7B%22type%22%3A%22linear%22%2C%22env%22%3A%22LINEAR_CONNECTOR%22%2C%22triggers%22%3Atrue%2C%22triggerPath%22%3A%22%2Feve%2Fv1%2Flinear%22%7D%5D&stores=%5B%7B%22type%22%3A%22blob%22%2C%22access%22%3A%22public%22%7D%5D)

The button provisions everything: the **GitHub** connector, **Linear** connector, **Vercel Blob** store, and a prompt for the `FACTORY_REPO` and `FACTORY_LABEL` environment variables.

Configuration (see `.env.example`):

| Variable | Required | Default | What it does |
| --- | --- | --- | --- |
| `FACTORY_REPO` | Yes | — | The `owner/repo` the factory works on; a missing value fails the build |
| `FACTORY_SETUP_COMMAND` | No | — | Runs inside the station sandboxes' clone once per template build (e.g. `pnpm install`), so sessions start with your repo's checks runnable |
| `FACTORY_LABEL` | No | `factory` | The issue label that hands an issue to the factory |
| `FACTORY_BRANCH_PREFIX` | No | `factory/` | Branch prefix marking the factory's own PRs; scopes the red-CI fix loop |
| `FACTORY_BOT_NAME` | No | the GitHub App's slug | The `@mention` name; resolved from the connector automatically when unset |
| `GITHUB_CONNECTOR` / `LINEAR_CONNECTOR` | Yes (set automatically) | — | Vercel Connect connector UIDs |

### Manual Setup

Run the manual setup commands in your terminal if you prefer to set the template up yourself instead of via the Vercel deploy button.

<details>
<summary><strong>Manual Setup Commands</strong></summary>

```bash
# Clone the template and install dependencies
git clone https://github.com/vercel-labs/eve-software-factory-template.git my-factory
cd my-factory
pnpm install

# Create and link the Vercel project
vercel link

# GitHub connector (UID -> GITHUB_CONNECTOR); subscribe to issues (label
# intake), issue_comment and pull_request_review_comment (mentions),
# pull_request (PR summary comments), and check_suite (red-CI fixes)
# during registration
vercel connect create github --triggers
vercel connect attach <github-uid> --triggers --trigger-path /eve/v1/github --yes

# Linear connector (UID -> LINEAR_CONNECTOR); subscribe to the AgentSessionEvent
# webhook category during registration
vercel connect create linear --triggers
vercel connect attach <linear-uid> --triggers --trigger-path /eve/v1/linear --yes

# Optional Slack connector (UID -> SLACK_CONNECTOR); enable Event Subscriptions
# for app_mention and message.im during registration. The create step lands on
# the default Connect path, so detach and re-attach at the eve Slack route
vercel connect create slack --triggers
vercel connect detach <slack-uid> --yes
vercel connect attach <slack-uid> --triggers --trigger-path /eve/v1/slack --yes

# Environment: the connector UIDs printed above, plus the target repository (owner/repo)
vercel env add GITHUB_CONNECTOR
vercel env add LINEAR_CONNECTOR
vercel env add FACTORY_REPO
# Optional, only if you set up the Slack connector above
# vercel env add SLACK_CONNECTOR

# Blob store for user preferences and the factory brain
vercel blob create-store factory-store --access public --yes

# Deploy (eve deploy wraps `vercel deploy --prod`; the raw command
# can't auto-detect the eve framework)
eve deploy
```

The GitHub App installation needs write access to contents, issues, and pull requests on `FACTORY_REPO`.

</details>

## Local development

Link the project you deployed (or a fresh one), pull its environment, and start the TUI:

```bash
vercel link
vercel env pull
pnpm dev        # run /model once to link a model provider
```

Hand the TUI a work item ("users report the password reset email arrives twice, fix it") and watch the four stations fire in order, ending in a draft PR on `FACTORY_REPO`.

The dev principal is deliberately untrusted, so GitHub writes park on approval cards in the TUI. The webhook surfaces (mentions, the `factory` label, Linear sessions) run against a deployment.

Before shipping changes with `eve deploy`, run `pnpm validate` (lint + typecheck + eve discovery diagnostics) and, optionally, the evals:

```bash
pnpm eval --tag fast              # the default loop: smoke + safety, cheap
pnpm eval pipeline/full-pipeline  # opt-in: runs the whole line and pushes a real branch
```

Point `FACTORY_REPO` at a scratch repository before running the full-pipeline eval. Evals cost real model tokens.

## Customizing

- **The pipeline:** The orchestrator's routing and delivery rules live in `agent/instructions.ts`. Each station's procedure lives in `agent/subagents/<station>/instructions.md`; its model and output contract in the station's `agent.ts`.
- **Models:** Every assignment lives in `agent/lib/models.ts`; swapping one is a one-line edit. Keep the implementer and reviewer on different vendors so the review stays independent.
- **The approval policy:** `agent/lib/github/approval.ts` is the whole policy in a handful of small functions; `agent/extensions/github.ts` maps GitHub tools onto it. Changing what unattended runs may do is an edit there, not a prompt change.
- **The intake label:** `FACTORY_LABEL` in `agent/lib/constants.ts`.
- **PR summaries:** Foreman posts an orienting comment on newly opened PRs; remove the `onPullRequest` hook in `agent/channels/github.ts` if you don't want that.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the full component map and trust model, and [`AGENTS.md`](./AGENTS.md) if you're working on the template with an AI coding agent.

## Extending

- **Continuous operation:** Add a schedule that sweeps for queued work on a cron; the approval policies already recognize schedule turns (`isScheduleAppAuth` in `agent/lib/trust.ts`).
- **Merge behind approval:** Add `mergePullRequest` to the extension's allowlist mapped to `shipPolicy` if you want "@Foreman merge it" to work from a comment.
- **More intake:** The GitHub channel also has `onCheckRun`/`onWorkflowRun` hooks; the Slack channel here handles mentions and DMs, and eve also ships Discord, Teams, and other channels.
- **Deeper station tooling:** Stations are ordinary eve agents; give the analyst a Sentry MCP connection, or the reviewer a browser extension. Stations inherit nothing, so capabilities go in the station's own directory.

## Learn more

- [eve documentation](https://eve.dev/docs/introduction): The framework; the docs also ship inside the package at `node_modules/eve/docs`
- [GitHub Tools eve extension](https://github-tools.com/frameworks/eve-extension): The GitHub tool surface
- [Vercel Connect](https://vercel.com/docs/connect) · [Vercel Sandbox](https://vercel.com/docs/sandbox) · [Vercel Blob](https://vercel.com/docs/vercel-blob)

## Related templates

- [eve Content Agent](https://github.com/vercel-labs/eve-content-agent-template)
- [eve Personal Agent](https://vercel.com/templates/nuxt/eve-personal-agent)
