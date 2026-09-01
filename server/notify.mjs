// Push a notification to the owner's phone, through his own ntfy server.
//
// ## What this is for
//
// One thing, really: **a turn has stopped and is waiting on him.** A permission
// question suspends the running turn and times out after thirty minutes, and
// until now the only way to discover one was to open the app and look. He is
// usually not looking — that is the entire point of a system that works while
// he is at work.
//
// ## Where it sends, and what leaves the machine
//
// `OPERATOR_NTFY_URL` is his own ntfy server, on this box, listening on
// loopback and exposed to the tailnet by `tailscale serve` — the same shape as
// Operator's own API. The notification body never leaves hardware he owns.
//
// **ntfy.sh is involved, and he approved it by name on 2026-08-31** (see the
// approvals table in CLAUDE.md). His server forwards a *poll request* upstream
// — a message ID and a hash of the topic, not the title and not the body — so
// Apple can wake the iOS app, which then fetches the actual content back from
// this machine. Without it iOS push is polling, which is late and unreliable.
// What crosses is metadata: that a notification happened, and when.
//
// ## Environment only
//
// `OPERATOR_NTFY_URL`, `OPERATOR_NTFY_TOPIC`, `OPERATOR_NTFY_TOKEN`. Not in
// `data/operator.json`, not app-editable, for a reason stronger than
// consistency with `OPERATOR_APPS`: a worker has `Write` everywhere, so a
// destination stored on disk is one a running agent could repoint at any host
// it liked — turning this into a general outbound channel with Operator's own
// code doing the sending. Only the desk can set where this points.
//
// ## Degrade to silence
//
// Never throws, never retries, never queues. A missed notification is a missed
// notification; the event log and the Orchestrator remain the record. Building
// a retry buffer would be inventing a delivery guarantee this does not have,
// and CLAUDE.md's "degrade to silence" rule applied outbound.

/*
  Strip a byte-order mark as well as whitespace.

  Not theoretical: PowerShell 5.1's `Set-Content -Encoding utf8` writes a BOM,
  so a value round-tripped through a file arrives as "﻿operator-..." and
  the POST 404s against a topic that looks identical in every log. This cost a
  debugging round here and another one in the transcriber on the same day.
*/
const env = (name) =>
  (process.env[name] ?? "").replace(/^﻿/, "").trim();

const URL_BASE = env("OPERATOR_NTFY_URL").replace(/\/+$/, "");
const TOPIC = env("OPERATOR_NTFY_TOPIC");
const TOKEN = env("OPERATOR_NTFY_TOKEN");

/** Long enough for a loopback POST, short enough never to hold up a turn. */
const TIMEOUT_MS = 3000;

/** Logged once, so `serve.log` records where notifications actually go. */
let announced = false;

export const configured = Boolean(URL_BASE && TOPIC);

/**
 * Send one notification. Fire-and-forget: `void notify(...)`.
 *
 * @param title   short, read on a lock screen
 * @param message the body
 * @param opts    priority, tags[], click URL
 *
 * ## Priority is not cosmetic, and the default is wrong for this app
 *
 * ntfy maps them 1-5: min, low, default, high, urgent. **Only 4 and 5 make the
 * phone actually ping** — 1 to 3 arrive silently and are found later, which the
 * owner discovered by testing and I had not.
 *
 * That makes "default" the wrong default here. Operator only sends a
 * notification when something happened that he did not do, so silent delivery
 * defeats the entire purpose: everything is at least `high`, and a suspended
 * turn waiting on an answer is `urgent`.
 * @returns true if it was accepted, false if unconfigured or it failed
 */
export async function notify(title, message, opts = {}) {
  if (!configured) return false;

  if (!announced) {
    announced = true;
    try {
      console.log(`[operator] notifications → ${new URL(URL_BASE).host}`);
    } catch {
      console.log(`[operator] notifications → ${URL_BASE}`);
    }
  }

  const headers = { "content-type": "text/plain; charset=utf-8" };
  /*
    Header values must be latin-1 — a smart quote or an em-dash in a job title
    throws inside fetch before the request is made, which would turn a
    notification into an unhandled rejection in the middle of a turn.
  */
  const ascii = (s) =>
    String(s ?? "")
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/[–—]/g, "-")
      .replace(/[^\x20-\x7E]/g, "")
      .slice(0, 200);

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
      console.warn(`[operator] notify: ntfy returned ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    // Warned once per failure but never thrown. A dead ntfy must not be able to
    // affect a turn that was otherwise fine.
    console.warn(`[operator] notify failed: ${err?.message ?? err}`);
    return false;
  }
}
