# 0016 — AI Router, and what it replaces

**Status:** Accepted 2026-09-02
**Relates to:** [ADR 0009](0009-permitted-abstraction-boundaries.md) (the provider
boundary this arrives through), [ADR 0012](0012-claude-agent-sdk.md),
[ADR 0013](0013-usage-accounting.md), and `CLAUDE.md`'s external-application rule

## Context

Operator has three workers. One of them is a problem.

**Ollama runs a 3B model because 4GB of VRAM says so**, and it is measurably too
weak for the work it is already given. Semantic verification scores two out of
three and has hallucinated agreement outright — recorded in `semantic.mjs` and
in ADR 0014's reasoning for why a local model must not be trusted to write
intent rules. The local worker is not failing at something aspirational; it is
failing at its current job.

The obvious fix is a bigger local model, and it is blocked on hardware: a
12–16GB card, which is not bought.

## Decision

**Adopt AI Router (`api.airouter.ch`) as a fourth worker. It replaces the LOCAL
model, not Claude.**

CHF 39/month flat. Swiss-hosted. Two models — `DeepSeek-V4-Flash` (284B MoE,
13B active) and `Qwen3.8` (27B dense, FP8), both 262K context, **both with tool
calling**, which is the capability that makes an OpenAI-compatible endpoint
useful here rather than merely present.

### Why it fits without touching anything

`server/providers.mjs` exists so a worker is registered or not
([ADR 0009](0009-permitted-abstraction-boundaries.md)). This is one new file
implementing the same `runTurn` contract `gemini.mjs` already implements, plus
four lines of registration. Nothing in `jobs.mjs`, the capability layer, or the
frontend changed.

That is the boundary paying for itself, and it is worth noting because ADR 0009
warned against *extending* a permitted boundary. This does not extend it — it
occupies it exactly as designed.

### What each worker is for now

| Worker | For | Marginal cost |
|---|---|---|
| **claude-code** | judgement — reading a diff, deciding if work is correct, anything touching source | free on Pro |
| **airouter** | volume, routing, semantic verification, long unattended runs | free within a flat rate |
| **ollama** | kept for the one capability nothing else has: **it works with no network** | free |
| **gemini** | now redundant. Not removed, because removing a worker is not urgent | free, quota-capped |

**Claude keeps the judgement work and that is the point.** Its marginal turn is
already free on the Pro subscription and its verification is the one that is
trusted. Nothing here is an argument for using it less.

### What leaves the machine

The prompt and whatever job context is attached, to a host in Switzerland. Same
class as the Gemini approval on 2026-08-20, so it is the same decision made
again rather than a new category.

`tools: "capability-actions"` — it reaches `server/actions.mjs` and nothing
else. No filesystem, no shell. Every tool call is something the owner could
already do through a page.

### Amended 2026-09-02 — source diffs, named explicitly

The wording above is "the prompt and whatever job context is attached",
inherited from the Gemini approval. **Two callers added since then send
something that wording does not honestly cover, and they are approved here by
name rather than by proximity.**

- **`semantic.mjs`** — the owner's SOURCE DIFF, on every completed turn,
  automatically. That file was written with the switch off by default for
  exactly this reason.
- **`delegate.mjs`** — whole project files, whenever the dispatching worker
  hands a read down.

Approved on the measurement rather than on principle. Same task, same file, same
prompt: the local 3B took **101.7s** and named two of the five environment
variables; `DeepSeek-V4-Flash` took **6.8s** and named all five. On the earlier
semantic-verification benchmark the local model returned `unsure` in 41.0s and
described the change as "a comment"; the router returned the correct `mismatch`
verdict in 3.4s. A checker that is usually wrong is not a cheaper checker, it is
a decoration.

**What this does NOT approve.** Audio of him — Whisper, TTS — remains outside
it. Deepgram, ElevenLabs and iOS `SpeechRecognition` were each refused on the
grounds that a recording of a person is a different category from text he chose
to send, and moving Whisper here needs its own clause, written before the code.
Files outside the project are refused in `delegate.mjs` itself, so that half of
the boundary is enforced rather than merely stated.

**The revocation is one variable.** `OPERATOR_SEMANTIC_PROVIDER=local` puts
verification back on the box; `--worker ollama` does the same per delegation.

## The risks, recorded because they are real

**No named legal entity.** The site carries "© 2026 AI Router Switzerland" and
`support@airouter.ch`. No address, no company registration, no SLA, no uptime
claim. This is CHF 39 that can be lost, not a dependency to build on.

**Flat-rate unlimited inference is economically aggressive.** A provider doing
this is either burning runway or will change terms. **Plan for the terms to
change**, and keep Ollama registered so there is a floor.

**"No prompt logging" is a policy, not a property.** Everything else private in
Operator is private *structurally* — Ollama cannot leak because nothing leaves
the box. This is a promise from an unnamed operator, and it is a weaker kind of
assurance. It is accepted knowingly.

**Fair use is warning-first**, which is better than a hard cutoff: 3 parallel
requests, 240/min, 10M tokens/min, no daily or monthly cap. The parallel limit
is exactly `OPERATOR_MAX_CONCURRENT`, by coincidence.

## How this lands in the accounting

[ADR 0013](0013-usage-accounting.md) turns out to have been designed for exactly
this case, which is worth noticing.

A flat rate has **no per-token cost**, so reporting `$0.00` would be the precise
mistake that ADR is written to prevent — a real zero and an unknown wearing a
digit are different things. Records carry `basis: "billed"` with a **null**
cost: paid for, monthly, and the number is not per turn.

**The ceiling that can actually govern this provider is the quota ledger, not
the dollar one.** That is why the two are separate, and this is the second
provider (after Gemini's request-per-day free tier) where a dollar meter would
show headroom on something that has none.

## Consequences

**Good.** The weakest worker's jobs move to a model an order of magnitude
larger, at no marginal cost. Semantic verification and routing get a real chance
of being right. Long unattended runs stop being a thing to think about.

**Bad.** A fourth provider to keep working, and a dependency on a small
operator with no stated legal identity. The privacy posture is weaker than
anything else here, by choice.

**Unresolved.** `runner.mjs` still discards the SDK's token counts, so Claude's
records are `reported` rather than `derived`. That is unrelated to this ADR and
remains the highest-value follow-up in the accounting.

## What would change this

**The terms changing**, which should be expected rather than treated as a
betrayal. Ollama stays registered as the floor.

**A 12–16GB card.** A capable local model removes most of the argument: the
reason this was adopted is that the local one is too small, and that is a
hardware fact rather than a permanent one.

**Needing a model neither of these two provides.** This is a two-model router,
not a gateway. `requesty.ai` (5% markup) and `inworld.ai` (pass-through, zero
markup) were both looked at on 2026-09-02 and are a different product — they
route to everything and still charge per token, so they solve breadth rather
than cost.
