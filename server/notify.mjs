// One line onto his phone when something happened that he did not do.
//
// ## What changed on 2026-09-01, and what did not
//
// This was a POST to the owner's OWN ntfy server on loopback, which relayed
// through `ntfy.sh` so Apple could wake the iOS app. It is now **Web Push**,
// direct from this process to the browser's push service.
//
// **The interface is deliberately identical.** `notify(title, message, opts)`,
// never throws, never retries, never queues. Every caller — `actions.mjs`,
// `jobs.mjs`, the intent digest — is unchanged, because the decision that
// changed was *how a notification reaches him*, not *when Operator sends one*.
//
// ### Why the switch, stated honestly
//
// The owner's reason was reducing what leaves the machine, and the first answer
// he got was that this does not do that: a push service is unavoidable, because
// it is how a sleeping OS is woken. `ntfy.sh` is replaced by Apple, not by
// nobody.
//
// What it does buy, and why he chose it anyway:
//
//   - **Strictly less content.** RFC 8291 encryption is mandatory and the key is
//     shared only between this server and the browser that subscribed. Apple
//     carries ciphertext. ntfy.sh saw a message id and a topic hash — comparable
//     metadata, but this is provably unreadable rather than merely trusted.
//   - **One fewer service to run.** No local ntfy, no `server.yml`, no
//     `upstream-base-url`, no second app on the phone.
//   - **It says Operator.** Notifications arrive under Operator's own name and
//     icon rather than ntfy's, because the manifest supplies them.
//
// ### Degrade to silence — unchanged, and it matters more now
//
// A missed notification stays missed. No retry buffer, no queue. `CLAUDE.md`'s
// rule applied outbound, and the event log remains the record.
//
// It matters more because there is no fallback channel any more. If push fails
// he simply does not hear about it, which is the trade he accepted knowingly.
//
// No dependencies.

import { sendTo, configured as pushConfigured, publicKey } from "./push.mjs";
import { list as listSubscriptions, remove as forgetSubscription } from "./subscriptions.mjs";

/** Whether a notification can be sent at all. Read by callers before bothering. */
export const configured = pushConfigured;

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

  const devices = await listSubscriptions();
  if (devices.length === 0) {
    if (!announced) {
      announced = true;
      console.log("[operator] push is configured but no device has subscribed yet");
    }
    return false;
  }

  if (!announced) {
    announced = true;
    console.log(`[operator] notifications → Web Push, ${devices.length} device(s)`);
  }

  /*
    The payload the service worker will render. JSON rather than headers,
    because unlike ntfy this is a body the browser decrypts and hands to our own
    code — there is no protocol reading these fields, only `sw.js`.

    No ASCII-folding here. That existed because ntfy put the title in an HTTP
    HEADER, where a smart quote or an em-dash threw inside fetch before the
    request was made. This is an encrypted body: UTF-8 throughout, so a mission
    called "Don't — seriously" arrives intact.
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
        notification forever — and because failures are silent by design, the
        only symptom would be Operator getting slower for no visible reason.
      */
      if (result.gone) {
        console.log(`[operator] push: forgetting a dead subscription (${result.status ?? "invalid"})`);
        await forgetSubscription(device.endpoint).catch(() => {});
      } else if (!result.ok) {
        console.warn(`[operator] push failed (${result.status ?? "-"}): ${result.error ?? ""}`);
      }
      return result.ok;
    }),
  );

  return results.some(Boolean);
}
