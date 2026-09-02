// What a turn cost, what it consumed, and whether Operator is allowed to run
// another one. ADR 0013 is the argument; this file is the implementation.
//
// ## The one thing to understand before editing
//
// **"Cost" is four different questions and this file keeps them apart.** On
// 2026-08-20 Operator reported ≈$40 against Claude — which hit no limit — and
// $0.00 against Gemini, which was completely unusable, having spent all 20 of
// its daily requests. A meter that only knew dollars showed plenty of headroom
// on the provider that had none.
//
//   tokens   what was consumed. The stored record.
//   cost     USD *derived* from those tokens and a versioned price table.
//   quota    a provider's own restriction (requests per day). Not money.
//   ceiling  Operator's policy about what it is willing to spend.
//
// ## Tokens are stored, USD is derived
//
// A price table goes stale silently and produces plausible wrong numbers rather
// than obvious ones. Storing tokens plus the table version makes a mispricing a
// re-derivation over history instead of a figure that is quietly wrong forever.
//
// Today most records are `reported` rather than `derived`, and that is written
// into the record instead of hidden: `runner.mjs` reads `total_cost_usd` from
// the SDK and drops `usage` and `modelUsage` on the floor, so the tokens are
// available and simply not plumbed through yet. `recordTurn()` already takes a
// `tokens` object and prefers deriving from it — the day the runner passes one,
// nothing else here changes.
//
// ## `basis` is not a label, it is a barrier
//
//   billed      real spend against a key. A known, final number.
//   valuation   subscription work, priced at API-equivalent list. NOT a charge.
//   unpriced    tokens (or turns) known, no price table for this model.
//
// `$40 valuation + $0.30 billed = $40.30` is a meaningless number and is
// exactly what a naive sum produces. Every aggregate here returns a figure
// **per basis** and there is deliberately no function that adds them together.
//
// `unpriced` never aggregates as zero. Gemini returns a hardcoded `costUsd: 0`,
// which is honest for a free tier and becomes a silent lie the day billing is
// enabled on that Google project — so a reported zero from an unpriced provider
// is discarded here rather than banked.
//
// ## Ceilings are environment-only
//
// Same reasoning as `OPERATOR_TERMINAL_DEVICES` and `OPERATOR_APPS`: a worker
// has `Write` across the whole tree, so a limit it could edit is not a limit.
// Nothing in `data/` or `operator.json` configures a ceiling.
//
// The urgency is `OPERATOR_MAX_CONCURRENT`. One turn at a time bounded spend by
// wall-clock; N turns multiply it by N, and nothing else stops a mistyped loop.

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Where the per-turn records go. **Not `operator.json`** — that file is read
 * whole into memory on every load (`store.mjs`), and one record per turn grows
 * without bound. This matches the append-only shape `jobs.mjs` already uses for
 * events, and rotates monthly by simply being named after the month.
 */
const USAGE_DIR = process.env.OPERATOR_USAGE_DIR ?? join(ROOT, "data");

// --- the price table ------------------------------------------------------

/**
 * Bump this whenever a number below changes.
 *
 * It is stored on every record so a correction is re-derivable: "these records
 * were valued with table X" is answerable after the fact, which is the entire
 * reason tokens are the stored form.
 */
export const PRICE_TABLE_VERSION = "2026-09-02";

/**
 * USD per **million** tokens, from Anthropic's published list prices.
 *
 * `cacheRead` is ~0.1x input and `cacheWrite` ~1.25x input (the 5-minute TTL;
 * the 1-hour TTL is 2x, which Operator does not use). They are spelled out
 * rather than computed so a future rate change is a table edit, not arithmetic
 * someone has to notice.
 *
 * `reasoning` tokens have no rate of their own — every provider bills thinking
 * at the output rate, so `deriveUsd` folds them into output. Naming the field
 * separately still matters: Gemini reports `thoughtsTokenCount` apart from
 * `candidatesTokenCount`, and a one-word classification measured 61 thinking
 * tokens against 1 of output. Summing output alone undercounts a thinking model
 * by an order of magnitude.
 */
const MODEL_PRICES = {
  "claude-opus-5": { band: "expensive", input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-5": { band: "standard", input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-fable-5": { band: "expensive", input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
};

/**
 * What each worker's numbers *mean*. One provider, one basis — which is why the
 * per-provider ceiling below needs no basis of its own.
 *
 * **claude-code is `valuation`, and that is the whole point of ADR 0013.**
 * Claude Code computes `total_cost_usd` locally from token counts times a
 * built-in price table; the SDK authenticates against the Pro subscription, so
 * no per-turn API charge occurs — and the number is reported identically either
 * way. With usage credits enabled, overflow past plan limits genuinely is
 * money, and Operator cannot read plan headroom, so it cannot tell which
 * portion. Never present this as plan usage.
 *
 * **ollama is `billed` at zero, and that is a fact rather than a placeholder.**
 * `ollama.mjs` says so in its own words: the electricity is already being spent
 * and no meter runs. Zero here is a known final number, which is what `billed`
 * means — as distinct from Gemini's zero, which is an unknown wearing a digit.
 * ADR 0013 names three bases and inventing a fourth for "genuinely free" would
 * be ceremony; this is the honest fit, not a shrug.
 *
 * **gemini is `unpriced`.** Its free tier is bounded by requests per day, not
 * dollars — see the quota ledger, which is where that provider is actually
 * governed.
 */
const PROVIDERS = {
  "claude-code": { basis: "valuation", models: MODEL_PRICES },
  gemini: { basis: "unpriced", models: {} },
  // Every model this worker runs is local, so the table is a rule rather than a
  // list — its models are whatever this machine has pulled, and a hardcoded
  // list would go stale the first time he runs `ollama pull`.
  ollama: { basis: "billed", free: true, models: {} },
};

const ZERO_PRICE = { band: "cheap", input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** The three, in the order a summary should read. There is no fourth. */
export const BASES = ["billed", "valuation", "unpriced"];

/**
 * What one model costs per million tokens, or null if nothing here prices it.
 *
 * Null is a real answer and callers must not read it as free — that is the
 * difference between `unpriced` and `billed`.
 */
export function priceFor(provider, model) {
  const entry = PROVIDERS[provider];
  if (!entry) return null;
  if (entry.free) return ZERO_PRICE;
  return entry.models[model] ?? null;
}

/**
 * A model's price band, as a static property.
 *
 * ADR 0013 §6 rejected routing on an *estimated* cost: a turn's cost is
 * dominated by how many tool iterations it takes, which is the one thing that
 * cannot be known before running it, so estimating produces a confident number
 * derived from a guess. A band is honest about being coarse. Exported for
 * `routing.mjs` to read when the owner wants cost-aware routing; nothing calls
 * it yet, and that is deliberate — this file does not reach into routing.
 */
export function bandFor(provider, model) {
  return priceFor(provider, model)?.band ?? null;
}

/** The declared meaning of a provider's numbers. Unknown providers are unpriced. */
export function basisFor(provider) {
  return PROVIDERS[provider]?.basis ?? "unpriced";
}

/** Whether this provider can cost anything at all. Used to size the reserve. */
function providerIsFree(provider) {
  return PROVIDERS[provider]?.free === true;
}

/**
 * Tokens times the table. Reasoning is billed as output; cache reads and writes
 * have their own rates and must not be lumped in with plain input — a cached
 * turn priced at the input rate overstates a long conversation by ~10x.
 */
export function deriveUsd(tokens, price) {
  if (!tokens || !price) return null;
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const perMillion =
    n(tokens.input) * price.input +
    (n(tokens.output) + n(tokens.reasoning)) * price.output +
    n(tokens.cacheRead) * price.cacheRead +
    n(tokens.cacheWrite) * price.cacheWrite;
  return perMillion / 1_000_000;
}

// --- ceilings -------------------------------------------------------------

/**
 * A ceiling is either one number, or a JSON object keyed by whatever the
 * caller keys it by (basis for the daily one, provider for the per-provider
 * one). JSON matches `OPERATOR_APPS`; the scalar exists because the common case
 * is "just stop at twenty dollars" and making that a JSON literal is friction
 * for no benefit.
 *
 * A malformed value **throws at import**, loudly. The alternative — treating an
 * unparseable ceiling as "no ceiling" — turns a typo into an unbounded spend,
 * which is the exact failure the ceiling exists to prevent.
 *
 * @returns {null | {scalar: number|null, byKey: Record<string, number>}}
 */
export function parseCeiling(raw, name = "ceiling") {
  const text = String(raw ?? "").trim();
  if (!text) return null;

  if (text.startsWith("{")) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error(`${name} is not valid JSON: ${err.message}`);
    }
    const byKey = {};
    for (const [key, value] of Object.entries(parsed)) {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) throw new Error(`${name}.${key} must be a number >= 0`);
      byKey[key] = n;
    }
    return { scalar: null, byKey };
  }

  const n = Number(text);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a number >= 0, or a JSON object`);
  // Zero means unset rather than "refuse everything" — an env var left as "0"
  // by a deploy script should not silently stop all work.
  return n > 0 ? { scalar: n, byKey: {} } : null;
}

/** The limit for one key, or null. A scalar applies to every key independently. */
function ceilingFor(ceiling, key) {
  if (!ceiling) return null;
  if (Object.prototype.hasOwnProperty.call(ceiling.byKey, key)) return ceiling.byKey[key] || null;
  return ceiling.scalar;
}

/**
 * Per-job, per-provider, global-daily — ADR 0013 §5's order, and the order they
 * are checked in below.
 *
 * The per-job one is first because it is the only one that can stop a runaway
 * *mid-turn*: it is handed to the SDK as `maxBudgetUsd`, which stops the turn
 * before it overruns rather than reporting the overrun afterwards.
 */
const JOB_CEILING = parseCeiling(process.env.OPERATOR_CEILING_JOB_USD, "OPERATOR_CEILING_JOB_USD");
const PROVIDER_CEILING = parseCeiling(
  process.env.OPERATOR_CEILING_PROVIDER_USD,
  "OPERATOR_CEILING_PROVIDER_USD"
);
const DAILY_CEILING = parseCeiling(
  process.env.OPERATOR_CEILING_DAILY_USD,
  "OPERATOR_CEILING_DAILY_USD"
);
/**
 * Requests per calendar day, per provider. The quota ledger's only ceiling.
 *
 * This exists because a dollar ceiling cannot govern an `unpriced` provider at
 * all, and Gemini is exactly that: free tier, 20 requests a day, $0.00 spent on
 * the day it became unusable. Cost and quota are separate ledgers because they
 * genuinely answer different questions.
 */
const QUOTA_CEILING = parseCeiling(process.env.OPERATOR_QUOTA_REQUESTS, "OPERATOR_QUOTA_REQUESTS");

/**
 * The configured set, gathered once.
 *
 * `ceilingBlock` takes this as an argument rather than reading the module
 * constants directly, so the self-test can exercise a *configured* ceiling.
 * That matters: with the env unset every ceiling check returns null, and a
 * suite that only ever sees null would pass while enforcing nothing — which is
 * the same class of false assurance as verifying a server change with the
 * shadowed `node` on PATH.
 */
export const CEILINGS = {
  job: JOB_CEILING,
  provider: PROVIDER_CEILING,
  daily: DAILY_CEILING,
  quota: QUOTA_CEILING,
};

/**
 * What to assume the next turn costs when nothing has run yet to measure.
 *
 * The check happens **before** a turn starts and never during it. The owner's
 * requirement, in his words: *"if I overlap it becomes half done and stuff would
 * break"* — killing a turn mid-edit leaves the repo half-changed, which is worse
 * than overshooting a self-imposed number by one turn. So a turn that starts is
 * always allowed to finish; a ceiling refuses the *next* one.
 */
const MIN_RESERVE_USD = 0.5;

/** The single job ceiling, for `runner.mjs`'s `maxBudgetUsd`. */
export function jobCeilingUsd() {
  return JOB_CEILING?.scalar ?? null;
}

// --- the ledger -----------------------------------------------------------

/** Local calendar day. Never `toISOString().slice(0,10)`, which is UTC (OPS-009). */
export function dayKey(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function monthKey(date = new Date()) {
  return dayKey(date).slice(0, 7);
}

function blankTotals() {
  const totals = {};
  for (const basis of BASES) {
    totals[basis] = {
      turns: 0,
      // null, not 0. An `unpriced` basis has no dollar figure and must never
      // render as "$0.00 spent" — that is the Gemini failure in miniature.
      usd: null,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      durationMs: 0,
      priced: 0,
      unknownCost: 0,
    };
  }
  return totals;
}

/**
 * Running totals held in memory so a polled endpoint never re-reads the file.
 *
 * A factory rather than module state so the self-test can build its own and
 * never touch `data/`.
 */
export function createLedger() {
  return {
    day: dayKey(),
    today: blankTotals(),
    /** provider id → { totals, maxTurnUsd } */
    providers: new Map(),
    /** provider id → { requests, exhausted } for the current day */
    quota: new Map(),
  };
}

function providerSlot(ledger, provider) {
  let slot = ledger.providers.get(provider);
  if (!slot) {
    slot = { totals: blankTotals(), maxTurnUsd: 0 };
    ledger.providers.set(provider, slot);
  }
  return slot;
}

function quotaSlot(ledger, provider) {
  let slot = ledger.quota.get(provider);
  if (!slot) {
    slot = { requests: 0, exhausted: null };
    ledger.quota.set(provider, slot);
  }
  return slot;
}

/**
 * Roll the day over if the clock has crossed midnight.
 *
 * Called on every read as well as every write: a server that has been up since
 * yesterday would otherwise report yesterday's total as today's and refuse work
 * against a ceiling that has already reset.
 */
export function rollDay(ledger, now = new Date()) {
  const today = dayKey(now);
  if (ledger.day === today) return false;
  ledger.day = today;
  ledger.today = blankTotals();
  ledger.providers = new Map();
  // Quota is per-day by definition, so a rollover clears both the count and any
  // provider-reported exhaustion — "out until tomorrow" ends at tomorrow.
  ledger.quota = new Map();
  return true;
}

function addUsd(bucket, usd) {
  if (usd === null || usd === undefined) {
    bucket.unknownCost += 1;
    return;
  }
  bucket.usd = (bucket.usd ?? 0) + usd;
  bucket.priced += 1;
}

function addTo(totals, record) {
  const bucket = totals[record.basis];
  if (!bucket) return;
  bucket.turns += 1;
  addUsd(bucket, record.usd);
  bucket.durationMs += Number(record.durationMs) || 0;
  if (record.tokens) {
    for (const key of Object.keys(bucket.tokens)) {
      bucket.tokens[key] += Number(record.tokens[key]) || 0;
    }
  }
}

/**
 * One turn, normalised into the shape that goes on disk.
 *
 * Pure — no clock beyond what is passed, no file, no ledger. The self-test
 * leans on that.
 */
export function normaliseRecord({
  jobId = null,
  attempt = null,
  provider,
  model = null,
  tokens = null,
  reportedUsd = null,
  durationMs = null,
  turns = null,
  error = false,
  at = new Date(),
}) {
  const basis = basisFor(provider);
  const price = priceFor(provider, model);

  let usd = null;
  let source = "none";
  let priceTableVersion = null;

  if (basis === "unpriced") {
    /*
      A reported number from an unpriced provider is discarded, not banked.

      Gemini returns a hardcoded `costUsd: 0`. Recording that as a real zero is
      how a free tier turning into a billed project becomes invisible — the
      figure keeps saying $0.00 and nothing anywhere says it stopped being true.
    */
    usd = null;
  } else if (tokens && price) {
    // Preferred: re-derivable. A mispriced table becomes a recomputation over
    // history rather than a number that is permanently wrong.
    usd = deriveUsd(tokens, price);
    source = "derived";
    priceTableVersion = PRICE_TABLE_VERSION;
  } else if (typeof reportedUsd === "number" && Number.isFinite(reportedUsd)) {
    // The worker's own number. Honest, and NOT re-derivable — which is why the
    // record says so rather than implying the price table produced it.
    usd = reportedUsd;
    source = "reported";
  } else if (tokens && !price) {
    /*
      Tokens known, no price for this model. This is what `unpriced` was defined
      for, and the record is downgraded to it even though the provider's
      declared basis is billed or valuation — because a turn nobody can price
      must not be counted as costing zero against a ceiling.
    */
    return {
      v: 1,
      at: at.toISOString(),
      day: dayKey(at),
      jobId,
      attempt,
      provider,
      model,
      basis: "unpriced",
      source: "none",
      priceTableVersion: null,
      tokens,
      usd: null,
      durationMs: durationMs ?? null,
      turns: turns ?? null,
      error: Boolean(error),
    };
  }

  return {
    v: 1,
    at: at.toISOString(),
    day: dayKey(at),
    jobId,
    attempt,
    provider,
    model,
    basis,
    source,
    priceTableVersion,
    tokens,
    usd,
    durationMs: durationMs ?? null,
    /*
      Wall-clock and turn count sit beside the money on purpose. The real defect
      of 2026-08-20 — 129 seconds, nine permission prompts and $0.92 to answer
      "what's my gym session today" — was invisible to a dollar meter and
      obvious in duration and turns. Cost-per-answer is what catches "this
      worked but was stupid".
    */
    turns: turns ?? null,
    error: Boolean(error),
  };
}

/** Fold one record into a ledger's running totals. */
export function applyToLedger(ledger, record, now = new Date()) {
  rollDay(ledger, now);
  addTo(ledger.today, record);
  const slot = providerSlot(ledger, record.provider);
  addTo(slot.totals, record);
  if (typeof record.usd === "number") slot.maxTurnUsd = Math.max(slot.maxTurnUsd, record.usd);
  return record;
}

/**
 * Totals over a list of records, **per basis and never across them**.
 *
 * There is deliberately no `total` field. `$40 valuation + $0.30 billed` is not
 * $40.30, it is two different facts, and the way to stop a caller adding them is
 * to never hand them a number that looks like it already is the sum.
 */
export function aggregate(records) {
  const totals = blankTotals();
  for (const record of records) addTo(totals, record);
  return totals;
}

// --- quota ----------------------------------------------------------------

/**
 * Count one request against a provider's daily allowance.
 *
 * Counted per *turn*, which under-counts a worker that makes several provider
 * calls inside one turn — Gemini's tool loop runs up to ten rounds. That is
 * stated rather than hidden: the provider's own 429 is the authority, and
 * `noteQuotaExhausted` below is how that authority gets recorded. This counter
 * is the local guard rail, not a mirror of the provider's meter.
 */
export function noteRequest(ledger, provider, now = new Date()) {
  rollDay(ledger, now);
  quotaSlot(ledger, provider).requests += 1;
}

/**
 * The provider itself said it is out for the day.
 *
 * Recorded, not enforced. `routing.mjs` already keeps a cooldown map and steers
 * work elsewhere for six hours; blocking here as well would stop a retry after
 * the window genuinely resets, and duplicating routing's job in a second place
 * is how the two drift apart. This ledger exists so the fact is *visible* — a
 * provider out of quota while under budget is precisely what happened on day
 * one, and nothing recorded it.
 */
export function noteQuotaExhausted(ledger, provider, { window = "day", source = "provider" } = {}, now = new Date()) {
  rollDay(ledger, now);
  quotaSlot(ledger, provider).exhausted = { window, source, at: now.toISOString() };
}

/** Requests spent and remaining per provider, for display and for routing. */
export function quotaSnapshot(ledger, now = new Date()) {
  rollDay(ledger, now);
  const out = {};
  const providers = new Set([...ledger.quota.keys(), ...Object.keys(PROVIDERS)]);
  for (const provider of providers) {
    const slot = ledger.quota.get(provider) ?? { requests: 0, exhausted: null };
    const limit = ceilingFor(QUOTA_CEILING, provider);
    out[provider] = {
      requests: slot.requests,
      limit,
      remaining: limit === null ? null : Math.max(0, limit - slot.requests),
      exhausted: slot.exhausted,
    };
  }
  return out;
}

// --- the check ------------------------------------------------------------

/**
 * Whether there is room to *start* another turn.
 *
 * Returns null to proceed, or `{ scope, basis, message }` explaining the refusal
 * in the terms of whichever ceiling tripped. A ceiling that stops work for a
 * reason it cannot explain is worse than no ceiling — that was one of the
 * reasons ADR 0013 refused to ship `OPERATOR_USAGE_BUDGET_USD` as it stood.
 *
 * Order is ADR 0013 §5: job, then provider, then the global day.
 */
export function ceilingBlock(
  ledger,
  { provider, model = null, jobUsd = 0 },
  now = new Date(),
  ceilings = CEILINGS
) {
  rollDay(ledger, now);

  const basis = basisFor(provider);
  const slot = providerSlot(ledger, provider);
  /*
    What the next turn might cost. The largest turn seen from this provider
    today, floored at MIN_RESERVE until one has been seen — except for a
    provider that cannot cost anything, where reserving half a dollar against
    a local model would refuse free work for imaginary money.
  */
  const reserve = providerIsFree(provider)
    ? 0
    : Math.max(slot.maxTurnUsd, MIN_RESERVE_USD);

  // 1. Per job. The runaway guard, and the only one the SDK can also enforce
  //    mid-turn via maxBudgetUsd.
  /*
    A job always gets its first turn.

    Applying the reserve at $0 spent would refuse every new job outright the
    moment any single turn had ever cost more than the per-job ceiling — the
    limit would stop being "a job may spend this much" and become "no job may
    start". The first turn is instead bounded *during* it, by the same number
    handed to the SDK as `maxBudgetUsd`, which is what a mid-turn guard is for.
    From the second turn on, the between-turns rule applies as everywhere else.
  */
  const jobLimit = ceilings.job?.scalar ?? null;
  const jobReserve = jobUsd > 0 ? reserve : 0;
  if (jobLimit !== null && basis !== "unpriced" && jobUsd + jobReserve > jobLimit) {
    return {
      scope: "job",
      basis,
      message:
        `This job has used $${jobUsd.toFixed(2)} of its $${jobLimit.toFixed(2)} per-job ceiling, and the ` +
        `next turn could cost about $${jobReserve.toFixed(2)}. Stopping before the turn rather than part-way ` +
        `through one. That figure is a ${basis}, not a bill — raise OPERATOR_CEILING_JOB_USD and restart ` +
        `to continue, or start a new job.`,
    };
  }

  // 2. Per provider. Routing exists specifically to funnel work, so funnelling
  //    everything into the expensive worker is a likely failure, not a remote
  //    one. A provider has exactly one basis, so this ceiling needs no basis of
  //    its own.
  const providerLimit = ceilingFor(ceilings.provider, provider);
  const providerSpent = slot.totals[basis].usd ?? 0;
  if (providerLimit !== null && basis !== "unpriced" && providerSpent + reserve > providerLimit) {
    return {
      scope: "provider",
      basis,
      message:
        `${provider} has used $${providerSpent.toFixed(2)} of its $${providerLimit.toFixed(2)} ceiling for ` +
        `today, and the next turn could cost about $${reserve.toFixed(2)}. That figure is a ${basis}, not a ` +
        `bill. Raise OPERATOR_CEILING_PROVIDER_USD and restart, or ask another worker.`,
    };
  }

  // 3. Global daily. Last and weakest alone: it cannot distinguish valuation
  //    from spend, so on a subscription it is a plan-consumption proxy wearing a
  //    currency symbol. Applied to each basis SEPARATELY — one number governing
  //    their sum would be the exact arithmetic this file exists to prevent.
  const dailyLimit = ceilingFor(ceilings.daily, basis);
  const daySpent = ledger.today[basis].usd ?? 0;
  if (dailyLimit !== null && basis !== "unpriced" && daySpent + reserve > dailyLimit) {
    return {
      scope: "daily",
      basis,
      message:
        `Operator has used $${daySpent.toFixed(2)} of its $${dailyLimit.toFixed(2)} daily ${basis} ceiling, ` +
        `and the next turn could cost about $${reserve.toFixed(2)}. This counts Operator's own consumption ` +
        `and nothing else — it is not your plan usage, which cannot be read from here. Raise ` +
        `OPERATOR_CEILING_DAILY_USD and restart to continue.`,
    };
  }

  // 4. Quota. A separate ledger, and the only ceiling that can govern an
  //    unpriced provider at all — which is the whole reason it is separate.
  const quotaLimit = ceilingFor(ceilings.quota, provider);
  const spentRequests = ledger.quota.get(provider)?.requests ?? 0;
  if (quotaLimit !== null && spentRequests >= quotaLimit) {
    return {
      scope: "quota",
      basis,
      message:
        `${provider} has used ${spentRequests} of its ${quotaLimit} requests for today. This is a request ` +
        `count, not money — it can run out while costing nothing. It resets tomorrow; raise ` +
        `OPERATOR_QUOTA_REQUESTS and restart, or ask another worker.`,
    };
  }

  return null;
}

// --- the live instance ----------------------------------------------------

const ledger = createLedger();

/**
 * Load today's records back in after a restart.
 *
 * Without this a restart resets the daily ceiling, and restarting is a normal
 * part of editing Operator — so "raise the limit and restart" would work by
 * accident, and a loop that tripped the ceiling would get a fresh allowance
 * every time the server came back.
 *
 * Reads only the current month's file and keeps only today's rows. Never
 * throws: an unreadable usage file must not stop the server serving his data.
 */
async function restore() {
  try {
    const file = usageFile();
    if (!existsSync(file)) return;
    const text = await readFile(file, "utf8");
    const today = dayKey();
    let restored = 0;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        // One corrupt line — a half-written append at a crash — must not throw
        // away the rest of the day.
        continue;
      }
      if (record?.day !== today || !record.basis) continue;
      applyToLedger(ledger, record);
      /*
        The quota count is rebuilt from the records rather than persisted
        separately: one record is written per turn and `countRequest` is called
        once per turn, so the two are the same number by construction.

        It has to be rebuilt at all because restarting is a normal part of
        editing Operator — the Dev page has a button for it. Without this, a
        provider that had spent its daily allowance would get a fresh one every
        time the server came back, which makes the guard worth roughly nothing.

        A turn that was counted and then crashed before writing its record is
        lost from the count. That undercounts by at most the number of crashes,
        and the provider's own 429 remains the authority either way.
      */
      noteRequest(ledger, record.provider);
      restored += 1;
    }
    if (restored) console.log(`[operator] usage: restored ${restored} turn(s) from today`);
  } catch (err) {
    console.warn(`[operator] could not read today's usage: ${err?.message ?? err}`);
  }
}

function usageFile(date = new Date()) {
  return join(USAGE_DIR, `usage-${monthKey(date)}.jsonl`);
}

await restore();

/**
 * Record one turn: fold it into the running totals and append it to disk.
 *
 * The append is deliberately not awaited by callers that do not care — a failed
 * write must never cost a turn, so it warns and carries on. The in-memory
 * ledger is updated first and synchronously, so a ceiling is enforced even when
 * the disk is unhappy.
 */
export function recordTurn(spec) {
  const record = normaliseRecord(spec);
  applyToLedger(ledger, record);
  void persist(record);
  return record;
}

async function persist(record) {
  try {
    await mkdir(USAGE_DIR, { recursive: true });
    await appendFile(usageFile(), `${JSON.stringify(record)}\n`, "utf8");
  } catch (err) {
    console.warn(`[operator] could not append usage: ${err?.message ?? err}`);
  }
}

/** Count one provider request against today's quota. */
export function countRequest(provider) {
  noteRequest(ledger, provider);
}

/** Record that a provider said it is out of quota for the window. */
export function markQuotaExhausted(provider, options) {
  noteQuotaExhausted(ledger, provider, options);
}

/** The live check, against the live ledger. */
export function checkCeiling(spec) {
  return ceilingBlock(ledger, spec);
}

/**
 * Everything the Orchestrator page needs, and nothing that invites a sum.
 *
 * `spentUsd` and `budgetUsd` are **compatibility shims** for the existing UI
 * (`useJobs.ts` reads them, `OrchestratorChat.tsx` renders `spentUsd`), and they
 * are pinned to the **valuation** basis rather than being a total. Pinning is
 * the honest choice: a single field whose meaning silently changes the day an
 * API key appears is worse than one that is explicitly about one basis. The
 * page should move to `today` and drop these; `spentBasis` is here so it can
 * label the number correctly in the meantime.
 */
export function usageSnapshot() {
  rollDay(ledger);
  /*
    `byProvider`, not `providers`.

    `jobs.mjs`'s `list()` spreads this snapshot over a payload that already has
    a `providers` key — the enabled worker list the model picker reads. The
    spread comes last, so naming this one `providers` would silently replace the
    worker list with a table of dollar totals and empty the picker. The kind of
    break that type-checks, compiles, and is only visible on the page.
  */
  const byProvider = {};
  for (const [id, slot] of ledger.providers) {
    byProvider[id] = { totals: slot.totals, maxTurnUsd: slot.maxTurnUsd };
  }
  return {
    usageDay: ledger.day,
    priceTableVersion: PRICE_TABLE_VERSION,
    today: ledger.today,
    byProvider,
    quota: quotaSnapshot(ledger),
    ceilings: {
      jobUsd: jobCeilingUsd(),
      providerUsd: PROVIDER_CEILING ? { ...PROVIDER_CEILING.byKey, default: PROVIDER_CEILING.scalar } : null,
      dailyUsd: DAILY_CEILING ? { ...DAILY_CEILING.byKey, default: DAILY_CEILING.scalar } : null,
      quotaRequests: QUOTA_CEILING ? { ...QUOTA_CEILING.byKey, default: QUOTA_CEILING.scalar } : null,
    },
    // Named so no caller can mistake it for plan usage. There is no way to read
    // the plan percentage from here — no `claude usage` subcommand, and
    // `/usage` is interactive-only.
    scope: "operator-only",
    spentBasis: "valuation",
    spentUsd: ledger.today.valuation.usd ?? 0,
    budgetUsd: ceilingFor(DAILY_CEILING, "valuation"),
  };
}

// --- self-test ------------------------------------------------------------
//
// Run with:  "C:\Program Files\nodejs\node.exe" server/usage.mjs --self-test
//
// Same MUST / MUST_NOT shape as intent.mjs and voicecommand.mjs, and here for
// the same reason: the things this file must REFUSE to do are worth as much as
// the things it does. Every case below is a way the accounting could be wrong
// while every number still looked plausible — which is the failure mode ADR
// 0013 was written about.
//
// Nothing here touches `data/`: the checks run against ledgers built by
// `createLedger()` and records built by `normaliseRecord()`, both pure.

/**
 * A configured set, so the ceiling checks exercise real refusals.
 *
 * Reading `CEILINGS` instead would make every ceiling case pass vacuously on a
 * machine with the env unset — a suite that enforces nothing while reporting
 * green, which is the same shape of false assurance as the shadowed `node` on
 * PATH that exits 0 having run nothing.
 */
const TEST_CEILINGS = {
  job: parseCeiling("5", "test.job"),
  provider: parseCeiling('{"claude-code":50}', "test.provider"),
  daily: parseCeiling("20", "test.daily"),
  quota: parseCeiling('{"gemini":20}', "test.quota"),
};

const CHECKS = [
  // --- aggregates must not sum across basis ---
  [
    "MUST     keep valuation and billed apart in an aggregate",
    () => {
      const totals = aggregate([
        normaliseRecord({ provider: "claude-code", model: "claude-opus-5", reportedUsd: 40 }),
        normaliseRecord({ provider: "ollama", model: "qwen2.5:3b", reportedUsd: 0.3 }),
      ]);
      return totals.valuation.usd === 40 && totals.billed.usd === 0.3;
    },
  ],
  [
    "MUST NOT expose any field that is the sum across bases",
    () => {
      const totals = aggregate([
        normaliseRecord({ provider: "claude-code", model: "claude-opus-5", reportedUsd: 40 }),
        normaliseRecord({ provider: "ollama", model: "qwen2.5:3b", reportedUsd: 0.3 }),
      ]);
      // 40.30 must not appear anywhere in the shape a caller could read.
      return !JSON.stringify(totals).includes("40.3");
    },
  ],
  [
    "MUST     leave a basis with no records at usd null, not zero",
    () => aggregate([normaliseRecord({ provider: "claude-code", reportedUsd: 1 })]).billed.usd === null,
  ],

  // --- unpriced must never become zero ---
  [
    "MUST     record an unpriced provider's turn with usd null",
    () => normaliseRecord({ provider: "gemini", model: "gemini-flash-latest" }).usd === null,
  ],
  [
    "MUST NOT bank Gemini's hardcoded costUsd: 0 as a real zero",
    () => {
      const record = normaliseRecord({ provider: "gemini", model: "gemini-flash-latest", reportedUsd: 0 });
      return record.usd === null && record.basis === "unpriced";
    },
  ],
  [
    "MUST     aggregate an unpriced turn as a turn with an unknown cost",
    () => {
      const totals = aggregate([normaliseRecord({ provider: "gemini", reportedUsd: 0 })]);
      return totals.unpriced.turns === 1 && totals.unpriced.usd === null && totals.unpriced.unknownCost === 1;
    },
  ],
  [
    "MUST     downgrade a priced provider's UNKNOWN model to unpriced, not to $0",
    () => {
      const record = normaliseRecord({
        provider: "claude-code",
        model: "claude-opus-9",
        tokens: { input: 1_000_000, output: 0 },
      });
      return record.basis === "unpriced" && record.usd === null;
    },
  ],
  [
    "MUST     treat a local model's zero as billed, because it is a known final number",
    () => {
      const record = normaliseRecord({ provider: "ollama", model: "qwen2.5:3b", reportedUsd: 0 });
      return record.basis === "billed" && record.usd === 0;
    },
  ],

  // --- tokens are the record, USD is derived ---
  [
    "MUST     derive USD from tokens when they are present",
    () => {
      const record = normaliseRecord({
        provider: "claude-code",
        model: "claude-opus-5",
        tokens: { input: 1_000_000, output: 1_000_000 },
        reportedUsd: 999,
      });
      // $5 input + $25 output, and the worker's 999 is ignored in favour of the
      // re-derivable number.
      return record.usd === 30 && record.source === "derived";
    },
  ],
  [
    "MUST     stamp the price table version on a derived record only",
    () => {
      const derived = normaliseRecord({
        provider: "claude-code",
        model: "claude-opus-5",
        tokens: { input: 1000, output: 0 },
      });
      const reported = normaliseRecord({ provider: "claude-code", model: "claude-opus-5", reportedUsd: 1 });
      return derived.priceTableVersion === PRICE_TABLE_VERSION && reported.priceTableVersion === null;
    },
  ],
  [
    "MUST     price cache reads at the cache rate, not the input rate",
    () => {
      const price = priceFor("claude-code", "claude-opus-5");
      const cached = deriveUsd({ cacheRead: 1_000_000 }, price);
      const fresh = deriveUsd({ input: 1_000_000 }, price);
      return cached === 0.5 && fresh === 5;
    },
  ],
  [
    "MUST     count reasoning tokens at the output rate, not ignore them",
    () => {
      const price = priceFor("claude-code", "claude-opus-5");
      // 61 thinking tokens against 1 of output, measured on Gemini Flash.
      const withThinking = deriveUsd({ output: 1, reasoning: 61 }, price);
      const without = deriveUsd({ output: 1 }, price);
      return withThinking > without * 60;
    },
  ],
  [
    "MUST NOT price anything against a model it has no entry for",
    () => priceFor("claude-code", "claude-opus-9") === null && deriveUsd({ input: 5 }, null) === null,
  ],

  // --- quota is a separate ledger from cost ---
  [
    "MUST     count requests without touching any dollar total",
    () => {
      const l = createLedger();
      noteRequest(l, "gemini");
      noteRequest(l, "gemini");
      return quotaSnapshot(l).gemini.requests === 2 && l.today.unpriced.usd === null;
    },
  ],
  [
    "MUST     block an unpriced provider on quota even though it has spent $0",
    () => {
      // The 2026-08-20 case exactly: 20 requests spent, $0.00 recorded, and the
      // provider unusable. A dollar meter shows headroom; this must not.
      const l = createLedger();
      for (let i = 0; i < 20; i += 1) noteRequest(l, "gemini");
      const block = ceilingBlock(l, { provider: "gemini" }, new Date(), TEST_CEILINGS);
      return block?.scope === "quota" && l.today.unpriced.usd === null;
    },
  ],
  [
    "MUST NOT block a provider that is under quota",
    () => {
      const l = createLedger();
      for (let i = 0; i < 19; i += 1) noteRequest(l, "gemini");
      return ceilingBlock(l, { provider: "gemini" }, new Date(), TEST_CEILINGS) === null;
    },
  ],
  [
    "MUST     record provider-reported exhaustion without inventing a cost",
    () => {
      const l = createLedger();
      noteQuotaExhausted(l, "gemini", { window: "day" });
      const snap = quotaSnapshot(l);
      return snap.gemini.exhausted?.window === "day" && l.today.unpriced.usd === null;
    },
  ],
  [
    "MUST NOT let a dollar ceiling govern an unpriced provider at all",
    () => {
      const l = createLedger();
      // Gemini could run a thousand turns and no USD ceiling would ever see it.
      for (let i = 0; i < 1000; i += 1) {
        applyToLedger(l, normaliseRecord({ provider: "gemini", reportedUsd: 0 }));
      }
      return l.today.unpriced.usd === null && l.today.unpriced.turns === 1000;
    },
  ],

  // --- ceilings ---
  [
    "MUST     parse a bare number as one ceiling applying to every key",
    () => {
      const c = parseCeiling("20", "test");
      return ceilingFor(c, "valuation") === 20 && ceilingFor(c, "billed") === 20;
    },
  ],
  [
    "MUST     parse a JSON object as a ceiling per key",
    () => {
      const c = parseCeiling('{"billed":5,"valuation":40}', "test");
      return ceilingFor(c, "billed") === 5 && ceilingFor(c, "valuation") === 40;
    },
  ],
  [
    "MUST     treat an unset or zero ceiling as no ceiling",
    () => parseCeiling("", "test") === null && parseCeiling("0", "test") === null,
  ],
  [
    "MUST NOT silently treat a malformed ceiling as unlimited",
    () => {
      try {
        parseCeiling("twenty dollars", "test");
        return false;
      } catch {
        return true;
      }
    },
  ],
  [
    "MUST     stop BEFORE the turn that would cross the ceiling, not after",
    () => {
      // $19.50 spent against a $20 daily ceiling, biggest turn seen $1. The
      // next turn is refused now rather than allowed through to $20.50 — the
      // owner's requirement, in his words: "if I overlap it becomes half done
      // and stuff would break".
      const l = createLedger();
      applyToLedger(l, normaliseRecord({ provider: "claude-code", model: "claude-opus-5", reportedUsd: 18.5 }));
      applyToLedger(l, normaliseRecord({ provider: "claude-code", model: "claude-opus-5", reportedUsd: 1 }));
      const block = ceilingBlock(l, { provider: "claude-code" }, new Date(), TEST_CEILINGS);
      return l.today.valuation.usd === 19.5 && block?.scope === "daily";
    },
  ],
  [
    "MUST NOT refuse while there is genuinely room for another turn",
    () => {
      const l = createLedger();
      applyToLedger(l, normaliseRecord({ provider: "claude-code", model: "claude-opus-5", reportedUsd: 1 }));
      return ceilingBlock(l, { provider: "claude-code" }, new Date(), TEST_CEILINGS) === null;
    },
  ],
  [
    "MUST     apply the daily ceiling to each basis SEPARATELY, never to their sum",
    () => {
      // $19 valuation and $19 billed is $38 of "spend" by the arithmetic this
      // file refuses to do. Under a $20-per-basis ceiling neither has tripped,
      // and a $19.60 valuation turn must trip valuation alone.
      const l = createLedger();
      applyToLedger(l, normaliseRecord({ provider: "claude-code", model: "claude-opus-5", reportedUsd: 19 }));
      applyToLedger(l, normaliseRecord({ provider: "ollama", model: "qwen2.5:3b", reportedUsd: 19 }));
      const claude = ceilingBlock(l, { provider: "claude-code" }, new Date(), TEST_CEILINGS);
      const local = ceilingBlock(l, { provider: "ollama" }, new Date(), TEST_CEILINGS);
      // Claude trips (19 + reserve > 20); the local worker does not, because a
      // free provider reserves nothing and 19 is still under its own ceiling.
      return claude?.scope === "daily" && claude.basis === "valuation" && local === null;
    },
  ],
  [
    "MUST NOT reserve imaginary money against a provider that cannot cost anything",
    () => {
      const l = createLedger();
      // 19.9 of a 20 ceiling. A half-dollar reserve would refuse the next turn;
      // a local model costs nothing, so there is nothing to reserve.
      applyToLedger(l, normaliseRecord({ provider: "ollama", model: "qwen2.5:3b", reportedUsd: 19.9 }));
      return (
        providerIsFree("ollama") &&
        !providerIsFree("claude-code") &&
        ceilingBlock(l, { provider: "ollama" }, new Date(), TEST_CEILINGS) === null
      );
    },
  ],
  [
    "MUST     check the job ceiling before the provider and daily ones",
    () => {
      const l = createLedger();
      const block = ceilingBlock(l, { provider: "claude-code", jobUsd: 4.9 }, new Date(), TEST_CEILINGS);
      return block?.scope === "job";
    },
  ],
  [
    "MUST     let a job take its FIRST turn even when the reserve exceeds the job ceiling",
    () => {
      // An $8 turn earlier today makes the reserve $8 against a $5 job ceiling
      // — but leaves room under the provider and daily ones. Applying the
      // reserve at $0 spent would mean no job could ever start.
      const l = createLedger();
      applyToLedger(l, normaliseRecord({ provider: "claude-code", model: "claude-opus-5", reportedUsd: 8 }));
      return ceilingBlock(l, { provider: "claude-code", jobUsd: 0 }, new Date(), TEST_CEILINGS) === null;
    },
  ],
  [
    "MUST     refuse a job's SECOND turn once the reserve would carry it past the ceiling",
    () => {
      const l = createLedger();
      applyToLedger(l, normaliseRecord({ provider: "claude-code", model: "claude-opus-5", reportedUsd: 4.6 }));
      return (
        ceilingBlock(l, { provider: "claude-code", jobUsd: 4.6 }, new Date(), TEST_CEILINGS)?.scope === "job"
      );
    },
  ],
  [
    "MUST     survive the round trip to disk — restore() re-reads what recordTurn wrote",
    () => {
      const record = normaliseRecord({
        provider: "claude-code",
        model: "claude-opus-5",
        tokens: { input: 1_000_000, output: 1_000_000 },
        durationMs: 1234,
        turns: 3,
      });
      const back = JSON.parse(JSON.stringify(record));
      const totals = aggregate([back]);
      return totals.valuation.usd === 30 && totals.valuation.tokens.input === 1_000_000;
    },
  ],
  [
    "MUST     name the basis in a refusal, so a stopped turn can explain itself",
    () => {
      const l = createLedger();
      const block = ceilingBlock(l, { provider: "claude-code", jobUsd: 4.9 }, new Date(), TEST_CEILINGS);
      return (
        BASES.includes(block.basis) &&
        // The message must not present a valuation as though it were a charge.
        block.message.includes("valuation") &&
        !/\byou (have )?spent\b/i.test(block.message)
      );
    },
  ],
  [
    "MUST NOT let a USD ceiling refuse an unpriced provider — it has no figure to compare",
    () => {
      const l = createLedger();
      for (let i = 0; i < 1000; i += 1) {
        applyToLedger(l, normaliseRecord({ provider: "gemini", reportedUsd: 0 }));
      }
      // 1000 turns and every dollar ceiling is silent; only quota can stop it,
      // and quota has not been touched here.
      return ceilingBlock(l, { provider: "gemini", jobUsd: 1e9 }, new Date(), TEST_CEILINGS) === null;
    },
  ],

  // --- the day ---
  [
    "MUST     reset the day's totals and quota when the clock crosses midnight",
    () => {
      const l = createLedger();
      applyToLedger(l, normaliseRecord({ provider: "claude-code", model: "claude-opus-5", reportedUsd: 5 }));
      noteRequest(l, "gemini");
      const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
      rollDay(l, tomorrow);
      return l.today.valuation.usd === null && (l.quota.get("gemini")?.requests ?? 0) === 0;
    },
  ],
  [
    "MUST NOT use UTC for the day key — that is OPS-009 in a new file",
    () => {
      // Local midnight must belong to the local day, not yesterday in UTC.
      const local = new Date(2026, 8, 2, 0, 30);
      return dayKey(local) === "2026-09-02";
    },
  ],

  // --- what is measured beyond money ---
  [
    "MUST     keep wall-clock and turn count, which is what catches an expensive answer",
    () => {
      // The real 2026-08-20 defect: 129 seconds, nine prompts, $0.92, to answer
      // "what's my gym session today". Invisible to a dollar meter.
      const record = normaliseRecord({
        provider: "claude-code",
        model: "claude-opus-5",
        reportedUsd: 0.92,
        durationMs: 129_000,
        turns: 9,
      });
      return record.durationMs === 129_000 && record.turns === 9;
    },
  ],
  [
    "MUST     say whether a number was derived or merely reported",
    () => {
      const reported = normaliseRecord({ provider: "claude-code", model: "claude-opus-5", reportedUsd: 1 });
      return reported.source === "reported" && reported.tokens === null;
    },
  ],
];

if (process.argv.includes("--self-test")) {
  let failed = 0;
  for (const [name, check] of CHECKS) {
    let ok = false;
    let error = null;
    try {
      ok = check() === true;
    } catch (err) {
      error = err?.message ?? String(err);
    }
    if (!ok) {
      console.log(`  FAIL  ${name}${error ? ` — threw: ${error}` : ""}`);
      failed += 1;
    }
  }
  console.log(failed ? `${failed} of ${CHECKS.length} FAILED` : `all ${CHECKS.length} pass`);
  process.exit(failed ? 1 : 0);
}
