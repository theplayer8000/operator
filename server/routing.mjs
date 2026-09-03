// Task routing: which worker should answer this?
//
// The orchestrator's actual job. Picking a model from a row of chips is a
// menu, not orchestration — the owner asked for "it decides", so this decides,
// and every job records what it chose and why.
//
// ## Why a model does the deciding, mostly
//
// Keyword rules are free and instant and wrong at the edges: "can you sort out
// my week" needs no code, "the gym page is showing yesterday" needs a lot of
// it, and no word list separates those reliably. A cheap model reads intent.
//
// But rules ARE right for the obvious cases, and a classifier call on every
// message is latency the obvious cases shouldn't pay — so unmistakable signals
// short-circuit before any network call happens.
//
// ## Why routing wrong is expensive in both directions
//
//   too capable   a Claude Code turn is an agentic loop against a real repo.
//                 Jobs have cost $40 in a day. Spending that to answer
//                 "what's on this week" is the waste this exists to stop.
//   not capable   Gemini has no filesystem and no shell. Sent a "fix the gym
//                 page" task it cannot do the work at all — it can only
//                 apologise convincingly, which is worse than being slow.
//
// So the tie-break is deliberately asymmetric: **anything uncertain goes to
// the more capable worker.** A wasted Claude turn costs money; a Gemini turn
// that cannot possibly succeed costs the owner his time and his trust in the
// routing, which is harder to get back.

/*
  The cheap worker, which is no longer Gemini.

  Gemini was the classifier and the destination for data questions. Both moved
  to AI Router on 2026-09-02 for two reasons that compound: its free tier is 20
  requests a DAY, so the classifier stopped working most evenings and every
  routing decision silently fell back to the expensive worker — the exact cost
  it exists to avoid. And its key was burned by being typed into Operator's own
  terminal, which logs every command.

  A flat rate has neither problem. There is no daily count to exhaust and no
  per-call cost, so the classifier can run on every ambiguous request instead of
  being rationed.
*/
const CLASSIFIER_MODEL = process.env.AIROUTER_CLASSIFIER_MODEL || "Qwen3.8";
const ENDPOINT = (process.env.AIROUTER_BASE_URL || "https://api.airouter.ch/v1").replace(/\/+$/, "");

/** Where a data question goes. Falls back to the capable worker if unconfigured. */
const DATA_WORKER = process.env.AIROUTER_API_KEY ? "airouter" : "claude-code";

// --- availability ----------------------------------------------------------
//
// A worker that just told us it is out of capacity should not be handed the
// next job. Without this, 2026-08-21 went: Claude hit its session limit, the
// owner said "use a different model then duh", and the router sent the retry
// straight back to Claude — twice. The router knew how to weigh *capability*
// and nothing at all about *availability*.
//
// In memory and short-lived on purpose. These limits lift on their own (a
// session cap resets, an overload passes), so persisting the state would mean
// carrying a stale "unavailable" across a restart and routing around a worker
// that recovered hours ago.

/** provider id → { until: epoch ms, reason: string } */
const unavailable = new Map();

/** How long to route around a worker that reported a limit, by kind. */
const COOLDOWN_MS = {
  // A subscription session cap; the message names a reset time we cannot
  // parse reliably, so this is a "check back later" rather than a promise.
  session: 30 * 60_000,
  // A daily quota. Long, because retrying inside the same day cannot succeed.
  daily: 6 * 60 * 60_000,
  // Transient: overload, "high demand", a burst limit.
  busy: 2 * 60_000,
};

/**
 * Classify a failure message into a cooldown, or null if it is not an
 * availability problem at all.
 *
 * Deliberately conservative: an ordinary error — a bad tool call, a refusal,
 * a bug — must not sideline a working provider. Only phrases that mean "not
 * now" count.
 */
export function limitKind(message) {
  const text = String(message ?? "").toLowerCase();
  if (!text) return null;
  if (/session limit|usage limit|resets? \d|plan limit/.test(text)) return "session";
  if (/per day|daily limit|quota.*(exceeded|spent)|free tier is spent/.test(text)) return "daily";
  if (/high demand|overload|try again later|rate.?limit|too many requests|503|529/.test(text)) {
    return "busy";
  }
  return null;
}

/** Record that a worker is out of capacity, if that is what the error means. */
export function noteFailure(provider, message) {
  const kind = limitKind(message);
  if (!kind) return null;
  const until = Date.now() + COOLDOWN_MS[kind];
  unavailable.set(provider, { until, reason: kind });
  console.log(
    `[operator] routing will avoid ${provider} for ${Math.round(
      COOLDOWN_MS[kind] / 60_000
    )}m (${kind})`
  );
  return kind;
}

/** Clear a worker's cooldown — it just succeeded, so it is plainly back. */
export function noteSuccess(provider) {
  unavailable.delete(provider);
}

/**
 * How long this worker is sidelined for, in milliseconds. `0` means it is fine.
 *
 * Exported for the job that was *running* when the limit hit. Sidelining only
 * ever helped the NEXT job — the one already in flight failed and sat there
 * until somebody tapped Retry, which sent it back to the worker that had just
 * said no. `jobs.mjs` uses this to decide between waiting the window out and
 * moving the work somewhere else.
 */
export function cooldownRemaining(provider) {
  const entry = unavailable.get(provider);
  if (!entry) return 0;
  const left = entry.until - Date.now();
  if (left <= 0) {
    unavailable.delete(provider);
    return 0;
  }
  return left;
}

/**
 * Does this request need a worker that can touch the repo?
 *
 * The same two-stage read as `routeTask` — rules, then the classifier — but
 * asked about the WORK rather than about a worker, because after a failure the
 * question is different. `routeTask` would happily name a replacement: the
 * failed worker is sidelined by then, so the capable one drops out of the list
 * and the answer comes back as whatever is left, with no way to tell "this is
 * fine anywhere" from "this needs Claude and Claude is gone".
 *
 * Unknown counts as code. Handing a repo task to a worker with no filesystem
 * produces a confident answer about work it did not do, which is the one
 * outcome worse than waiting.
 */
export async function needsCode(prompt, signal) {
  const text = String(prompt ?? "").trim();
  if (!text) return false;
  if (NEEDS_CODE.some((re) => re.test(text))) return true;
  if (JUST_DATA.some((re) => re.test(text)) && text.length < 200) return false;
  const decided = await classify(text, signal);
  return decided ? decided.provider === "claude-code" : true;
}

function usable(ids) {
  const now = Date.now();
  const free = ids.filter((id) => {
    const entry = unavailable.get(id);
    if (!entry) return true;
    if (entry.until <= now) {
      unavailable.delete(id);
      return true;
    }
    return false;
  });
  // If everything is cooling down, routing around them all would mean refusing
  // to work at all. Better to try the preferred worker and let it say no than
  // to invent an outage.
  return free.length ? free : ids;
}

/**
 * Signals that settle it without asking anyone.
 *
 * Only patterns where being wrong is close to impossible. Anything debatable
 * belongs to the classifier — this list is a fast path, not a policy, and it
 * grows only when a real misroute proves a case is genuinely unambiguous.
 */
const NEEDS_CODE = [
  /\b(commit|push|merge|rebase|branch|pull request|PR)\b/i,
  /\b(refactor|debug|stack trace|typecheck|lint|build fail\w*)\b/i,
  /\b(npm|npx|tsc|vite|git)\b/i,
  /\.(tsx?|jsx?|mjs|cjs|json|css|md)\b/,
  /\bserver\/|\bsrc\/|\bdocs\//,
  /\b(codebase|repo|repository|source code)\b/i,
];

/**
 * The reverse: unmistakably the owner's own content.
 *
 * Wider than it strictly needs to be, on purpose. The classifier runs on a
 * free tier that **does** rate-limit — 429s were hit in one evening's testing
 * — and when it is unavailable everything falls to the capable worker, which
 * is the exact cost the router exists to avoid. So the common shapes of a data
 * request are recognised without a network call at all: cheaper, instant, and
 * unaffected by quota.
 *
 * Every entry names a feature Operator owns or a phrasing that cannot mean
 * source code. "Fix my gym page" is not here and must not be — it looks like
 * data and is code.
 */
const JUST_DATA = [
  /*
    Apostrophes optional throughout — the owner types "whats", "hows", "im".
    A real misroute proved this: "whats my gym session look like for today"
    matched nothing, fell through to the classifier, and on a spent quota
    landed on Claude Code for $0.92. `'?` after every contraction, and the
    feature nouns below catch the same sentence a second way.
  */
  /^(what|hows?|when|where)('?s| is| are)?\b.{0,60}\b(on|due|left|today|tonight|this week|tomorrow|next week)\b/i,
  /^(when|how many|how much|do i have|did i|have i|whats|what's)\b/i,
  // Naming a feature Operator owns, without naming code. "My gym session",
  // "my missions", "the routine" cannot mean the source of those pages —
  // "the gym page" can, and is caught by NEEDS_CODE first.
  /\b(my|the) (gym|training) (session|day|plan)\b/i,
  /\b(my|the) (missions?|mission board|calendar|diary|routine|schedule)\b/i,
  // Capability actions, phrased the way a person actually phrases them.
  /\b(tick|check) (off|it)\b/i,
  /\b(add|create|make|log|put|schedule|book)\b.{0,40}\b(mission|event|appointment|task|step|session|reminder)\b/i,
  /\b(on|to|in) (my |the )?(calendar|diary|mission board|routine|gym log)\b/i,
  /\b(mark|set)\b.{0,30}\b(complete|done|in progress|skipped|archived)\b/i,
  /\b(skip|skipped|rest day)\b/i,
  /*
    The clock and the date.

    Added after a measured misroute on 2026-08-31: "what time is it" matched
    nothing here — the patterns above expect the contraction ("whats") or a
    time word like "today" — so it fell through to the classifier, the
    classifier was rate-limited, and the documented uncertain-fallback sent it
    to Claude Code. Which shelled out to `PowerShell Get-Date`, over two
    attempts, for **$0.58**. The `now` action answers it for nothing.

    Genuinely unambiguous, which is the bar this list sets: no phrasing of
    "what time is it" is a question about source code.
  */
  /\btime is it\b/i,
  /^\s*(whats?|what's|hows?)\s+(the\s+)?(time|date|day)\b/i,
  /\bwhat (day|date) is it\b/i,
  /\b(todays?|today's) (date|day)\b/i,
];

function fastPath(prompt) {
  // Code wins ties: a request naming both a file and the calendar is almost
  // certainly about making the app do something, not about the calendar.
  if (NEEDS_CODE.some((re) => re.test(prompt))) {
    return { provider: "claude-code", why: "mentions code, the repo, or a git/build command" };
  }
  if (JUST_DATA.some((re) => re.test(prompt)) && prompt.length < 200) {
    return { provider: DATA_WORKER, why: "your own data — no code involved" };
  }
  return null;
}

/**
 * Ask the cheap model which worker fits.
 *
 * Deliberately not given the capability list to reason about — a short, closed
 * question ("code, or data?") is answered reliably by a small model, where
 * "here are two workers' capabilities, pick one" invites it to explain itself
 * and drift. One word out, parsed strictly, anything unexpected treated as a
 * failure rather than coerced into a guess.
 */
async function classify(prompt, signal) {
  const key = process.env.AIROUTER_API_KEY;
  if (!key) return null;

  const question =
    "Classify this request for a personal dashboard app. Answer with exactly one word.\n\n" +
    "CODE — it needs reading or changing the app's source code, running commands, " +
    "git, builds, or investigating why the app itself misbehaves.\n" +
    "DATA — it is about the owner's own content: their calendar, gym log, missions, " +
    "daily routine, or a general question or conversation needing no file access.\n\n" +
    `Request: ${prompt.slice(0, 500)}\n\nAnswer (CODE or DATA):`;

  try {
    /*
      OpenAI-shaped now, not Gemini's `:generateContent`.

      The reasoning control moved with it. Gemini needed
      `thinkingConfig.thinkingBudget: 0` because Flash spends output budget on
      internal reasoning BEFORE emitting text — a one-word classification burned
      61 thinking tokens and came back MAX_TOKENS with null parts, so every
      routing call failed while the silent fallback made it look fine.

      Qwen3.8 is also a reasoning model and has the same trap. Its control is
      `reasoning_effort: "none"`, which the router advertises in
      `supportedReasoningEfforts`. If a future model ignores the field the
      symptom is identical and equally quiet: check `finish_reason` before
      believing the classifier is being consulted at all.
    */
    const res = await fetch(`${ENDPOINT}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: CLASSIFIER_MODEL,
        messages: [{ role: "user", content: question }],
        reasoning_effort: "none",
        max_tokens: 8,
        temperature: 0,
      }),
      signal,
    });
    if (!res.ok) {
      /*
        Logged rather than swallowed. Under Gemini a 429 here was the COMMON
        case — twenty requests a day — and every routing decision then quietly
        fell back to the expensive worker, which is the exact cost this exists
        to avoid. A flat rate should make that rare, so a warning here now means
        something is genuinely wrong rather than that it is Tuesday evening.
      */
      console.warn(`[operator] routing classifier unavailable (${res.status}) — using rules`);
      return null;
    }
    const answer =
      (await res.json())?.choices?.[0]?.message?.content?.trim().toUpperCase() ?? "";
    if (answer.startsWith("CODE")) {
      return { provider: "claude-code", why: "reads as work on the app itself" };
    }
    if (answer.startsWith("DATA")) {
      return { provider: DATA_WORKER, why: "reads as a question about your own data" };
    }
    return null;
  } catch {
    // Offline, rate-limited, or the classifier is having a moment. Not worth
    // failing a job over — the caller falls back to the capable worker.
    return null;
  }
}

/**
 * Pick a worker for this prompt.
 *
 * @param {string} prompt
 * @param {string[]} available  provider ids currently enabled
 * @param {AbortSignal} [signal]
 * @returns {Promise<{provider: string, why: string}>}
 */
export async function routeTask(prompt, allProviders, signal) {
  // Anything cooling down after saying it was out of capacity drops out here,
  // so every decision below is made over workers that can actually take work.
  const available = usable(allProviders);
  const sidelined = allProviders.filter((id) => !available.includes(id));
  const note = sidelined.length ? ` (${sidelined.join(", ")} unavailable)` : "";

  const fallback = available.includes("claude-code") ? "claude-code" : available[0];

  // Nothing to decide, and no reason to spend a call finding that out.
  if (available.length <= 1) {
    return {
      provider: fallback,
      why: sidelined.length ? `the only worker available${note}` : "the only worker enabled",
    };
  }

  const text = String(prompt ?? "").trim();
  if (!text) return { provider: fallback, why: `nothing to classify${note}` };

  const quick = fastPath(text);
  if (quick && available.includes(quick.provider)) return { ...quick, why: quick.why + note };

  const decided = await classify(text, signal);
  if (decided && available.includes(decided.provider)) {
    return { ...decided, why: decided.why + note };
  }

  return {
    provider: fallback,
    why: `couldn't tell — sent to the more capable worker${note}`,
  };
}
