# AGENTS.md

Guidance for AI coding agents working in this repository.

## Project overview

The eve Software Factory template: Foreman, an orchestrator agent built on the [eve](https://eve.dev) framework that turns work items into reviewed draft pull requests on the configured repository (`FACTORY_REPO`). Work arrives from GitHub (an issue labeled `factory` runs unattended; @Foreman mentions from owners/members/collaborators run attended) and from Linear Agent Sessions. The orchestrator moves every item through four declared subagent stations in order: **classifier** (triage, fast model) → **analyst** (plan + acceptance criteria, own repo checkout) → **implementer** (codes, verifies, pushes a feature branch from its own checkout) → **reviewer** (independent verdict on the pushed branch, different model vendor, max 2 revision cycles). The orchestrator then opens a draft PR; marking it ready parks on human approval, closing or reopening issues runs as reversible triage, and merging is not in the tool surface. Per-user preferences live in **Vercel Blob**, alongside a shared, per-repo **factory brain** (durable notes about the target repository) under a reserved Blob prefix, readable by every run but writable only by trusted callers. The pipeline lives in `agent/instructions.ts`.

The whole agent is defined under `agent/`. eve discovers capabilities from the filesystem. See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the component map, data flow, trust model, and boundaries.

## Setup & commands

```bash
pnpm install        # install dependencies (Node 24.x)
pnpm dev            # eve dev — local TUI; run /model once to link a model provider
pnpm typecheck      # tsc (TypeScript, no emit)
pnpm check          # ultracite (Biome) lint + format check
pnpm fix            # ultracite (Biome) auto-fix
pnpm build          # eve build
pnpm eval           # eve eval — run the evals suite (see tags below; costs real tokens)
eve deploy          # deploy to Vercel production (use this, not raw `vercel deploy`)
npx eve info        # print the discovered surface + discovery diagnostics
pnpm validate       # check + typecheck + eve info in one command
```

**Verify changes with `pnpm validate` (lint, typecheck, and discovery diagnostics must all report 0 errors / 0 warnings), then exercise the agent in the `pnpm dev` TUI.** The evals suite (`pnpm eval --tag fast`) guards routing and safety behavior; `pnpm eval pipeline/full-pipeline` runs the whole line and pushes a real branch, so run it deliberately and against a scratch repo.

## eve conventions

- **Read the relevant guide in `node_modules/eve/docs/` before writing code.** Don't invent framework APIs; confirm them against the docs.
- **Identity comes from the filesystem, never a `name` field.** A tool at `agent/tools/agent.ts` is the tool `agent`; a connection at `agent/connections/linear.ts` registers as `linear`; a subagent directory `agent/subagents/classifier/` lowers into the tool `classifier`.
- Authored slots: `agent/agent.ts` (model + session budget), `agent/instructions.ts` (`defineInstructions`, the orchestrator prompt; resolved at build time, injecting `FACTORY_REPO`), `agent/tools/*.ts` (`defineTool`), `agent/connections/*.ts`, `agent/extensions/*.ts`, `agent/channels/*.ts`, `agent/skills/<name>/SKILL.md`, `agent/subagents/<id>/agent.ts` (`defineAgent`), per-agent `sandbox.ts`.
- **Model assignments are centralized** in `agent/lib/models.ts` (the `MODELS` map). Every `agent.ts` reads its entry from there (`model: MODELS.<agent>`) instead of hardcoding a gateway id, so a model swap is a one-line edit in that file. One split is deliberate: `implementer` runs the strongest coding model on a different vendor than `reviewer`, so the review stays independent; keep those two on different vendors.
- **Extensions:** `agent/extensions/<ns>.ts` mounts a prebuilt eve extension; the filename is the namespace and its tools appear to the model as `<ns>__<tool>` (here: `github__*` from `@github-tools/eve-extension`). Config keys (`include`, `requireApproval`) use bare tool names.
- **Channels:** `github` (eve GitHub channel via Vercel Connect, botName resolved from the connector's app slug; `onComment` keeps the built-in mention/ignore rules, dispatches only for OWNER/MEMBER/COLLABORATOR commenters, and stamps `attributes.trusted`; `onIssue` dispatches only on the `labeled` action for the `factory` label and rewrites the principal to the autonomous one, so the run is unattended by construction; `onCheckSuite` dispatches only for failed suites on `factory/*` pull requests, unattended, with the fix loop capped by counting attempt comments on the PR thread; `onPullRequest` posts a summary comment on opened PRs, bot senders skipped), `linear` (Agent Sessions; every session stamped trusted since workspace membership is the gate), plus the `eve` route-auth channel.
- **Subagents are the stations.** Declared under `agent/subagents/<id>/`; `description` is required (the routing hint) and each station's `agent.ts` also declares an `outputSchema`, which makes every delegation run in **task mode**: structured output, no parking. A declared subagent runs in a fresh child session and **inherits nothing** from the root (no instructions, skills, connections, tools, or sandbox), so the orchestrator packs everything into the `message`, and any capability a station needs lives in the station's own directory (its `sandbox.ts`, its `tools/`).
- **Approval-gated tools must not live in task-mode children.** A task-mode session cannot park, so a station tool that returned `user-approval` would strand the run. Anything needing approval belongs on the root (the `github` extension); station side effects must be inert by construction, like `push_branch` (feature branches only, validated names, brokered credential).
- **`agent/lib/trust.ts` is the single trust authority.** Channels stamp trust at dispatch; approval policies in `agent/lib/github/approval.ts` read the stamps and return `not-applicable` / `user-approval` / `denied`. A new capability never invents its own caller check; gate on the existing predicates.
- **Station sandboxes** share their bootstrap/session logic via `agent/lib/github/repo-sandbox.ts`: the clone and `FACTORY_SETUP_COMMAND` run once per template build, sessions pay a fetch. Git operations always target the literal remote URL (never `origin`) with the token injected at the sandbox firewall.
- **Tools** run in the app runtime (full `process.env`), one default export per file; station git tools run their commands in the station's sandbox via `ctx.getSandbox()`. Gate destructive root tools with `approval` from `eve/tools/approval` (here: `clear_user_preferences`), or with a trust policy from `agent/lib/github/approval.ts` when the gate depends on the caller (here: `update_factory_brain`, gated by `factoryBrainPolicy` so unattended runs can't write shared context).
- **Connections** are MCP servers: `linear` (`https://mcp.linear.app/mcp`, app-scoped auth shared through `linearAuth` in `agent/lib/constants.ts`). Its connection-wide `approval` predicate denies writes on unattended runs.
- **Skills** are load-on-demand. A packaged skill (`<name>/SKILL.md`) requires `description` frontmatter; that description is the routing hint. The skills here are `writing-quality`, `triaging-issues`, and `github-linear-bridging`. Skills are per-agent: stations don't see the root's skills.
- **Evals** live in `evals/` (`defineEval`, one file per case; `evals.config.ts` sets the judge model). Category directories are the failure taxonomy (`routing/`, `safety/`, `pipeline/`); `helpers.ts` carries the shared write-tool list so read-only evals assert deny-by-default (`notCalledTool` over the whole list). Tags: `fast` (cheap loop), `slow`, `needs-connect` (asserts calls that must succeed against real Connect auth), `pipeline` (pushes a real branch; opt-in).
- After editing, **check LSP diagnostics / `pnpm typecheck`** and fix type errors before moving on.

## Code style

- Linting and formatting are handled by **Ultracite** (a Biome preset). Run `pnpm check` before finishing and `pnpm fix` to auto-fix. Config is in `biome.jsonc`; the kebab-case filename rule is disabled there because eve tools use snake_case names.
- TypeScript strict; ESM with `NodeNext` resolution (relative imports need a `.js` extension). Prefer `const`, arrow functions, optional chaining / nullish coalescing.
- Validate tool input/output with `zod` schemas.
- Comments are single-line only: no multi-line or block comments (no `/* */`, no `/** */` TSDoc blocks). Keep them reasonable and sparse, a brief `//` note where it earns its place, and prefer self-documenting names and structure over commentary.
- Prose in markdown files is not hard-wrapped: write each paragraph or bullet as one line.
- Agent-facing text (instructions, skill bodies, tool and subagent descriptions) follows the "How you write" rules in `agent/instructions.ts`: no em dashes, no machine-made words, no bold for emphasis. It carries behavior only, never framework plumbing (how approvals render, sign-in flows) or references to tools and skills the reading agent can't access — station instructions especially, since stations see none of the root's surface.

## Security

- **Never ask the user for API keys, client secrets, or any other credentials.**
- **Never commit secrets.** `.env*` is gitignored. Connector UIDs are read from env (`GITHUB_CONNECTOR`, `LINEAR_CONNECTOR`); GitHub and Linear auth is brokered by Vercel Connect (tokens resolved per call, never exposed to the model) and Blob auth is via the project's OIDC token. `FACTORY_REPO` is required at module load (`requireEnv`), so a missing value fails discovery; `FACTORY_SETUP_COMMAND` is optional.
- **Git safety is structural; keep it that way.** Sandbox git always targets the literal `https://github.com/<FACTORY_REPO>.git` URL, never `origin` (remote config in a sandbox is model-writable), with the installation token injected at the sandbox firewall (`brokerPolicy`) so it never enters the sandbox. Everything interpolated into a git command passes `validateBranch`, which also refuses `main`/`master`. Don't weaken these when adding git capabilities.
- **Respect the trust model.** Trust is stamped at dispatch by the channels; unattended runs are denied writes (except labels, comments scoped to their stamped intake issue, close/reopen, and draft PRs) rather than parked. When adding a tool or connection, pick its policy from `agent/lib/github/approval.ts` (or the trust predicates) instead of hardcoding `"never"`.
- If you ever build a `RegExp` from data, escape it (literal match) and bound the input length.
- Gate irreversible or high-impact actions behind `approval` (here: `clear_user_preferences`, plus the ship-gate policies on the GitHub extension).
- For per-user storage, derive the key from the resolved principal (`ctx.session.auth.current`), never from model input — see `agent/lib/user-preferences.ts`. The preference files live under the reserved `user-preferences/` Blob prefix, reachable only through the principal-scoped preference tools.
- The shared **factory brain** derives its key from `FACTORY_REPO`, never from model input or a caller principal — see `agent/lib/factory-brain.ts`. It lives under the reserved `factory-brain/` Blob prefix, reachable only through `read_factory_brain` / `update_factory_brain`; writes are gated by `factoryBrainPolicy` (unattended runs denied, trusted callers direct, everyone else parks) so an untrusted issue body can't poison the context every future run reads.

## Before committing

- `pnpm validate` passes (Ultracite check, `tsc`, and `eve info` with 0 errors / 0 warnings).
- No secrets, `node_modules`, or build output (`.eve`, `.vercel`, `.output`) staged.
