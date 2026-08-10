# CURRENT — work in progress

**Updated:** 2026-08-06
**`main`:** `3d0571c`, clean, pushed, running.
**`agent`:** `e8ab6ae` — the SDK runner, written but **not wired in**.
**Rule:** see *"Every piece of work keeps a live handoff"* in `CLAUDE.md`.

## Start here

The next action is a **single test** that decides whether
[ADR 0012](../decisions/0012-claude-agent-sdk.md) stands or gets reversed.
Everything else below is context for it.

## The environment is now set up correctly — don't re-do it

Verified against the running server on 2026-08-06:

```
OPERATOR_JOB_CWD     = D:\Projects\Operator-agent   jobs run in the worktree
OPERATOR_JOB_PROFILE = 1                            standing profile armed
jobs cwd (server)    = D:\Projects\Operator-agent   picked up, separate: true
agent build (:9443)  = up
supervised           = true
```

**`setx` only reaches new shells, and the Restart button cannot fix that** — the
supervisor passes its own environment down, so a restart inherits whatever the
supervisor started with. Changing an env var means: Ctrl+C, close the window,
open a new one, `npm run serve`. An hour went into rediscovering this.

## The one thing that matters

**Is `canUseTool` ever consulted?** That is the entire justification for ADR
0012 — in-turn permissions, so a denial stops ending the turn.

It is **unproven**, and the four tests that said "no" were invalid. The fourth
showed why: asked to run Bash, Claude reported its available tools as *"Agent,
Artifact, AskUserQuestion, ScheduleWakeup, Skill, ToolSearch, Workflow"* —
**the host session's tools.** The SDK inherits the Claude Code process it is
spawned from, and clearing every `CLAUDE_*` / `ANTHROPIC_*` variable did not
break the coupling.

So: **any SDK test run from inside a Claude Code session is contaminated.**
Operator's own server is not a Claude Code child, which is why the test has to
run there.

### The test

1. Read the worktree's `server/jobs.mjs`. It has diverged from `main` —
   Claude-in-Operator edited it and **those changes are unreviewed**.
2. Wire `runner.mjs` into `runTurn`, on `agent`.
3. From Operator's Claude page, ask a job to run something not already in
   `.claude/settings.local.json`.
4. Expect: a `permission_request` event, the turn **pausing**, and — once
   answered — that *same turn* continuing to a `tool_result`.

**If the turn ends instead of pausing, reverse ADR 0012 rather than patching
it.** The SDK would then buy nothing over the CLI that justifies 93 packages.

## What is already true and verified

- **Step 1 (the job model) is merged and in daily use** — tabs, event log with
  `tool_use`/`tool_result`, cancel, per-job model, restart survival.
- **The SDK runs on the Pro subscription with no API key.** Jobs stay plan
  usage, not metered spend. Tested with `ANTHROPIC_API_KEY`,
  `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` all unset.
- **A plain turn works end to end through `runner.mjs`** — events, session id,
  cost, no error.
- **The worktree genuinely isolates.** npm replaced the `node_modules` junction
  with a real directory, so `main` has no SDK and still builds.

## Landmines

- **`git add -A` is banned here** (`CLAUDE.md`). Two writers share this tree; it
  has swept up Claude's in-flight work into unrelated commits twice.
- **`node` is version-shadowed, not broken.** npm resolves v23.8.0, direct
  resolves v24.12.0; both catch syntax errors correctly. An earlier note here
  claimed `node --check` "verifies nothing" — that was false and is corrected.
- **`tsc` and `vite build` never read `.mjs`.** A clean build says nothing about
  a server change.
- **The deny list is not a boundary.** `git -C <path> push` ran with zero
  denials, and a file was deleted via `node -e`. It is a speed bump against
  accidents. What makes that acceptable is the worktree — the blast radius is a
  branch in a checkout nobody is running.

## Also open

- **Uploads** (files/images into a job) — the surviving half of design-doc step
  2, and an original ask. Do it after the SDK question settles, since the answer
  changes where uploads are implemented.
- **`server/workspace.mjs`** is dead — no importer since the job model merged.
  Not deleted, deliberately: it is the fallback if `jobs.mjs` misbehaves in real
  use. Delete it once step 1 has a week of use.
- **Remote Control** was running earlier in the day and is now down; cause
  unknown. It is a startup flag (`claude --remote-control [name]`), not
  something a running session can switch on. Worth checking what it exposes
  before relying on it — this machine holds the store, the token and an armed
  terminal.

## Next

1. Read the worktree's `jobs.mjs` diff.
2. Wire in `runner.mjs`.
3. **Run the permission test.** That result decides ADR 0012.
4. Then uploads.
