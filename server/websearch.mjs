// One search, through Brave — the only way a worker without its own harness can
// know anything that happened after its training cutoff.
//
// ## Why this earns a row of its own
//
// Claude Code has WebSearch inside the Agent SDK. AI Router, Gemini and Ollama
// have no web access at all: they reach `actions.mjs` and stop there. So asked
// "what does this library do now" or "is that service down", three of the four
// workers could only answer from memory, confidently and possibly from two
// years ago.
//
// **What leaves the machine is the QUERY, and nothing else.** Not the prompt
// that produced it, not the job, not a file. That is a smaller disclosure than
// the AI Router approval already covers — and a sharper one, which is why
// CLAUDE.md gives it its own named row rather than letting it ride along: a
// query is short, specific, and states intent far more plainly than the
// paragraph it came from. "Cheapest used RTX 3090 UK" is a sentence about him.
//
// ## Metered, unlike the router
//
// AI Router is flat-rate, so a wasted call there costs nothing. This is roughly
// $5 per 1,000 requests, so two things guard it: a short result cache, because
// a worker that asks the same question twice in a turn is common and the second
// one is pure waste; and a daily ceiling, because a loop is how a metered API
// becomes a bill. Both report themselves rather than failing silently.
//
// Server-side only, like `status.mjs`. The frontend never talks to a provider.
//
// No dependencies.

const env = (name) => (process.env[name] ?? "").replace(/^﻿/, "").trim();

const API_KEY = env("BRAVE_SEARCH_API_KEY");
const BASE_URL = env("BRAVE_SEARCH_URL") || "https://api.search.brave.com/res/v1";

/** Whether this can run at all. Read before offering the action. */
export const configured = Boolean(API_KEY);

const TIMEOUT_MS = 12_000;

/*
  A ceiling, because this one is metered.

  Deliberately a COUNT rather than a dollar figure. ADR 0013's argument applies:
  the store keeps the thing that was actually observed and derives money from
  it, so counting requests is honest and pricing them is a guess about a plan
  this file cannot see.
*/
const DAILY_MAX = Number(env("OPERATOR_SEARCH_DAILY_MAX") || 200);
let day = "";
let spent = 0;

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/*
  A short cache.

  Five minutes, keyed on the exact query. Long enough to absorb a worker asking
  the same thing twice while it reasons, short enough that "is it down" is not
  answered from an hour ago. Bounded so a long-running server cannot grow it
  without limit.
*/
const CACHE_MS = 5 * 60_000;
const CACHE_MAX = 200;
const cache = new Map();

export class SearchError extends Error {}

/**
 * Search the web.
 *
 * @returns {Promise<{query: string, count: number, results: object[], cached?: boolean}>}
 */
export async function search({ query, count = 5, freshness } = {}) {
  const q = String(query ?? "").trim();
  if (!q) throw new SearchError("query is required");
  if (!API_KEY) {
    throw new SearchError(
      "BRAVE_SEARCH_API_KEY is not set. Set it with the secret_set action (never by typing setx in the terminal — that logs the value), then restart.",
    );
  }

  const n = Math.max(1, Math.min(Number(count) || 5, 20));
  const key = `${q}::${n}::${freshness ?? ""}`;

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    return { ...hit.value, cached: true };
  }

  if (day !== today()) {
    day = today();
    spent = 0;
  }
  if (spent >= DAILY_MAX) {
    throw new SearchError(
      `the daily search ceiling of ${DAILY_MAX} requests is used up. It resets at midnight, or raise OPERATOR_SEARCH_DAILY_MAX. This provider is metered per request, unlike the flat-rate router.`,
    );
  }

  const url = new URL(`${BASE_URL}/web/search`);
  url.searchParams.set("q", q);
  url.searchParams.set("count", String(n));
  if (freshness) url.searchParams.set("freshness", String(freshness));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let body;
  try {
    spent += 1;
    const res = await fetch(url, {
      headers: {
        accept: "application/json",
        "accept-encoding": "gzip",
        "x-subscription-token": API_KEY,
      },
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      throw new SearchError("Brave refused the key. Check BRAVE_SEARCH_API_KEY and that the plan is active.");
    }
    if (res.status === 429) {
      throw new SearchError("Brave is rate-limiting. Wait a moment rather than retrying in a loop.");
    }
    if (!res.ok) {
      throw new SearchError(`Brave returned ${res.status}`);
    }
    body = await res.json();
  } catch (err) {
    if (err instanceof SearchError) throw err;
    /*
      Degrade to a sentence, never to a stack trace. CLAUDE.md's rule for an
      external host is that it being down must not break what depends on it —
      here that means the worker gets something it can say out loud.
    */
    throw new SearchError(
      controller.signal.aborted
        ? `the search timed out after ${TIMEOUT_MS / 1000}s — treat it as unavailable rather than as no results`
        : `could not reach Brave: ${err?.message ?? err}`,
    );
  } finally {
    clearTimeout(timer);
  }

  /*
    Trimmed to what a model can use. The raw payload carries thumbnails,
    profiles, ratings and deep-link trees — kilobytes per result that cost
    context and answer nothing. Title, URL, description, age.
  */
  const results = (body?.web?.results ?? []).slice(0, n).map((r) => ({
    title: r.title,
    url: r.url,
    description: String(r.description ?? "").replace(/<\/?strong>/g, ""),
    ...(r.age ? { age: r.age } : {}),
  }));

  const value = { query: q, count: results.length, results, spentToday: spent, dailyMax: DAILY_MAX };

  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), value });

  return value;
}
