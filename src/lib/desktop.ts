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
 * Run `handler` when the tray's clap-detector line is clicked.
 *
 * The page does this rather than the shell calling the server directly, so the
 * request goes through `/api/` and its identity check like every other one. A
 * native binary reaching past authentication because it happens to be local is
 * exactly the shape of bypass this project spent an ADR closing.
 */
export async function onToggleDetector(handler: () => void): Promise<() => void> {
  if (!isDesktop()) return () => {};
  try {
    const { listen } = await import("@tauri-apps/api/event");
    return await listen("operator://toggle-detector", () => handler());
  } catch {
    return () => {};
  }
}

/**
 * Run `handler` when the shell window gains or loses OS focus (and once, now,
 * with the current state).
 *
 * `document.hasFocus()` is unreliable inside the WebView2 window — it stays
 * `true` for a window sitting behind another one, which is exactly the state
 * that had the core's canvas loop pinning the GPU with nobody watching. The
 * Tauri window's own focus event is the signal that actually tracks it.
 *
 * A no-op in a browser, where the ordinary `document`/`window` focus and
 * visibility events are enough — see `lib/renderGate.ts`.
 */
export async function onShellFocusChange(
  handler: (focused: boolean) => void,
): Promise<() => void> {
  if (!isDesktop()) return () => {};
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    try {
      // `is_focused` is not in the shell's ACL, so this throws — harmless, the
      // event below drives everything. Left in for when the ACL grows it.
      handler(await win.isFocused());
    } catch {
      /* first read unavailable; the event is the real signal */
    }
    return await win.onFocusChanged(({ payload }) => handler(payload));
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
 * Tell the tray about BOTH microphones.
 *
 * Two flags, not one, because there are two different things and reporting them
 * as "the microphone" is what made this confusing to reason about:
 *
 * - `detector` — always-on, server-side, reduces the stream to one number per
 *   chunk. It can hear a clap and cannot produce words.
 * - `dictation` — this device's stream, opened only when asked, and the one
 *   that becomes text.
 *
 * The shell cannot know either on its own. ADR 0015 made "off by default and
 * visibly so" a condition of having a desktop client at all, and a tray that
 * guessed would be worse than no tray.
 */
export async function reportMicState(dictation: boolean, detector: boolean): Promise<void> {
  if (!isDesktop()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("set_mic_state", { dictation, detector });
  } catch {
    /* The shell is a nicety; the page works without it. */
  }
}

/**
 * Write one line into `data/shell.log`, from the page.
 *
 * The shell can log that it emitted an event; only the page knows what happened
 * next, and the release build has no console to print it to. Without this the
 * two halves of one gesture are observable from opposite sides of a wall — which
 * is how the tray came to be reported broken three times for three different
 * reasons.
 *
 * A no-op in a browser, like everything else here.
 */
export async function logToShell(text: string): Promise<void> {
  if (!isDesktop()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("log_line", { text });
  } catch {
    /* Logging must never be the thing that breaks. */
  }
}

/**
 * Make external links work in the shell.
 *
 * ## The bug this fixes
 *
 * The Dev page links out to GitHub with ordinary `target="_blank"` anchors — the
 * Repository button, a branch's commits, a file blob. In a browser they open a
 * tab. In the Tauri window they do **nothing whatsoever**: there is no tab to
 * open, and the webview does not hand an external URL to the OS on its own. The
 * buttons simply did not respond, while the same page worked at :8443 — which
 * reads exactly like a permissions problem and is not one. Custom commands are
 * not gated by `capabilities/default.json`, which is why the rest of this file
 * has worked all along.
 *
 * ## Why one document listener rather than fixing each link
 *
 * There are anchors on the Dev page, in the Updates changelog and in rendered
 * markdown, and markdown links are generated at runtime — so there is no set of
 * components to go and fix. One capturing listener covers every anchor that
 * exists now and every one added later, including ones inside content nobody
 * wrote by hand.
 *
 * A no-op in a browser, like everything else here — so the web app keeps its
 * ordinary behaviour and nothing is intercepted for the phone.
 *
 * @returns a function that stops intercepting.
 */
export function interceptExternalLinks(): () => void {
  if (!isDesktop() || typeof document === "undefined") return () => {};

  const onClick = (event: MouseEvent) => {
    // Let a modified click do whatever the platform would do, and ignore
    // anything that another handler has already dealt with.
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    const anchor = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!anchor) return;

    // `anchor.href` is resolved against the page, so a relative in-app link
    // reads as the app's own origin and is left alone for React Router.
    const href = anchor.href;
    if (!/^https?:/i.test(href)) return;
    if (href.startsWith(window.location.origin)) return;

    event.preventDefault();
    void (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("open_external", { url: href });
      } catch (err) {
        // Said out loud rather than swallowed: a link that silently does
        // nothing is the exact failure this function exists to end, and a
        // silent catch here would recreate it one layer down.
        void logToShell(`open_external failed for ${href}: ${String(err)}`);
      }
    })();
  };

  document.addEventListener("click", onClick, true);
  return () => document.removeEventListener("click", onClick, true);
}
