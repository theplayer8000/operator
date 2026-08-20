# 0013 — Usage accounting: tokens are the record, USD is derived, and "cost" is three different things

**Status:** Accepted
**Date:** 2026-08-20
**Depends on:** [ADR 0009](0009-permitted-abstraction-boundaries.md) (the
provider boundary these records are keyed by),
[ADR 0012](0012-claude-agent-sdk.md) (the SDK that reports the Claude numbers).
**Supersedes:** the `OPERATOR_USAGE_BUDGET_USD` counter in `server/jobs.mjs`,
which sums one number that does not mean one thing.
**Relates to:** [`docs/ai-workspace-design.md`](../ai-workspace-design.md)
(open question 4, "should a job have a token or cost ceiling").

## Context

Operator reported **≈$40 of Claude usage on 2026-08-20**, and the honest answer
to "is that money?" is *it depends on a fact Operator cannot see*. That is the
problem this ADR exists to fix — not the budget itself, which is easy once the
accounting is right.

The existing mechanism is a single accumulator: `spentUsd += result.costUsd`,
compared against `OPERATOR_USAGE_BUDGET_USD`. It is unset, and shipping it as-is
would have made a confident number out of four incompatible ones.

### Four things currently collapsed into "cost"

1. **Tokens** — raw consumption. Input, output, cache reads, cache writes, and
   reasoning tokens where the model has them.
2. **Cost** — provider- and model-specific USD derived from those tokens.
3. **Quota** — a provider's own restriction, like Gemini's requests-per-day.
   Not money, and not correlated with money.
4. **Budget** — Operator's policy about what it is willing to spend.

Today's data shows why conflating them fails. On the same day Operator recorded
**$40 against Claude** (which hit no limit) and **$0.00 against Gemini** (which
became completely unusable, having spent all 20 of its daily requests). A meter
that only knows dollars reported plenty of headroom on the provider that had
none left.

### What each worker actually reports — audited 2026-08-20

| | Claude Code (SDK) | Gemini | OpenAI (planned) |
|---|---|---|---|
| input / output tokens | yes, exact | `promptTokenCount` / `candidatesTokenCount` | `usage` block |
| cache split | read **and** creation, separately | `cachedContentTokenCount`, only when used | `prompt_tokens_details.cached_tokens` |
| reasoning tokens | inside output | **`thoughtsTokenCount`, a separate field** | `completion_tokens_details.reasoning_tokens` |
| USD | `total_cost_usd` — but see below | never | never |
| per-model breakdown | `modelUsage`, keyed by model | no | no |

**The SDK already hands us the whole record and `runner.mjs` throws it away.**
It reads `total_cost_usd` and drops `usage` and `modelUsage` on the floor. The
`ModelUsage` shape is:

```
inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens,
webSearchRequests, costUSD, contextWindow, maxOutputTokens,
canonicalModel, provider ('firstParty' | 'bedrock' | 'vertex' | …)
```

which is the proposed record almost field-for-field. Collection is a five-line
change; the decisions worth writing down are what it *means* and where it goes.

**`thoughtsTokenCount` is a trap worth naming.** Gemini reports reasoning
separately from output, and it is not small — measured, a one-word
classification spent **61 thinking tokens** and returned one. Summing
`candidatesTokenCount` alone undercounts a thinking model by an order of
magnitude.

### The $40, specifically

`total_cost_usd` is computed **locally by Claude Code**: token counts times a
built-in price table keyed by `canonicalModel`. It is what the turn would have
cost at API list price. The SDK authenticates against the Pro subscription
(ADR 0012, verified with no API key present), so no per-turn API charge occurs
— and the number is reported identically either way.

But the owner has **usage credits enabled**, so overflow past plan limits *is*
charged. Therefore:

- under plan limits, $40 is **notional** — a proxy for plan consumption;
- past them, some portion is **real** — and Operator cannot tell which portion,
  because it cannot read plan headroom. There is no `claude usage` subcommand
  and `/usage` is interactive-only.

One number, two meanings, no local way to distinguish them.

## Decision

### 1. Tokens are the stored record. USD is derived.

Persist raw token counts, plus the price-table version used to value them. A
pricing correction then becomes a re-derivation over history rather than a
number that is silently wrong forever. Storing only USD makes a mispricing
permanent.

### 2. Every record carries a `basis`, and aggregates refuse to cross it

```
"billed"     real API spend against a key
"valuation"  subscription work, priced at API-equivalent list
"unpriced"   tokens known, no price table for this model
```

`$40 valuation + $0.30 billed = $40.30` is a meaningless number, and it is
exactly what a naive `SUM()` produces. Summing across bases is a bug, not a
formatting choice — the aggregate returns a figure **per basis** or refuses.

`unpriced` must never aggregate as zero. Gemini currently returns a hardcoded
`costUsd: 0`, which is honest for a free tier and becomes a silent lie the day
billing is added to that Google project.

### 3. Quota is a second ledger, not a cost

Requests-remaining-per-window, per provider, recorded from what the provider
says (Gemini's `quotaId` distinguishes `PerDay` from a burst limit — already
used in `server/gemini.mjs` to tell a spent day from a busy minute). A provider
can be **out of quota while under budget**, which is precisely what happened on
day one, and routing must be able to see that.

### 4. Storage is an append-only `data/usage.jsonl`, not `operator.json`

One record per turn grows without bound, and `operator.json` is read whole into
memory on every load (`server/store.mjs`). A separate append-only file matches
the event-log pattern `jobs.mjs` already uses, survives restarts, aggregates
trivially, and rotates monthly. It is gitignored with the rest of `data/`.

### 5. Three ceilings, in this order

1. **Per-job** — the runaway guard, and the only one that can stop a loop
   *mid-turn*. The SDK takes `maxBudgetUsd` natively; `runner.mjs` already
   plumbs it through and it is currently unset. Highest value, least new code.
2. **Per-provider** — because routing exists specifically to funnel work, so
   funnelling everything into the expensive worker is a likely failure, not a
   remote one.
3. **Global daily** — last, and weakest alone: it cannot distinguish valuation
   from spend, so on a subscription it is a plan-consumption proxy wearing a
   currency symbol.

### 6. Routing considers a price *band*, not an estimated cost

The tempting chain is `intent → capabilities → eligible → estimated cost →
policy → provider`. The weak link is estimating a turn's cost before running
it: cost is dominated by how many tool iterations it takes, which is the thing
that cannot be known up front. Estimating it produces a confident number
derived from a guess.

So: route on **capability first, price band second** (cheap / standard /
expensive as a static property of a model), and let the per-job ceiling catch
what estimation cannot.

### 7. Record time and turns alongside tokens

`duration_ms` and `num_turns` are already on the SDK result. The real defect
found on 2026-08-20 — 129 seconds, nine permission prompts and $0.92 to answer
"what's my gym session today" — was invisible to a dollar meter and obvious in
wall-clock and turn count. **Cost-per-answer is what catches "this worked but
was stupid."**

## What this rejects

- **A universal "credits" unit.** Providers price input, output, caching,
  reasoning and tools differently; one synthetic unit would have to pick an
  exchange rate, and that rate would be wrong per model and drift per pricing
  change. If credits are ever wanted, they are a **display** abstraction over
  USD, never the stored value.
- **Shipping `OPERATOR_USAGE_BUDGET_USD` as it stands.** Not because a budget
  is wrong, but because this one sums a number whose meaning varies, and a
  ceiling that stops work for a reason it cannot explain is worse than none.
- **Presenting any figure as plan usage.** The counter can only ever total
  *Operator's own* consumption. Labelled "you are at N%", it would be a number
  that looks authoritative and is not — the same failure the design doc already
  warns about for the same reason.

## Consequences

**Good.** The full record is already available and free to collect. Per-job,
per-provider and per-day answers all fall out of one append-only file. A
mispriced model is fixable retroactively. The valuation-versus-spend ambiguity
becomes explicit in the data instead of living in a comment.

**The cost.** A second persisted shape, with rotation and a price table to keep
current — the price table is the part that rots, and a stale one produces
plausible wrong numbers rather than obvious ones. Mitigated by storing tokens
and the table version, so it is always re-derivable.

**Still unsolved, and unsolvable locally:** whether a given Claude turn was
billed or absorbed by the subscription. Operator cannot see plan headroom. The
`basis` field makes the ambiguity visible; it does not remove it. If that
number ever needs to be exact, it has to come from the provider's own billing
API, not from arithmetic here.

## What would change this

**A provider billing API worth calling.** If Anthropic (or any provider here)
exposes actual charges per key or per plan, the `valuation` basis stops being
a necessary fiction for that provider and those records should become
`billed` from the source rather than derived locally. That is the one change
that would make a global dollar ceiling genuinely meaningful.

**All workers on metered API keys.** The valuation/billed split exists because
one worker runs on a subscription. If Claude Code ever runs on an API key here
— or the subscription path disappears — every record becomes `billed`, the
distinction collapses, and a large part of this ADR becomes unnecessary
ceremony. Simplify it then, deliberately, rather than carrying the split out of
habit.

**Evidence that the price table is rotting.** If a recorded `valuation` is ever
found materially wrong against a provider's published prices, that is the
signal that storing tokens was the right call — re-derive history rather than
patch the totals, and treat a stale table as the expected state rather than a
surprise.

**Per-turn cost estimation becoming possible.** Section 6 rejects it because
tool-iteration count is unknowable up front. If a provider ever returns a
reliable pre-flight estimate, or measured history makes a per-intent estimate
trustworthy, cost-aware routing can move from a static price band to a real
estimate — but only on evidence, not on the assumption that a number is better
than a band because it has decimals.
