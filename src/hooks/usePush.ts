import { useCallback, useEffect, useState } from "react";

/**
 * Notifications on this device, through Web Push.
 *
 * ## Why this replaced ntfy
 *
 * ntfy needed a second app on the phone, its own server, and — because iOS
 * cannot be woken by a self-hosted host — a relay through `ntfy.sh` that
 * carried a message id and a topic hash off the machine.
 *
 * Web Push does not remove the third party: a push service is how a sleeping OS
 * is woken, and on iOS that is Apple. What it changes is that the payload is
 * **encrypted end to end** (RFC 8291) with a key only Operator's server and
 * this browser share, so the carrier holds ciphertext rather than a trusted
 * promise not to look. And the notification arrives as **Operator**, with
 * Operator's icon, because the manifest supplies them.
 *
 * ## The iOS rules that shape this
 *
 * Two, and both are why this is a button rather than something automatic:
 *
 * 1. **Only the installed app may ask.** `Notification.requestPermission()` in
 *    a Safari tab is refused outright — the page has to have been added to the
 *    home screen and opened from there.
 * 2. **It needs a real tap.** The prompt cannot be raised from an effect on
 *    load; the gesture has to be the user's.
 *
 * So `subscribe()` must be called from a click handler, never from an effect.
 */

export type PushState =
  | "unsupported"
  | "not-installed"
  | "unconfigured"
  | "denied"
  | "off"
  | "on";

export interface Push {
  state: PushState;
  /** Human-readable reason, when the state alone does not explain it. */
  detail: string | null;
  busy: boolean;
  /** MUST be called from a user gesture — see the note above. */
  subscribe: () => Promise<void>;
  unsubscribe: () => Promise<void>;
}

/**
 * base64url → the raw bytes `pushManager.subscribe` insists on.
 *
 * Built over an explicit `ArrayBuffer` rather than `Uint8Array.from`, because
 * the DOM types require an `ArrayBufferView<ArrayBuffer>` and the inferred
 * `Uint8Array<ArrayBufferLike>` includes `SharedArrayBuffer`, which is not
 * assignable. Allocating the buffer first pins the type without a cast.
 */
function decodeKey(base64url: string): ArrayBuffer {
  const padded = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const buffer = new ArrayBuffer(raw.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return buffer;
}

export function usePush(): Push {
  const [state, setState] = useState<PushState>("off");
  const [detail, setDetail] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (typeof window === "undefined") return;

    /*
      Service workers need a secure context, which over Tailscale means the
      `.ts.net` hostname and NOT a bare `100.x` address. `docs/known-issues.md`
      has the same trap for the microphone, and it presents identically here:
      the API is simply absent, with no error explaining why.
    */
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      setState("unsupported");
      setDetail(
        window.isSecureContext
          ? "This browser has no push support."
          : "Not a secure context — open Operator by its .ts.net address, not its IP.",
      );
      return;
    }

    /*
      iOS refuses to subscribe from a browser tab. Detecting the standalone
      display mode lets the UI say "add it to your home screen first" instead of
      showing a button that silently fails.
    */
    const standalone =
      window.matchMedia?.("(display-mode: standalone)").matches ||
      // Safari's own flag, which predates the standard media query.
      (navigator as unknown as { standalone?: boolean }).standalone === true;
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    if (isIOS && !standalone) {
      setState("not-installed");
      setDetail("On iPhone, add Operator to your home screen first — Safari cannot subscribe.");
      return;
    }

    if (Notification.permission === "denied") {
      setState("denied");
      setDetail("Notifications are blocked for this site in your browser settings.");
      return;
    }

    try {
      const res = await fetch("/api/push/key");
      const body = await res.json();
      if (!body?.configured || !body?.publicKey) {
        setState("unconfigured");
        setDetail("The server has no VAPID keys — run scripts/push-keys.mjs.");
        return;
      }
      const registration = await navigator.serviceWorker.getRegistration();
      const existing = await registration?.pushManager.getSubscription();
      setState(existing ? "on" : "off");
      setDetail(null);
    } catch (err) {
      setState("off");
      setDetail(String((err as Error)?.message ?? err));
    }
  }, []);

  useEffect(() => {
    /*
      Register the worker on load, but never ASK for permission here. Registering
      is silent; asking from an effect is refused on iOS and, on desktop, is the
      thing that trains people to hit Block.
    */
    if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
    void refresh();
  }, [refresh]);

  const subscribe = useCallback(async () => {
    setBusy(true);
    try {
      const keyRes = await fetch("/api/push/key");
      const { publicKey } = await keyRes.json();
      if (!publicKey) throw new Error("the server has no push key");

      const registration = await navigator.serviceWorker.register("/sw.js");
      // `ready` rather than the register() result: a worker that is registered
      // but not yet activated cannot hold a subscription.
      await navigator.serviceWorker.ready;

      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission === "denied" ? "denied" : "off");
        setDetail(permission === "denied" ? "You blocked notifications." : "Not granted.");
        return;
      }

      const subscription = await registration.pushManager.subscribe({
        /*
          Required to be true, and it is not a formality: a subscription that
          allows silent pushes can be revoked by the browser for abusing them.
          Every push Operator sends shows a notification — `sw.js` guarantees
          it even for a malformed payload.
        */
        userVisibleOnly: true,
        applicationServerKey: decodeKey(publicKey),
      });

      const res = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subscription: subscription.toJSON() }),
      });
      if (!res.ok) throw new Error(`server refused the subscription (${res.status})`);

      setState("on");
      setDetail(null);
    } catch (err) {
      setDetail(String((err as Error)?.message ?? err));
    } finally {
      setBusy(false);
    }
  }, []);

  const unsubscribe = useCallback(async () => {
    setBusy(true);
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) {
        /*
          Tell the server FIRST. If the browser unsubscribes and the POST then
          fails, the server keeps pushing to a dead endpoint — recoverable, but
          it means every notification carries a failure until something prunes
          it. This order leaves the harmless residue instead.
        */
        await fetch("/api/push/unsubscribe", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ endpoint: subscription.endpoint }),
        }).catch(() => {});
        await subscription.unsubscribe();
      }
      setState("off");
      setDetail(null);
    } catch (err) {
      setDetail(String((err as Error)?.message ?? err));
    } finally {
      setBusy(false);
    }
  }, []);

  return { state, detail, busy, subscribe, unsubscribe };
}
