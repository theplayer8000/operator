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

const CLASSIFIER_MODEL = "gemini-flash-latest";
const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

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
  /^what('s| is| are)\b.{0,60}\b(on|due|left|today|this week|tomorrow)\b/i,
  /^(when|how many|how much|do i have|did i|have i)\b/i,
  // Capability actions, phrased the way a person actually phrases them.
  /\b(tick|check) (off|it)\b/i,
  /\b(add|create|make|log|put|schedule|book)\b.{0,40}\b(mission|event|appointment|task|step|session|reminder)\b/i,
  /\b(on|to|in) (my |the )?(calendar|diary|mission board|routine|gym log)\b/i,
  /\b(mark|set)\b.{0,30}\b(complete|done|in progress|skipped|archived)\b/i,
  /\b(skip|skipped|rest day)\b/i,
];

function fastPath(prompt) {
  // Code wins ties: a request naming both a file and the calendar is almost
  // certainly about making the app do something, not about the calendar.
  if (NEEDS_CODE.some((re) => re.test(prompt))) {
    return { provider: "claude-code", why: "mentions code, the repo, or a git/build command" };
  }
  if (JUST_DATA.some((re) => re.test(prompt)) && prompt.length < 200) {
    return { provider: "gemini", why: "your own data — no code involved" };
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
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;

  const question =
    "Classify this request for a personal dashboard app. Answer with exactly one word.\n\n" +
    "CODE — it needs reading or changing the app's source code, running commands, " +
    "git, builds, or investigating why the app itself misbehaves.\n" +
    "DATA — it is about the owner's own content: their calendar, gym log, missions, " +
    "daily routine, or a general question or conversation needing no file access.\n\n" +
    `Request: ${prompt.slice(0, 500)}\n\nAnswer (CODE or DATA):`;

  try {
    const res = await fetch(`${ENDPOINT}/${CLASSIFIER_MODEL}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: question }] }],
        generationConfig: {
          /*
            `thinkingBudget: 0` is load-bearing, not a tuning knob.

            Flash is a thinking model: it spends output budget on internal
            reasoning *before* emitting any text. Measured — a one-word
            classification burned 61 thinking tokens and returned
            `finishReason: MAX_TOKENS` with `parts: null`. Every routing call
            failed that way, and because the fallback is silent and sensible
            ("send it to the capable worker"), the router looked like it was
            working while never once consulting the model. Raising the token
            cap does not fix it — the thinking scales to fill whatever it is
            given. Turning thinking off returns "DATA" in a single token.

            If a future model ignores this field, the symptom is the same
            silent one: check `finishReason` before believing the router.
          */
          thinkingConfig: { thinkingBudget: 0 },
          maxOutputTokens: 16,
          temperature: 0,
        },
      }),
      signal,
    });
    if (!res.ok) {
      /*
        Logged rather than swallowed. A 429 here is the interesting case: the
        free tier does rate-limit, and when it does, every routing decision
        quietly falls back to the expensive worker — which is the exact cost
        this is meant to avoid. Silent fallback is what made an entire test run
        look like bad classification when the classifier was never reached.
      */
      console.warn(`[operator] routing classifier unavailable (${res.status}) — using rules`);
      return null;
    }
    const body = await res.json();
    const answer = body?.candidates?.[0]?.content?.parts?.[0]?.text?.trim().toUpperCase() ?? "";
    if (answer.startsWith("CODE")) {
      return { provider: "claude-code", why: "reads as work on the app itself" };
    }
    if (answer.startsWith("DATA")) {
      return { provider: "gemini", why: "reads as a question about your own data" };
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
export async function routeTask(prompt, available, signal) {
  const fallback = available.includes("claude-code") ? "claude-code" : available[0];

  // Nothing to decide, and no reason to spend a call finding that out.
  if (available.length <= 1) {
    return { provider: fallback, why: "the only worker enabled" };
  }

  const text = String(prompt ?? "").trim();
  if (!text) return { provider: fallback, why: "nothing to classify" };

  const quick = fastPath(text);
  if (quick && available.includes(quick.provider)) return quick;

  const decided = await classify(text, signal);
  if (decided && available.includes(decided.provider)) return decided;

  return { provider: fallback, why: "couldn't tell — sent to the more capable worker" };
}
