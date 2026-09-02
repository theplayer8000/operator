// The reliable notification channel: a POST to the owner's own ntfy server.
//
// ## Why this came back
//
// It was retired on 2026-09-01 for Web Push, on the argument that push is
// encrypted end to end while ntfy relays a message id and a topic hash. That
// argument is still true and it was the wrong trade, because it optimised the
// thing that was already fine and gave up the thing that mattered.
//
// **Measured 2026-09-02**: a push to his iPhone returned `201 Created` from
// Apple and never arrived. The server was entirely correct — subscription
// present, VAPID valid, payload encrypted, accepted. iOS simply drops a
// home-screen web app's push entitlement when the app has not been opened for a
// while, and a PWA never gets the durable entitlement a native app has.
//
// So the failure mode is the worst kind: **push reports success and delivers
// nothing.** A fallback that fires only on error would never fire.
//
// ## Hence both, not a fallback
//
// `notify.mjs` sends to every configured channel rather than trying one and
// catching the other, because there is no error to catch. The cost is a
// duplicate when both work — which the owner has complained about before
// ("why dem notifs send twice") — and that is the price of not missing one.
// `OPERATOR_NOTIFY_CHANNELS` trims it back when he decides which he trusts.
//
// ## Degrade to silence
//
// Never throws, never retries, never queues. A dead ntfy must not be able to
// affect a turn that was otherwise fine.
//
// No dependencies.

/*
  Strip a byte-order mark as well as whitespace.

  Not theoretical: PowerShell 5.1's `Set-Content -Encoding utf8` writes a BOM,
  so a value round-tripped through a file arrives as "﻿operator-..." and the
  POST 404s against a topic that looks identical in every log.
*/
const env = (name) => (process.env[name] ?? "").replace(/^\uFEFF/, "").trim();

const URL_BASE = env("OPERATOR_NTFY_URL").replace(/\/+$/, "");
const TOPIC = env("OPERATOR_NTFY_TOPIC");
const TOKEN = env("OPERATOR_NTFY_TOKEN");

/** Long enough for a loopback POST, short enough never to hold up a turn. */
const TIMEOUT_MS = 3000;

export const configured = Boolean(URL_BASE && TOPIC);

/**
 * Header values must be latin-1.
 *
 * A smart quote or an em-dash in a mission title throws inside `fetch` BEFORE
 * the request is made, which would turn a notification into an unhandled
 * rejection in the middle of a turn. Web Push has no such limit — it carries an
 * encrypted UTF-8 body — which is why this folding lives here and not in the
 * shared payload.
 */
const ascii = (s) =>
  String(s ?? "")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[^\x20-\x7E]/g, "")
    .slice(0, 200);

/**
 * Send one notification through ntfy.
 *
 * ## Priority is not cosmetic, and the default is wrong for this app
 *
 * ntfy maps 1-5: min, low, default, high, urgent. **Only 4 and 5 make the phone
 * actually ping** — 1 to 3 arrive silently and are found later, which the owner
 * discovered by testing and I had not.
 *
 * Operator only sends a notification when something happened that he did not
 * do, so silent delivery defeats the entire purpose. Everything is at least
 * `high`, and a turn suspended on a question is `urgent`.
 *
 * @returns true if ntfy accepted it
 */
export async function sendNtfy(title, message, opts = {}) {
  if (!configured) return false;

  const headers = { "content-type": "text/plain; charset=utf-8" };
  if (title) headers.Title = ascii(title);
  if (opts.priority) headers.Priority = String(opts.priority);
  if (opts.tags?.length) headers.Tags = opts.tags.map(ascii).join(",");
  if (opts.click) headers.Click = ascii(opts.click);
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;

  try {
    const res = await fetch(`${URL_BASE}/${TOPIC}`, {
      method: "POST",
      headers,
      body: String(message ?? "").slice(0, 4000),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[operator] ntfy returned ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[operator] ntfy failed: ${err?.message ?? err}`);
    return false;
  }
}

/** Where notifications go, for the one-time startup line. */
export function destination() {
  if (!configured) return null;
  try {
    return new URL(URL_BASE).host;
  } catch {
    return URL_BASE;
  }
}
