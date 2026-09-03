# Current work

Nothing in flight. **`agent` holds one commit that is not on `main` yet** —
`64bfc08`, the failed-job reroute below. It is server-only, so merging it needs
a restart to take effect.

## FIRST THING TO CHECK — it is probably not broken

Speech is **off by default and stored per device**, and the Tauri window is its
own storage profile from the browser. Symptom: Operator answers correctly on
screen and says nothing. The map prints the reply in gold with `muted — tap the
speaker in the chat to hear replies` underneath; if that line is showing, that
is the answer.

## Landed 2026-09-03

**A failed job backs off and reroutes itself** (`64bfc08`, on `agent`).
`server/jobs.mjs` + `server/routing.mjs`; no frontend change, because it reuses
the `routed` and `text` events the chat already renders.

The cooldown only ever helped the NEXT job — the one that was running when a
limit hit died on the spot, and `retry()` reuses `job.provider`, so the tap went
back to the worker that had just said no. On an availability failure
(`limitKind` only; ordinary errors are untouched) the turn now either moves to
another worker with a fresh session, or holds and reruns itself when the window
is up. Two recoveries per job, reset by a successful turn; back-off capped at 30
minutes, so a spent daily quota still fails and says so instead of looking stuck
for six hours.

Two rules worth not reversing: a reroute **never escalates** to a `tools: true`
worker (`executionAllowed` is a fact about a request, not about a job), and a
repo task is never handed to a worker with no filesystem — that is what the new
`needsCode()` in `routing.mjs` decides. Syntax-checked; **not yet exercised
against a real limit**, which needs a worker to actually run out.

**The Knowledge Vault is real and full.** 692 notes · 4,124 links · 7 adrift ·
133 topics. 320 extracted from this repo's own docs, 372 from the ChatGPT
export. 682 are `unverified`, which is correct — every one is a model's reading
of something, two removes from checked. Raising confidence is a human act, and
the Statistics bar measures trust rather than volume so it will actually move.

**The pipeline that filled it**, in order:

- `tools/vault-triage/index.html` — offline, no build, no network. Drag the
  export in, triage by keyboard, export a manifest. 288 conversations, 67 kept.
- `scripts/chat-import.mjs` — reads `keep` and nothing else. Idempotent on
  `conversation_id`, NOT on title: extraction is non-deterministic and a
  title-keyed importer would silently double the vault on a re-run.
- `scripts/knowledge-import.mjs --link --cluster --tidy-topics` — connect,
  consolidate by meaning, merge spellings. Run all three after any import.

**The layer that was missing.** `work.handoffs` — a durable ledger every
finisher writes to. `jobs.mjs` records its own turns; an outside session calls
`work_record`. Operator can now answer "did you get anything from Claude?",
which it previously could not.

**`secret_set`** — set an API key without it reaching any log, event, response
or the store. Refuses `OPERATOR_*`: that namespace is the security boundary,
not configuration.

**The map draws three graphs** — MISSIONS / VAULT / AGENTS — flat or solid,
right-drag turns the camera in solid.

## Two silent failures worth remembering

Both cost hours and neither announced itself.

**The agent worktree was 183 commits behind main.** Every job ran against a
copy of Operator from two weeks earlier — Operator worked that out itself after
failing to find its own capability layer. It also caused every semantic
verification to be run against that worktree's stale diff, days earlier, which
read as a flaky checker. `server/worktree.mjs` now fast-forwards before a turn
when safe and tells the worker in its prompt when it cannot.

**A timed-out delegation returned nothing, not an error.** `runTurn` reports an
abort as `error: null` — deliberately, so Stop is not an error — and a timeout
is an abort. The chat importer logged "0 chars" and moved on, losing whole
windows. Delegated work now asks for `reasoning_effort: "none"` (DeepSeek spent
13,788 characters of reasoning to produce 3,454 of answer), an empty reply is an
error, and the timeout is 420s.

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

## Environment

`AIROUTER_API_KEY`, `OPERATOR_SEMANTIC_PROVIDER=airouter`,
`OPERATOR_SEMANTIC_VERIFY=1`, `OPERATOR_TTS_IDLE_MS=14400000`,
`OPERATOR_FOCUS_SCREEN=1`, `OPERATOR_MAX_CONCURRENT=3`,
`OPERATOR_DEVICE_NAME="Tosin's PC"`.

Four workers: claude-code, gemini, airouter, ollama.

## The restart trap, still true

`POST /api/restart` and `schtasks /End` do NOT reload the environment while the
supervisor survives. Stop all three node PIDs, then
`schtasks /Run /TN OperatorServe`.

## Loose ends

- `stash@{0}` in the agent worktree holds its old `AGENTS.md`, kept rather than
  deleted when the worktree was fast-forwarded. It will conflict with main's
  copy if popped.
- `data/chat-import-done.json` records which conversations were extracted end to
  end. Deleting it makes the next import redo everything.
