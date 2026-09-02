/**
 * Who currently owns the microphone, so something outside the page can toggle it.
 *
 * ## Why this exists
 *
 * The desktop shell's tray menu and `Ctrl+Alt+M` both emit
 * `operator://toggle-mic`, and the listener for it lived on the map page. So
 * the "global" hotkey worked on exactly two routes and did nothing on the other
 * eleven — including the Dev page, which is where you sit when you are watching
 * logs and reaching for the tray. The owner's report was that the tray icon and
 * the hotkey "still don't work"; they did, on one screen.
 *
 * The listener now lives in `AppLayout`, which is mounted everywhere. But the
 * microphone itself belongs to the page that opened the stream — there must
 * stay exactly one owner of the device — so the layout cannot simply do the
 * work itself.
 *
 * Hence a register: the page that holds the stream says so, and the layout asks
 * it. When no page holds one, the toggle is remembered and replayed as soon as
 * one mounts, so pressing the key from Settings navigates to the map and the
 * microphone is on when you arrive rather than needing a second press.
 */

export type MicController = {
  active: boolean;
  enable: () => void | Promise<void>;
  disable: () => void;
};

let controller: MicController | null = null;
let pending = false;

/**
 * Called by whichever page owns the stream, on every render.
 *
 * Cheap on purpose: `useMicLevel` returns a fresh object each render, and a
 * subscription that tore down and rebuilt on that identity change is the exact
 * bug that made the tray look broken the first time. Assigning a reference has
 * no teardown to get wrong.
 *
 * Pass `null` on unmount.
 */
export function registerMic(next: MicController | null): void {
  controller = next;
  if (next && pending) {
    pending = false;
    toggleMic();
  }
}

/**
 * Toggle the microphone.
 *
 * @returns true if a page handled it; false if the request was queued because
 *          nothing owns a stream yet — the caller should navigate somewhere
 *          that does.
 */
export function toggleMic(): boolean {
  if (!controller) {
    pending = true;
    return false;
  }
  if (controller.active) controller.disable();
  else void controller.enable();
  return true;
}
