# CURRENT — work in progress

**Updated:** 2026-08-01
**Branch:** `feat/job-model`
**Rule:** see *"Every piece of work keeps a live handoff"* in `CLAUDE.md`.
Overwrite this file as work proceeds; fold it into a dated handoff at a
milestone and reset it to the template at the bottom.

## What this is

Design-doc **step 1** — the job model. Replacing the single in-memory
conversation (`server/workspace.mjs`) with jobs that have an append-only event
log, so a turn is no longer bounded by an HTTP request and the owner can watch
what Claude is doing instead of a spinner.

`server/jobs.mjs` (867 lines) was written by Claude running inside Operator. It
landed on `main` by accident inside a commit labelled as docs, was reverted
forward in `6ccb199`, and preserved whole on this branch. **The server half was
complete; the frontend was not** — that mismatch is why `main` had to be
reverted: with `jobs.mjs` loaded, `/api/chat` 404s and the Claude page dies.

## Done on this branch

- **`src/hooks/useJobs.ts`** (new) — the feature hook. Polls `/api/jobs` for the
  tab strip and `/api/jobs/:id?since=N` for the selected job's events, by
  offset, same as the terminal reads command output. Fast tick while something
  runs, slow when idle, plus a re-read on `visibilitychange`/`focus` so an
  iPhone returning from suspend catches up.
- **`src/components/dev/ClaudeChat.tsx`** — rewritten against the job API. Tab
  strip, event log rendering the full vocabulary (`prompt`, `text`, `tool_use`,
  `tool_result`, `permission_request`, `status`, `usage`), cancel button while
  running, per-job model picker, restored-job marker.
- **Fixed the `pump()` stall** in `jobs.mjs`. `pump()` shifts a job off
  `waiting` before calling `runTurn`, and both of `runTurn`'s early exits
  (budget ceiling hit, `claude` not on PATH) returned without restarting the
  queue — so one job failing to start silently stopped every other queued job.
  Re-pump is deferred via `queueMicrotask` because the budget check runs before
  any `await` and a direct call would re-enter `pump()` from its own frame.
- **Stale footer copy** — the old one still said "Transcript is in memory" and
  that New chat "starts a fresh one rather than deleting anything". Both stopped
  being true in M15.

## Not done

- **Not merged.** `main` is still on `workspace.mjs` and works.
- **Not exercised.** `tsc -b` and `vite build` are clean; nothing has been run
  against a live server yet. **Do not merge on the strength of a clean build** —
  that is exactly what put a half-migration on `main` the first time.
- **An adversarial review of `jobs.mjs` is running** (5 lenses, findings
  refuted before reporting). Results were not in when this was written.
- **Three "decisions" recorded in `jobs.mjs` comments are unconfirmed.** It
  quotes the owner on job history, concurrency and the usage ceiling. The quotes
  are real comments in the file, but the conversation they came from is gone and
  the owner has **not** confirmed them. Do not write them into `CLAUDE.md` as
  settled until he does.
- **Permission profiles** — genuinely still open. They only become meaningful at
  step 2, so they don't block this.

## Landmines

- **Checking out this branch changes `server/index.mjs`.** A running server
  keeps working because it already loaded the old code — but a **Restart** will
  load `jobs.mjs`, and until the frontend here is merged too, `/api/chat` 404s
  and the Claude page goes blank. Branch and frontend must move together.
- The permission allow list had five standing grants to `rm` / `git rm`
  `server/workspace.mjs` and `src/components/dev/ClaudeChat.tsx`, from the
  migration attempt. Removed 2026-08-01. Worth re-checking; it only ever grows.

## Next

1. Read the review findings; fix what survives refutation.
2. Run it against a live server — start a job, watch `tool_use` events arrive,
   cancel one, restart mid-job and confirm the restored tab resumes.
3. Confirm the three decisions with the owner, then update `CLAUDE.md`.
4. Merge, fold this file into a dated handoff, reset to the template.

---

## Template

```markdown
# CURRENT — work in progress

**Updated:**
**Branch:**

## What this is
## Done
## Not done
## Landmines
## Next
```
