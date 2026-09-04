# Current work

**The handoff is now a capability action, so every worker can keep it.** On
`main` and **live** — the server was restarted at 00:36 on 2026-09-04 and the
actions answer through `scripts/operator-action.mjs`. This note was written by
`handoff_write`.

The previous milestone is folded into
[`2026-09-03-vault-pipeline-and-reroute.md`](2026-09-03-vault-pipeline-and-reroute.md).

## FIRST THING TO CHECK — it is probably not broken

Speech is **off by default and stored per device**, and the Tauri window is its
own storage profile from the browser. Symptom: Operator answers correctly on
screen and says nothing. The map prints the reply in gold with `muted — tap the
speaker in the chat to hear replies` underneath; if that line is showing, that
is the answer.

## Landed 2026-09-04

**`server/handoff.mjs` + four actions** — `handoff_read`, `handoff_write`,
`handoff_fold`, `handoff_list` (`20a9683`). The rule requiring this file has
been in CLAUDE.md since restarts became routine, and it was followed roughly
never. Three structural reasons, none of them "remember harder":

1. **Three of the four workers have no filesystem.** `gemini`, `airouter` and
   `ollama` run capability-actions-only. They finish work too, and had no way to
   leave a note about it. A rule one worker in four can obey is not a rule.
2. **The one worker that does have a filesystem writes the wrong copy.** Jobs run
   in the `agent` worktree; the Updates page renders `main`'s. A handoff written
   by a job was invisible on the phone until someone merged a branch — which
   defeats the only thing this file is for. `handoff.mjs` resolves paths from its
   own location, never `process.cwd()`, so it always writes the served copy.
3. It needed a path remembered and a naming convention followed at the end of a
   long turn. `operator-action.mjs` is already pre-allowed and already validated.

This is the **one place the capability layer touches a file rather than the
store**, and it must not become a general file-writing action: the paths are
fixed, the names are validated, and nothing takes a path from a caller. There is
deliberately no delete.

**`scripts/land.mjs`** (`npm run land`, `6310427`) — written by Claude inside
Operator, reviewed and committed from the desk. Merges `agent` → `main` and then
does the *right* one of build / restart, which is the decision CLAUDE.md's table
describes and the one that fails silently when done by hand. Refuses a
non-fast-forward, refuses a main checkout with uncommitted tracked changes,
never pushes.

**Two defects fixed along the way.**

- The `mission` guidance added to the job system prompt on 09-03 was spliced
  into the middle of another sentence, so every worker was reading "…`needsOwner:
  true` ONLY when he actually PASS `mission` when the work belongs to one…".
- `operator-action.mjs` printed "Is the server running?" after *every* failure,
  including a rejected parameter — sending a worker to check infrastructure when
  the line above had already told it what to fix (`42c27eb`).

## Verified

- All four actions through `scripts/operator-action.mjs` against the live
  server, after the restart.
- Refusals: `../evil` and `docs/handoffs/x.md` as a slug, an unknown handoff
  name, an empty body, and folding onto an existing dated file.
- `npx tsc -b` and `npx vite build` clean; `node --check` on every changed
  `.mjs` with the real `node.exe`, not the shim on PATH.
- **A bug this found in its own first version:** the slug sanitiser silently
  rewrote `../evil` to `evil`. It could not escape the folder — the character
  class saw to that — but a caller who passed a path got a file somewhere else
  with no indication anything had been reinterpreted. It now refuses and names
  the offending character. Whitespace and underscores are still tidied, because
  those are formatting rather than intent.

## Not verified

No worker has yet been observed calling these on its own initiative. The prompt
now names them; whether that is enough is the thing to watch on the next few
jobs.

## Next

**Runway, for GENERATING video** — his ask, and a new external host, so it needs
a named row in CLAUDE.md's approvals table first: the endpoint, and that an
image-to-video call sends an image he supplies. Likely a capability action
rather than a `runTurn` worker, since generation takes minutes and is not a
conversation. Key goes in with `secret_set`.

**`runner.mjs` still discards the SDK's token counts** — five lines, and still
the highest-value follow-up in the accounting. Claude's records read `reported`
where they should read `derived`.

**RAM.** 2×8GB DDR4-3000 for £40 was checked and is compatible — DDR4 board,
2 free slots of 4, takes him to 32GB. It will run at 2400 (mixed speeds drop to
the slowest) so it buys capacity, not speed. That is the point: 32GB means
Kokoro and Whisper stay local and **ADR 0016 never needs an audio clause**.

**The bundle is one 941 kB chunk** (266 kB gzipped) and Vite says so on every
build. Not urgent over a tailnet, and the fix — lazy-loading the heavy routes,
`MissionMap` above all — is a `src/` change worth doing deliberately rather than
in passing.

## Environment

`AIROUTER_API_KEY`, `OPERATOR_SEMANTIC_PROVIDER=airouter`,
`OPERATOR_SEMANTIC_VERIFY=1`, `OPERATOR_TTS_IDLE_MS=14400000`,
`OPERATOR_FOCUS_SCREEN=1`, `OPERATOR_MAX_CONCURRENT=3`,
`OPERATOR_DEVICE_NAME="Tosin's PC"`.

Four workers: claude-code, gemini, airouter, ollama.

## The restart trap, still true

`POST /api/restart` and `schtasks /End` do NOT reload the environment while the
supervisor survives. Stop all three node PIDs, then
`schtasks /Run /TN OperatorServe`. (A pure *code* change is fine over
`/api/restart` — that is what was used here.)

## Loose ends

- `main` is **five commits ahead of `origin/main`** (including this one) and this
  session cannot push.
  `git push origin main` when you are back.
- `stash@{0}` in the agent worktree holds its old `AGENTS.md`, kept rather than
  deleted when the worktree was fast-forwarded. It will conflict with main's
  copy if popped.
- `data/chat-import-done.json` records which conversations were extracted end to
  end. Deleting it makes the next import redo everything.
- `.agents/skills/` is untracked in the main checkout — six skill files, left
  alone rather than swept into a commit.
