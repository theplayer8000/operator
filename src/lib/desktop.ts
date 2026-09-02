/**
 * The desktop shell, when there is one.
 *
 * ## Why this is a thin wrapper and not a dependency
 *
 * The app runs in three places — a browser on the desk, a browser on the phone,
 * and the Tauri window — and exactly one of them has a native host. Importing
 * `@tauri-apps/api` at the top of a component would put a desktop-only module
 * in the bundle the phone downloads, and break the page anywhere the global is
 * absent.
 *
 * So everything here is guarded and dynamic: `isDesktop()` is a runtime check,
 * the import happens inside the function, and every failure is swallowed. The
 * web app must not be able to tell that this file exists.
 *
 * ## What the shell is allowed to do
 *
 * Only what a browser refused — see ADR 0015. It is summoned, and it reports
 * the microphone's state so the tray can show it. It does not OWN the
 * microphone: `useMicLevel` already handles device choice, the level meter and
 * the Bluetooth reconnect, and a second owner in Rust would be two things
 * fighting over one device. That is how the desktop clap detector broke.
 */

/** True only inside the Tauri window. */
export function isDesktop(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Run `handler` when the shell is summoned by the hotkey or the tray.
 *
 * @returns a function that stops listening, or a no-op in a browser.
 */
export async function onSummoned(handler: () => void): Promise<() => void> {
  if (!isDesktop()) return () => {};
  try {
    const { listen } = await import("@tauri-apps/api/event");
    return await listen("operator://summoned", () => handler());
  } catch {
    return () => {};
  }
}

/**
 * Run `handler` when the tray's microphone line is clicked.
 *
 * The tray asks; the page decides. The shell never touches the device — the
 * stream belongs to `useMicLevel`, and a second owner in Rust would be two
 * things fighting over one microphone, which is exactly how the desktop clap
 * detector broke.
 */
export async function onToggleMic(handler: () => void): Promise<() => void> {
  if (!isDesktop()) return () => {};
  try {
    const { listen } = await import("@tauri-apps/api/event");
    return await listen("operator://toggle-mic", () => handler());
  } catch {
    return () => {};
  }
}

/**
 * Bring the window to the front. Used by the clap.
 *
 * Only worth calling when Operator is NOT already focused: clapping while
 * looking at it should do nothing, and raising a window that is already in
 * front is a flicker rather than a feature.
 */
export async function summonWindow(): Promise<void> {
  if (!isDesktop()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("summon_window");
  } catch {
    /* The shell is a nicety; the page works without it. */
  }
}

/**
 * Leave fullscreen if the shell is in it.
 *
 * @returns true when it actually left, so the caller can treat Escape as
 *          consumed. Always false in a browser, where the page never put itself
 *          fullscreen in the first place.
 */
export async function exitFullscreen(): Promise<boolean> {
  if (!isDesktop()) return false;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return Boolean(await invoke("exit_fullscreen"));
  } catch {
    return false;
  }
}

/**
 * Tell the tray whether the microphone is open.
 *
 * The shell cannot know this on its own — the stream lives in the page. The
 * ADR made "off by default and visibly so" a condition of accepting a desktop
 * client at all, and a tray that guesses would be worse than no tray: the whole
 * point is that he can tell at a glance whether Operator is listening.
 */
export async function reportMicState(active: boolean): Promise<void> {
  if (!isDesktop()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("set_mic_state", { active });
  } catch {
    /* The shell is a nicety; the page works without it. */
  }
}
