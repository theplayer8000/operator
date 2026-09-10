import { onShellFocusChange } from "./desktop";

/**
 * Whether a canvas animation loop should be running right now.
 *
 * ## Why this exists
 *
 * `requestAnimationFrame` is throttled to roughly nothing by a real browser
 * when its tab is hidden. **WebView2 — the engine behind the Tauri desktop
 * shell — does not do that for a window that is merely behind another one.**
 * It keeps firing rAF at the full frame rate for an occluded window, so the
 * core's canvas loop (and the mission map's physics) kept pinning the GPU
 * while the shell sat unwatched behind an editor. Killing the process was the
 * stopgap; this is the fix.
 *
 * Three signals, because no one of them covers every case:
 *
 * - `document.hidden` — the window is minimised, or a browser tab is in the
 *   background. Fires `visibilitychange`.
 * - `document.hasFocus()` — a *browser* window sitting behind another app. In
 *   the shell this one lies (it stays true when backgrounded), which is what
 *   made the bug recurring.
 * - the Tauri window's own focus event — the shell backgrounded but not
 *   minimised, the case the other two miss. Wired through `desktop.ts`, and
 *   inert in a browser.
 *
 * ## The tradeoff, chosen deliberately
 *
 * A `MissionMap` left live on a second monitor as an ambient display will
 * freeze while you work on the other screen and jump back to motion when you
 * click it. Accepted: the recurring, real cost is a hidden shell burning the
 * GPU, and the owner runs the shell that way, not a wall display. Revisit here
 * if a genuine always-on display setup appears.
 */

let shellBackgrounded = false;

export const shouldAnimate = (): boolean =>
  typeof document === "undefined" ||
  (!shellBackgrounded && !document.hidden && (document.hasFocus?.() ?? true));

/*
  Set up the shell focus watch exactly once, however many loops call
  watchAnimatable. A no-op in a browser (onShellFocusChange returns early).
*/
let shellWatchStarted = false;
function ensureShellWatch(): void {
  if (shellWatchStarted) return;
  shellWatchStarted = true;
  void onShellFocusChange((focused) => {
    shellBackgrounded = !focused;
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event("operator:rendergate"));
    }
  });
}

/**
 * Run `sync` whenever visibility or focus changes, so a loop can stop
 * rescheduling rAF when `shouldAnimate()` goes false and start again when it
 * comes back. Returns an unsubscribe.
 */
export function watchAnimatable(sync: () => void): () => void {
  if (typeof document === "undefined") return () => {};
  ensureShellWatch();
  document.addEventListener("visibilitychange", sync);
  window.addEventListener("focus", sync);
  window.addEventListener("blur", sync);
  window.addEventListener("operator:rendergate", sync);
  return () => {
    document.removeEventListener("visibilitychange", sync);
    window.removeEventListener("focus", sync);
    window.removeEventListener("blur", sync);
    window.removeEventListener("operator:rendergate", sync);
  };
}
