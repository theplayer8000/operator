# Knowledge Vault, the import pipeline, and a job that recovers

**Date:** 2026-09-03
**Commits:** `e07cd66` … `4238b35` (plus `6310427`, landed 2026-09-04)
**Previous handoff:** [`2026-09-01-intent-goes-live.md`](2026-09-01-intent-goes-live.md)

## Summary

The Knowledge Vault went from a placeholder the Mission Board had pointed at
since it was built to **692 notes, 4,124 links, 133 topics** — 320 extracted
from this repo's own documentation, 372 from a two-year ChatGPT export that was
triaged by hand before anything was imported. Operator can now answer a question
from what the owner has already worked out instead of re-deriving it at Claude's
rate.

Two things landed alongside it that matter more than they look. **`work.handoffs`**
— a durable ledger every finisher writes to — closed the gap where Operator knew
about jobs it dispatched and nothing about work done by a session it did not
start. And **a failed job now backs off and reroutes itself** rather than dying
on the spot.

## Files modified

The span is large (66 files). The ones that carry decisions:

| File | Change |
|---|---|
| `src/pages/Knowledge.tsx`, `src/hooks/useKnowledge.ts` | the vault — two routes, one page, id only decides what is open |
| `src/lib/search.ts` | **the Search Service boundary ADR 0009 approved by name.** A ranked word scan today, an embedding lookup later, one file changes |
| `tools/vault-triage/index.html` | offline staging viewer for the ChatGPT export. No build, no network, double-click to open |
| `scripts/chat-import.mjs` | reads `keep` and nothing else; idempotent on `conversation_id` |
| `scripts/knowledge-import.mjs` | extract, `--link`, `--cluster`, `--tidy-topics` |
| `server/actions.mjs` | seven Knowledge actions, the work log, `secret_set`, `redactParams` |
| `server/worktree.mjs` | fast-forwards the agent worktree before a turn, or tells the worker it could not |
| `server/delegate.mjs`, `scripts/delegate.mjs` | worker-to-worker hand-down; no tools on the sub-task |
| `server/airouter.mjs` | the fourth worker ([ADR 0016](../decisions/0016-ai-router.md)) |
| `server/routing.mjs`, `server/jobs.mjs` | reroute and back-off on an availability failure |
| `server/index.mjs` | gzip on JSON responses above 1,400 bytes — 627 KB → 195 KB |
| `src/pages/MissionMap.tsx`, `src/components/map/operatorCore.ts` | three graphs (missions / vault / agents), flat or solid, right-drag orbit |

## Architectural decisions

**[ADR 0016 — AI Router](../decisions/0016-ai-router.md).** Flat CHF 39/mo,
Swiss-hosted, OpenAI-compatible with tool calling. **It replaces the LOCAL
model, not Claude**: the 3B Ollama that fits in 4GB was too weak for the
verification it was already doing. Amended the same day to name two additional
data flows explicitly — the source diff `semantic.mjs` sends on every completed
turn, and whole project files handed down by `delegate.mjs` — rather than let
them be inherited from the generic prompt-and-context approval. Audio of him is
still outside it.

**The work log is not the changelog.** The changelog is curated for someone
reading it in a month; `work.handoffs` is every finished turn, by anyone. Both
exist because they answer different questions.

**Delegation is deliberately not a capability action.** Worker-to-worker is not
a data operation, and keeping it out of `actions.mjs` means a delegated worker
cannot delegate onward.

**A reroute never escalates.** `executionAllowed` is a fact about a request, not
about a job, so a rerouted turn cannot land on a `tools: true` worker it would
not have been given in the first place. A repo task is never handed to a worker
with no filesystem — `needsCode()` in `routing.mjs` decides that.

## Technical debt

**Resolved:** the agent worktree drifting silently (183 commits), which had also
been making every semantic verification read a stale diff and look flaky.

**Introduced:** `server/usage.mjs` is large and `runner.mjs` still discards the
SDK's token counts, so Claude's usage records read `reported` where they should
read `derived` (see Next). The reroute path is **not yet exercised against a
real limit** — that needs a worker to actually run out.

## Documentation updated

`CLAUDE.md` (approvals table gained AI Router, Web Push and ntfy-as-relay; the
capability-layer and terminal rules), `docs/decisions/0016-ai-router.md` (new),
`tools/vault-triage/README.md` (new).

## Outstanding issues

- **682 of 692 notes are `unverified`**, which is correct rather than a defect —
  each is a model's reading of something, two removes from checked. Raising
  confidence is a human act and the Statistics bar measures trust rather than
  volume so it will actually move.
- `data/chat-import-done.json` records which conversations were extracted end to
  end. Deleting it makes the next import redo everything.
- `stash@{0}` in the agent worktree holds its old `AGENTS.md`, kept rather than
  deleted when the worktree was fast-forwarded. It conflicts with main's copy if
  popped.

## Recommended next milestone

**`runner.mjs`'s token counts** — five lines, and the highest-value follow-up in
the accounting: until it lands, every Claude usage record is a `reported` figure
sitting where a `derived` one belongs, and ADR 0013's whole argument rests on
that distinction.

## Assumptions & risks

Two failures in this span cost hours each and **neither announced itself** —
both are worth carrying forward as a shape to expect:

- **A timed-out delegation returned nothing, not an error.** `runTurn` reports
  an abort as `error: null` (deliberately, so Stop is not an error) and a
  timeout is an abort. The chat importer logged "0 chars" and moved on, losing
  whole windows.
- **Neither gate reads `server/`.** `tsc` and `vite build` never open a `.mjs`
  file, so a clean build says nothing about a server change. The gzip refactor
  missed two multi-line `json()` call sites and 502'd every route.

## Verification

- [x] `npx tsc -b` clean
- [x] `npx vite build` clean
- [x] Vault, map and Statistics exercised in a browser at desktop width
- [ ] **The reroute path is unverified** — syntax-checked only. It needs a real
      quota exhaustion to exercise, which cannot be forced on demand.
