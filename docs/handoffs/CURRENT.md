# CURRENT — work in progress

**Updated:** 2026-08-17
**`main`:** `d6964e7`, clean, nothing running.
**`agent`:** `e8ab6ae` — the SDK runner, written but **not wired in**.
**Rule:** see *"Every piece of work keeps a live handoff"* in `CLAUDE.md`.

## ANSWERED — ADR 0012 stands (2026-08-19)

**`canUseTool` pauses the turn. Measured, cleanly, at last.**

```
18534ms  tool_use: Write
18560ms  >>> canUseTool FIRED: Write — probe-touch.txt
18561ms  >>> holding the answer for 8s...
26563ms  >>> answering ALLOW
26581ms  tool_result (error=false)     ← same turn, 18ms after the answer
messages arriving mid-wait: 0          ← it genuinely blocked
```

Six attempts; this is the first valid one. What made it valid:

1. **Launched by Windows Task Scheduler**, so the process is not a descendant of
   any Claude Code session. That inheritance voided attempts 1–5.
2. **A gated tool with a side effect** (`Write`), not `echo`. See below.
3. **`permissionMode: "default"`** — no other mode consults the callback.

The probe is `scripts/probe-permission.mjs` in the worktree (untracked), run by
`scripts/probe-task.cmd` via the scheduled task `OperatorSdkProbe`. Keep the
task: it is the only known way to get an uncontaminated SDK measurement from
this machine.

### The echo run matters too

The same probe with `echo operator-probe-ok` **failed** — no callback at all.
That is not a contradiction: the SDK auto-approves trivially safe calls without
consulting `canUseTool` (its own types name an "auto-mode classifier").

So a quiet path for harmless commands **already exists, for free**. That is half
of option C below, already built, and it means the pre-allow list only has to
cover the middling cases — not every `ls` and `cat`.

**Do not test permissions with a harmless command.** It measures the classifier,
not the gate.

## The test would have failed for the wrong reason

`OPERATOR_JOB_PROFILE=1` is set in the environment (verified 2026-08-17). That
makes every job run `--permission-mode bypassPermissions`, and
`runner.mjs`'s own measured comment says it plainly:

> `default` is the mode that consults `canUseTool`. […] The other modes decide
> for themselves — `bypassPermissions` allows, `dontAsk` refuses anything not
> pre-allowed.

So with the profile armed, **`canUseTool` cannot fire** — not because the SDK
can't do in-turn permissions, but because the job asked not to be asked. A test
run in that state proves nothing, exactly like the four before it.

**Run the test with the profile OFF.** `OPERATOR_JOB_PROFILE` unset, in a new
shell (see the `setx` note below), so jobs fall back to Claude Code's own
defaults and `permissionMode: "default"` reaches the callback.

## The decision this exposes — the owner's to make

The standing profile and ADR 0012's payoff are **mutually exclusive as
currently built**, and that is a design fact, not a bug:

| | Interruptions | `canUseTool` | What ADR 0012 buys |
|---|---|---|---|
| Profile armed (`bypassPermissions`) | none | never consulted | nothing on permissions |
| Profile off (`default`) | every unapproved tool | consulted, **turn pauses** | the whole ADR |

So "keep the quiet agent" and "get in-turn permissions" cannot both be true of
the same job. The third option is the one the design doc actually proposed under
*Permission profiles*, and only the SDK can reach it:

**`default` mode + a broad pre-allow list.** Ordinary work never prompts because
it is pre-approved; anything outside it pauses the turn and is answerable from
the phone; the deny list still hard-stops `git push` and deletes. That is the
quiet path *and* an escalation that is no longer a dead end.

Reversing ADR 0012 is still the right call if `canUseTool` does not pause a
turn when properly tested. It is **not** the right call on the evidence
collected so far, none of which tested it.

## Invalid attempt #5 — 2026-08-17, logged so nobody repeats it

The probe was run **from inside a Claude Code session** to save the owner the
trouble. It failed — `canUseTool` never fired, `tool_result` arrived 1.5s after
`tool_use` with no pause — and that failure is **worthless as evidence**, for
the same reason as the four before it.

Worth keeping only for what it does establish: **the coupling survives being
spawned as a plain `node` process** from within a session, not just a nested
`claude` invocation. That is now measured twice. Cost $0.42.

The asymmetry is the thing to remember: **contamination can only suppress the
callback, never invent one.** So a PASS from anywhere is trustworthy; a FAIL is
only meaningful from a process that is not a descendant of Claude Code.

## Corrections to the last note

- **The worktree's `jobs.mjs` has NOT diverged from `main`.** `git diff
  main..agent` is four files: `CURRENT.md`, `package.json`,
  `package-lock.json`, and the new `server/runner.mjs`. There are no unreviewed
  Claude-in-Operator edits to `jobs.mjs`. Step 1 of the old test plan is a no-op
  — delete it rather than go looking.
- **Nothing is running.** Ports 5173, 5174 and 5175 are all closed. The test
  needs the server up first.

## SDK surface, checked against what is installed

`@anthropic-ai/claude-agent-sdk@0.3.220`, real `node_modules` in the worktree
(not the junction). Everything `runner.mjs` uses exists in `sdk.d.ts`:
`canUseTool`, `maxBudgetUsd`, `resume`, `disallowedTools`. Both `runner.mjs` and
`jobs.mjs` pass `node --check` with the real binary (v24.12.0).

Two shape mismatches to fix during the wiring, neither blocking the test:

- **`CanUseTool` is `(toolName, input, options)`** and `runner.mjs` takes two
  arguments. The third carries `signal` — which is how a **cancel unblocks a
  pending permission**. Without it, cancelling a job that is waiting for an
  answer hangs until the idle timeout instead of stopping.
- **`bypassPermissions` requires `allowDangerouslySkipPermissions: true`** in
  the SDK (it did not in the CLI). If the wiring ever forwards the profile's
  mode through `runTurn`, it fails until that flag is passed.

## The environment is set up correctly — don't re-do it

```
OPERATOR_JOB_CWD          = D:\Projects\Operator-agent   jobs run in the worktree
OPERATOR_JOB_PROFILE      = 1                            ← turn this OFF for the test
OPERATOR_TERMINAL         = (unset)                      disarmed, as designed
OPERATOR_TERMINAL_DEVICES = tosins-iphone,tosin-pc
OPERATOR_USAGE_BUDGET_USD = (unset)                      no ceiling armed
```

**`setx` only reaches new shells, and the Restart button cannot fix that** — the
supervisor passes its own environment down, so a restart inherits whatever the
supervisor started with. Changing an env var means: Ctrl+C, close the window,
open a new one, `npm run serve`. An hour went into rediscovering this.

## What is already true and verified

- **Step 1 (the job model) is merged and in daily use** — tabs, event log with
  `tool_use`/`tool_result`, cancel, per-job model, restart survival.
- **The SDK runs on the Pro subscription with no API key.** Jobs stay plan
  usage, not metered spend.
- **A plain turn works end to end through `runner.mjs`** — events, session id,
  cost, no error. Only the permission pause is unproven.
- **The worktree genuinely isolates.** `main` has no SDK and still builds.
- **Any SDK test run from inside a Claude Code session is contaminated** — the
  SDK inherits the host session's tools. Clearing every `CLAUDE_*` /
  `ANTHROPIC_*` variable did not break the coupling. The test has to run from
  Operator's own server, which is not a Claude Code child.

## Landmines

- **`git add -A` is banned here** (`CLAUDE.md`). Two writers share this tree.
- **`node` is version-shadowed, not broken.** Both binaries catch syntax errors.
- **`tsc` and `vite build` never read `.mjs`.** A clean build says nothing about
  a server change.
- **The deny list is not a boundary.** `git -C <path> push` ran with zero
  denials; a file was deleted via `node -e`. It is a speed bump against
  accidents. What makes that acceptable is the worktree.

## Next

1. **The owner picks the permission mode** — the fork above. The probe result
   makes option C real rather than theoretical, and the classifier finding means
   it costs less than it looked. This is the only thing blocking the wiring.
2. **Wire `runner.mjs` into `runTurn`**, on `agent`. Fix the two shape
   mismatches noted above as part of it — the third `CanUseTool` argument
   carries the `signal` that lets a cancel unblock a pending permission, and
   without it a cancelled job hangs until the idle timeout.
3. **Then the UI half**: `permission_request` already exists in the event
   vocabulary, but the client currently treats it as a dead end to report. It
   becomes a question with a live answer — which is the whole point.
4. Then uploads (design-doc step 2's surviving half).

## Also landed 2026-08-19 — the Builds card links each build from its own row

`src/components/dev/BuildStatus.tsx`. The card had two ways of saying the same
thing: a footer button offering "the other build", plus an inline *Open it* on
the agent row. The footer worked while there were two builds and stopped when
there were three. Now every row carries its own 44px link, the row you are
reading it on shows a `you` pill instead, and the header chip is gone since the
pill says it in place. `otherUrl`/`agentUrl` are replaced by one `buildUrls()`
that resolves direct-vs-proxied once — mixing them was how a tailnet page ended
up linking to `:5175`, a port the proxy is not listening on.

`tsc -b` and `vite build` both clean; `dist/` rebuilt, so the live URL has it
with no restart. Uncommitted on `main`.

## All three servers run from Task Scheduler now

`OperatorServe` (5174), `OperatorViteMain` (5173), `OperatorViteAgent` (5175),
wrappers in the session scratchpad. **Deliberately not launched from a Claude
Code session** — the probe proved that lineage leaks into everything spawned
beneath it, and jobs from the Claude page would inherit it. Stop one with
`schtasks /end /tn <name>`. Each shows a console window; closing it stops that
server.

## Throwaway files from the probe — safe to delete

- `scripts/probe-permission.mjs`, `scripts/probe-task.cmd` (worktree, untracked)
- `scripts/probe-result.txt`, `scripts/probe-result-echo.txt` — the two runs
- `probe-touch.txt` in the worktree root — what the passing run wrote
- scheduled task `OperatorSdkProbe` — **keep this one** unless the SDK is
  dropped; it is the clean room

## Also open

- **Uploads** (files/images into a job) — an original ask.
- **`server/workspace.mjs`** is dead. Delete it once step 1 has a week of use.
- **Concurrency** and the **usage ceiling** — still undecided, both in
  `CLAUDE.md`. Neither blocks the test.
- **Remote Control** (`claude --remote-control [name]`) — a startup flag, not
  something a running session switches on. Unaudited. This machine holds the
  store, the token and an armable terminal, so what it exposes is worth knowing
  before relying on it.
