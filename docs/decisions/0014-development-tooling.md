# 0014 — Which Claude Code plugins Operator uses, and which it refuses

**Status:** Accepted
**Date:** 2026-08-22
**Relates to:** [ADR 0009](0009-permitted-abstraction-boundaries.md) (the
provider boundary these must not cross), [`threat-model.md`](../threat-model.md),
and `CLAUDE.md`'s external-application rule.

## Context

Five Claude Code plugins are installed —
`42crunch-api-security-testing`, `agent-sdk-dev`, `claude-md-management`,
`greptile`, and `frontend-design`. This records which are used, which are
refused, and why, so the question is not re-opened per session and a future
one does not adopt something on the grounds that it is already installed.

### The distinction that decides most of it

**A Claude Code plugin changes how the agent *building* Operator behaves. It
never becomes something Operator can do.**

This matters more than it first appears, because it interacts with the rule
that workers produce intents and the capability layer executes them. **A plugin
is on the wrong side of that boundary by construction** — it hands one specific
model a direct integration. Gemini cannot use a Claude Code plugin; neither can
a future GPT worker or a local Qwen. So anything Operator itself needs belongs
in `server/actions.mjs`, reachable by every worker, never in a plugin.

The test for each plugin is therefore *"does this help build Operator?"* and
never *"does this give Operator a feature?"*

## Decision

### Used

**`claude-md-management` — the audit only, never the auto-fix.**
`CLAUDE.md` is 54KB and is the entry point every agent reads. On 2026-08-21 a
hand audit of it found 23 stale line references, a feature table describing
shipped work as pending, and — in `roadmap.md` — the claim *"there is no
authentication; the tailnet is the boundary"*, which stopped being true at
[ADR 0010](0010-tailnet-identity-authentication.md) and is the sort of line
someone acts on. Automating that audit is worth having.

**It writes to `CLAUDE.md`, and that is where the caution is.** The file's
value is its hard-won specifics: the `git add -A` ban, the external-approval
rule, "never present it as plan usage". An automated tidy that generalises a
rule into ordinary advice costs more than the staleness it fixes. Read the
report; apply changes by hand.

**`security-review` (built-in).** Local, no account, no external service, reads
diffs. Given [`threat-model.md`](../threat-model.md) states outright that there
is no sandbox and the terminal runs as the owner, and that auth-adjacent code
has been moving quickly, this is the cheapest real safety net available.

**`agent-sdk-dev` — the verifier agents only.** `/new-sdk-app` scaffolds a new
project and is irrelevant to a working one. The verifiers check an SDK
application against official patterns, and `server/runner.mjs` was written by
hand against `sdk.d.ts`: three genuine deviations were already found by
accident (`thinkingConfig.thinkingBudget`, the three-argument `canUseTool`,
`allowDangerouslySkipPermissions`). Run as a review, not adopted as a
dependency.

**`frontend-design`** — already in use, unchanged by this ADR.

### Refused

**`greptile` — no.** Two independent reasons, either sufficient.

Operator has **no pull requests**: work goes worktree → `agent` branch → merge
→ push, and Greptile reviews PRs. There is nothing for it to review.

And it **indexes the repository on their servers** — the entire source of a
system holding the owner's calendar, gym history, missions and homelab shape,
sent to a third party, to support a workflow that does not exist here. Under
`CLAUDE.md`'s external-application rule that requires a named approval; it does
not earn one.

**`/review` (built-in)** — a GitHub PR reviewer, same absent workflow. Use
`/code-review` against the working diff instead.

**`run` (built-in)** — would fight the launch setup rather than help it.
Operator's arrangement (Task Scheduler, supervisor, three builds, a worktree)
is deliberate and documented across two ADRs; a generic "start the app" skill
knows none of it.

### Deferred, with the reasoning recorded

**`42crunch-api-security-testing` — not now, and the reason is about to
change.** Its flagship capability is BOLA/BFLA: broken *object-level*
authorization, where user A reads user B's records. Operator has one user and
no object-level scopes, so the headline feature has nothing to test. It also
needs an account, a downloaded binary, and an OpenAPI spec that does not exist
— and an OAS describing the whole API surface is itself an external disclosure.

Meanwhile the risks the threat model actually names — no sandbox, terminal runs
as the owner, tailnet as the boundary — are not findable by an OAS scanner.

**This verdict is conditional and the condition is now in sight.** See
[`control-plane-design.md`](../control-plane-design.md): a second person with
access makes object-level authorization real for the first time, and at that
point this moves from "unnecessary" to "the obvious tool". `generate-oas` also
becomes worth running then, because a second user means the API surface needs
documenting rather than remembering.

## What this suggests changing in Operator itself

Two ideas came out of the audit that are not about adopting anything.

**Verification should be a stage with a tool, not a field.** Every job records
`verification: { requested: true, status: "not-run" }` and it has never once
been anything else. 42Crunch's `audit → scan → remediate → validate` loop is a
reminder of the shape: the cheapest honest version here is that a job which
changed code is not "complete" until `npx tsc -b` and `npx vite build` have
run — already the rule in `CLAUDE.md`, currently enforced by convention rather
than by the job model.

**Structured output between stages, not prose.** Claude Code's own `Workflow`
tool passes schema-validated JSON between pipeline stages and defaults to
pipelining rather than barriers. `control-plane-design.md` §3 proposes
multi-worker jobs whose `handoff` currently carries prose and a status.
Schema-checking that is the difference between orchestration and hoping.

## Consequences

**Good.** Three tools adopted at zero dependency cost — all read-only or
report-first, none reachable from Operator's runtime, none touching the
provider boundary. The refusals are recorded with reasons, so "it's already
installed" cannot become an argument later.

**The cost.** `claude-md-management` needs discipline: its value is the report,
and the temptation is to accept the diff. A rule softened by an automated pass
would be found much later than a stale line number.

**Unresolved.** Nothing here helps see the app on a phone, which is where the
last several UI defects were found and where no installed tool reaches.
`claude-in-chrome` could, and is deliberately left for a separate decision
because it drives the owner's real browser session.

## What would change this

**A second person with access** — already coming. It makes 42Crunch's
object-level testing meaningful and turns an OpenAPI spec from documentation
into a contract. Revisit both then.

**Adopting pull requests.** If review ever moves to PRs rather than a worktree
merge, `greptile`'s workflow objection disappears — though the
whole-repository-indexing objection does not, and that one is the stronger of
the two.

**Any plugin that claims to give Operator a capability.** That is the signal
something has been misread: capabilities belong in `server/actions.mjs` where
every worker can reach them. A plugin that appears to offer one is offering it
to Claude Code alone.
