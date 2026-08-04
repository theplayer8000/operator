# CURRENT — work in progress

**Updated:** 2026-08-03
**Branch:** `main` is clean and shipping. Work in progress is on **`agent`**.
**Rule:** see *"Every piece of work keeps a live handoff"* in `CLAUDE.md`.

## What this is

[ADR 0012](../decisions/0012-claude-agent-sdk.md) — adopting the Claude Agent
SDK so a permission can be answered **inside** a turn. Decided because the CLI
structurally cannot: asked to close Snapchat, Claude made six attempts and every
one was refused, since print mode has no channel to say yes on.

Design-doc step 1 (the job model) is **merged and in daily use**. This is the
next thing, not a continuation of that.

## Done

- **`docs/decisions/0012-claude-agent-sdk.md`** on `main` — records both
  measurements, including that I first claimed the SDK had zero transitive
  dependencies and was wrong in the direction that made adoption look cheaper.
- **`CLAUDE.md` stack rule amended** — it now governs the frontend; `server/`
  may take a dependency only through an ADR naming the package.
- **`server/runner.mjs`** on `agent` (`e8ab6ae`) — the SDK behind one file, the
  only thing in `server/` importing from npm. Not wired into `jobs.mjs`.
- **SDK installed in the worktree only.** npm replaced the `node_modules`
  junction with a real directory, so `main` is genuinely untouched — verified.

## Verified

- Runs on the **Pro subscription with no API key** (`ANTHROPIC_API_KEY`,
  `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` all unset). Jobs stay plan usage
  rather than becoming metered spend.
- A plain turn works end to end through `runner.mjs`: events in the existing
  vocabulary, session id returned, cost tracked, no error.
- `main` still typechecks and builds with the SDK absent from it.

## NOT verified — and the reason matters

**Whether `canUseTool` is ever consulted.** This is the entire justification for
ADR 0012, and it is unproven.

Four attempts said it was never called. The fourth explained why: asked to run
Bash with `disallowedTools` set, Claude replied that its available tools were
*"Agent, Artifact, AskUserQuestion, ScheduleWakeup, Skill, ToolSearch,
Workflow"*. **Those are the host session's tools.** The SDK inherits the Claude
Code process it is spawned from, and stripping every `CLAUDE_*` and
`ANTHROPIC_*` environment variable did not break the coupling — so it is deeper
than env.

**Any SDK test run from inside a Claude Code session is contaminated.** That
includes every permission result recorded above as "not called". It is not
evidence that `canUseTool` is broken; it is evidence the test was invalid.

### How to actually test it

From Operator's own server — a plain `node` process, not a child of any Claude
session:

1. On the `agent` worktree, wire `runner.mjs` into `runTurn` in `jobs.mjs`.
2. `npm run serve` from a normal terminal.
3. Ask a job to run something not in `.claude/settings.local.json`.
4. Expect: a `permission_request` event, the turn **pausing**, and — once
   answered — the same turn continuing with a `tool_result`.

If the turn ends instead of pausing, the SDK buys nothing over the CLI and
**ADR 0012 should be reversed**, not patched.

## Landmines

- **`node` is version-shadowed, not broken.** npm resolves v23.8.0 (parent
  `node_modules/.bin` on PATH), a direct `node` gets v24.12.0. Both catch syntax
  errors correctly — measured. An earlier note here claimed `node --check`
  "verifies nothing"; that was false and is corrected.
- **`tsc` and `vite build` never read `.mjs`.** A clean build says nothing about
  a server change.
- **The worktree's `jobs.mjs` has diverged** from `main` — Claude-in-Operator
  edited it and those changes are unreviewed. Read them before wiring anything
  into that file.

## Next

1. Read the worktree's `jobs.mjs` changes.
2. Wire `runner.mjs` in, on `agent`.
3. Run the permission test above from a real server. **That result decides
   whether ADR 0012 stands.**
4. Only then: uploads.
