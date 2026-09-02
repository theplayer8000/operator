// One line onto his phone when something happened that he did not do.
//
// ## Two channels, on purpose
//
// Web Push AND ntfy, both attempted, results OR'd. That is not belt-and-
// braces nervousness; it is the only arrangement that works given how each
// one fails.
//
// **Push was made the sole channel on 2026-09-01 and that was wrong.** The
// argument for it is still true — RFC 8291 encryption means Apple carries
// ciphertext, where ntfy.sh sees a message id and a topic hash — but it
// optimised the half that was already fine and gave up the half that mattered.
//
// **Measured 2026-09-02**: a push to his iPhone returned  and
// never arrived. Subscription present, VAPID valid, payload encrypted,
// accepted. iOS drops a home-screen web app's push entitlement when the app
// has not been opened recently, and a PWA never gets the durable entitlement a
// native app has.
//
// So the failure mode is the worst kind: **it reports success and delivers
// nothing.** A fallback that fires on error would never fire. Hence both.
//
// The cost is a duplicate when both work, which he has complained about
// before. `OPERATOR_NOTIFY_CHANNELS` trims it once he knows which he trusts.
//
// ## What each one is good at
//
//   Web Push  encrypted end to end, arrives as Operator with Operator's icon,
//             no second app. Unreliable on iOS for the reason above.
//   ntfy      a native app with a durable push entitlement, so it actually
//             wakes. Relays a message id and topic hash through ntfy.sh.
//
// ## The interface never changed
//
// `notify(title, message, opts)`. Every caller — actions.mjs, jobs.mjs, the
// intent digest — has been untouched across both switches, because what kept
// changing was HOW a notification reaches him, not WHEN Operator sends one.
//
// ## Degrade to silence
//
// Never throws, never retries, never queues. A missed notification stays
// missed and the event log remains the record.
//
// No dependencies.

import { sendTo, configured as pushConfigured, publicKey } from "./push.mjs";
import { list as listSubscriptions, remove as forgetSubscription } from "./subscriptions.mjs";
import { sendNtfy, configured as ntfyConfigured, destination as ntfyHost } from "./ntfy.mjs";

/*
  Which channels to use. Both by default, and that is deliberate.

  Measured 2026-09-02: a push to his iPhone returned 201 Created from Apple
  and never arrived — iOS drops a home-screen web app's push entitlement when
  the app has not been opened recently. The server was correct in every
  respect, which is the point: **push reports success and delivers nothing**,
  so a fallback that fires on error would never fire.

  The cost of sending both is a duplicate when both work, which he has
  complained about before. That is the price of not missing one, and this
  variable is how he trims it once he knows which he trusts.
*/
const CHANNELS = (process.env.OPERATOR_NOTIFY_CHANNELS ?? "push,ntfy")
  .split(",")
  .map((c) => c.trim().toLowerCase())
  .filter(Boolean);

const usePush = CHANNELS.includes("push") && pushConfigured;
const useNtfy = CHANNELS.includes("ntfy") && ntfyConfigured;

/** Whether a notification can be sent at all. Read by callers before bothering. */
export const configured = usePush || useNtfy;

/** Re-exported so the API can hand it to a browser that wants to subscribe. */
export { publicKey };

/** Logged once, so serve.log records that push is live and to how many devices. */
let announced = false;

/**
 * Send one notification. Fire-and-forget: `void notify(...)`.
 *
 * @param title   short, read on a lock screen
 * @param message the body
 * @param opts    priority, tags[], click URL
 *
 * ## Priority survived the switch, with different mechanics
 *
 * ntfy mapped priority 1-5 and **only 4 and 5 made the phone ping** — something
 * the owner discovered by testing and I had not. Web Push has no such scale; it
 * has `Urgency`, which governs whether the push service may hold a message back
 * while the device is idle rather than how loudly it arrives.
 *
 * The names are kept because every caller already passes them and they still
 * express the right intent. `high` and `urgent` both map to immediate delivery;
 * anything lower is allowed to wait for the device to wake on its own.
 *
 * @returns true if at least one device accepted it
 */
export async function notify(title, message, opts = {}) {
  if (!configured) return false;

  if (!announced) {
    announced = true;
    const where = [
      usePush ? "Web Push" : null,
      useNtfy ? `ntfy (${ntfyHost()})` : null,
    ].filter(Boolean);
    console.log(`[operator] notifications → ${where.join(" + ")}`);
  }

  /*
    Both channels are attempted, and their results are OR'd rather than one
    gating the other. See the CHANNELS note above: push returns 201 for a
    notification iOS then drops, so there is no failure for a fallback to
    trigger on.
  */
  const sent = [];

  if (usePush) {
    const devices = await listSubscriptions();
    if (devices.length > 0) {
      /*
        The payload the service worker renders. JSON rather than headers,
        because unlike ntfy this is a body the browser decrypts and hands to our
        own code — no protocol reads these fields, only `sw.js`.

        No ASCII folding here. That exists in ntfy.mjs because ntfy puts the
        title in an HTTP HEADER, where a smart quote throws inside fetch before
        the request is made. This is an encrypted body: UTF-8 throughout, so a
        mission called "Don't — seriously" arrives intact.
      */
      const payload = JSON.stringify({
        title: String(title ?? "Operator").slice(0, 200),
        body: String(message ?? "").slice(0, 1000),
        tag: opts.tags?.[0] ?? undefined,
        url: opts.click ?? "/",
        urgent: opts.priority === "urgent" || opts.priority === "max",
      });
      const urgency = opts.priority === "low" || opts.priority === "min" ? "low" : "high";

      const results = await Promise.all(
        devices.map(async (device) => {
          const result = await sendTo(device, payload, { urgency });
          /*
            Forget a subscription the push service says is retired.

            Without this a deleted app leaves an endpoint that fails on every
            notification forever — and because failures are silent by design,
            the only symptom would be Operator getting slower for no visible
            reason.
          */
          if (result.gone) {
            console.log(
              `[operator] push: forgetting a dead subscription (${result.status ?? "invalid"})`,
            );
            await forgetSubscription(device.endpoint).catch(() => {});
          } else if (!result.ok) {
            console.warn(`[operator] push failed (${result.status ?? "-"}): ${result.error ?? ""}`);
          }
          return result.ok;
        }),
      );
      sent.push(results.some(Boolean));
    }
  }

  if (useNtfy) {
    sent.push(await sendNtfy(title, message, opts));
  }

  return sent.some(Boolean);
}
