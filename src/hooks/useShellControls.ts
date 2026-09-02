import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { logToShell, onToggleDetector, onToggleMic } from "@/lib/desktop";
import { toggleMic } from "@/lib/micBridge";

/**
 * The desktop shell's two toggles — the tray menu's microphone lines, and
 * Ctrl+Alt+M — wired up on every route.
 *
 * ## Why this is a hook mounted in `App`, and not in `AppLayout`
 *
 * These listeners lived on the map page until 2026-09-02, which meant a GLOBAL
 * hotkey and a tray icon that is permanently on screen both did nothing on
 * eleven of the thirteen routes. The owner reported the tray as broken for the
 * third time, and he was right for a third distinct reason: it worked, on the
 * one page you are least likely to be looking at when you reach for the tray.
 *
 * `AppLayout` looks like the obvious home and is not: the map is deliberately
 * OUTSIDE it — no sidebar, no topbar — so putting them there would have fixed
 * eleven routes by breaking the two that already worked. `App` renders every
 * route, including that one.
 *
 * ## Registered once, with no live dependencies
 *
 * `listen()` is async, so an effect that re-runs tears the listener down and
 * leaves a gap with nothing subscribed. That churn is what made the first
 * version of this look broken, and re-introducing it would look identical.
 */
export function useShellControls(): void {
  const navigate = useNavigate();
  /*
    Read through a ref so the effect below can have an EMPTY dependency list.

    `useNavigate` does not promise a stable identity across renders, and an
    effect that lists it re-runs on navigation — tearing the listener down and
    rebuilding it. `listen()` is async, so each of those cycles leaves a window
    with nothing subscribed, and a tray click landing in one of them does
    nothing at all. That is the precise failure this hook exists to fix, so it
    must not be reintroduced by the fix's own dependency array.
  */
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  useEffect(() => {
    let stopMic = () => {};
    let stopDetector = () => {};

    void onToggleMic(() => {
      /*
        The page that opened the stream does the toggling — there is exactly one
        owner of the device. When no page holds one, `micBridge` remembers the
        request and replays it on mount, so this navigates to the surface that
        has a microphone and it is already on when you arrive.
      */
      const handled = toggleMic();
      void logToShell(`toggle-mic received — ${handled ? "a page owns the mic" : "no owner, going to the map"}`);
      if (!handled) navigateRef.current("/");
    }).then((off) => {
      void logToShell("toggle-mic listener registered");
      stopMic = off;
    });

    /*
      The detector goes through `/api/`, not through the shell, so the request
      carries an identity like every other one. A native binary reaching past
      authentication because it happens to be local is the shape of bypass this
      project spent an ADR closing.

      State is read from the server rather than from a page's copy of it. That
      is what lets this live outside any page without a second poller running on
      every route just to know which way to flip.
    */
    void onToggleDetector(() => {
      void fetch("/api/listen")
        .then((r) => (r.ok ? r.json() : null))
        .then((state) =>
          fetch("/api/listen/detector", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ on: !state?.listening }),
          }),
        )
        .catch(() => {});
    }).then((off) => {
      stopDetector = off;
    });

    return () => {
      stopMic();
      stopDetector();
    };
    // Empty on purpose — see `navigateRef` above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
