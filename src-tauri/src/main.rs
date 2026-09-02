// A native window around the app the server already serves.
//
// Read src-tauri/README.md and ADR 0015 before adding anything here. The short
// version: this file is a container. Anything Operator should be able to DO
// belongs in server/actions.mjs, where Gemini and the local model can reach it
// too — a capability that lives in the desktop shell is one only the desktop
// has, which is the boundary ADR 0014 draws for plugins and it applies equally
// here.
//
// So what IS allowed in here is narrow: the things a browser tab refused.
// Summoning a window that is not focused, staying alive with no window open,
// and showing the microphone's state where it cannot be missed.

// No console window behind the app in a release build. Kept in debug, because
// that is where Rust panics are actually read.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager, State, WindowEvent,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

/// Write one line to `data/shell.log`, and to stdout when there is one.
///
/// The release binary is built `windows_subsystem = "windows"`, which means it
/// has NO CONSOLE — so every `println!` in it goes nowhere. That is fine until
/// something fails silently, which this shell has now done three separate ways:
/// a hotkey that never registered, a tray click that opened nothing, and a
/// `set_focus()` that returned Ok and did not focus.
///
/// Each of those cost a round of "it's fixed" / "no it isn't". A file the log
/// can be read from afterwards is the cheapest possible answer to that, and it
/// is the same reason `serve.log` exists on the Node side.
fn log(line: &str) {
    println!("{line}");
    let path = std::path::Path::new("D:/Projects/operator/data/shell.log");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        use std::io::Write;
        let _ = writeln!(f, "{line}");
    }
}

/// Bring the window back, wherever it went.
///
/// Unminimise, show and focus, in that order — a window that is merely shown
/// while still minimised stays in the taskbar, which looks exactly like the
/// hotkey not working.
fn summon(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        eprintln!("[operator] summon: no window named \"main\"");
        return;
    };
    {
        let _ = window.unminimize();
        let _ = window.show();

        /*
          Onto the chosen screen, fullscreen — the gesture he already had.

          `focus_operator` in server/actions.mjs does this for the BROWSER, by
          finding a window titled "Operator" and sending F11. That helper would
          find this window too, since the title matches, but F11 is a browser
          convention and does nothing here. Hence doing it natively.

          `OPERATOR_FOCUS_SCREEN` is read from the same variable so the two
          behave identically and there is one place to change it. It is 1-based
          to match what a person calls their screens, and clamped rather than
          erroring — unplugging a monitor should fall back to the first, not
          break the gesture.
        */
        let index = std::env::var("OPERATOR_FOCUS_SCREEN")
            .ok()
            .and_then(|v| v.trim().parse::<usize>().ok())
            .unwrap_or(1)
            .max(1);

        /*
          Already fullscreen means leave it alone.

          The browser version measures before sending F11 for exactly this
          reason: F11 TOGGLES, so a blind send throws him OUT of fullscreen when
          he summons while already there. `is_fullscreen()` makes that
          measurement exact rather than inferred from window bounds.
        */
        let already = window.is_fullscreen().unwrap_or(false);
        if already {
            log("[operator] summon: already fullscreen, just focusing");
        } else {
            match window.available_monitors() {
                Ok(monitors) if !monitors.is_empty() => {
                    let pick = index.min(monitors.len()) - 1;
                    let position = *monitors[pick].position();
                    /*
                      Position BEFORE fullscreen. Fullscreen applies to whichever
                      monitor the window is currently on, so setting it first
                      would fill the wrong screen and then refuse to move.
                    */
                    let _ = window.set_fullscreen(false);
                    let moved = window.set_position(position);
                    let full = window.set_fullscreen(true);
                    log(&format!(
                        "[operator] summon: screen {} of {} at {:?} — move {:?}, fullscreen {:?}",
                        pick + 1,
                        monitors.len(),
                        position,
                        moved.is_ok(),
                        full.is_ok()
                    ));
                }
                Ok(_) => eprintln!("[operator] summon: no monitors reported"),
                Err(e) => eprintln!("[operator] summon: could not read monitors: {e}"),
            }
        }

        /*
          Windows will not let a background process take the foreground, and
          `set_focus()` fails SILENTLY when it refuses.

          That is exactly what the log showed: "already fullscreen, just
          focusing" on every hotkey press while nothing came forward. The call
          returns Ok, the window stays behind, and there is nothing to debug.

          `actions.mjs` hit this first and works around it in its native helper
          by pressing and releasing ALT, which briefly makes the calling process
          eligible. There is no such trick in Tauri's API, but toggling
          always-on-top does the same job through a different door: raising a
          topmost window is not foreground theft, so it is allowed, and dropping
          the flag immediately afterwards leaves it an ordinary window that
          happens to now be in front.

          Order matters. Topmost must be set BEFORE focus and cleared AFTER, or
          the raise and the focus race and it lands behind again roughly half
          the time.
        */
        let _ = window.set_always_on_top(true);
        let _ = window.set_focus();
        let _ = window.set_always_on_top(false);
        /*
          Tell the page it was summoned.

          The shell deliberately does not touch the microphone itself: the mic
          lives in the web layer, where `useMicLevel` already owns device
          choice, the level meter and the Bluetooth reconnect. Duplicating that
          in Rust would give two things fighting over one device — the exact
          failure that cost an evening when two ffmpeg processes did it.

          So this is a nudge, not a command. The page decides what to do with it.
        */
        let _ = app.emit("operator://summoned", ());
    }
}

/// The tray's two microphone lines, so the page can rewrite them.
///
/// TWO, because there are two different microphones and conflating them is what
/// made this confusing. The detector is always-on and can only hear a clap —
/// one number per chunk, no model, no words. Dictation is the one that produces
/// text, and it only opens when he asks. Showing a single "microphone" state
/// would either overstate the first or hide the second.
struct TrayLabels {
    detector: Mutex<Option<MenuItem<tauri::Wry>>>,
    dictation: Mutex<Option<MenuItem<tauri::Wry>>>,
}

/**
 * Report whether the microphone is open.
 *
 * Called from the page, because the page is the only thing that knows: the
 * stream belongs to `useMicLevel`, which owns device choice and the Bluetooth
 * reconnect. The shell showing its own guess would be worse than showing
 * nothing, since the entire reason this line exists is that he should be able
 * to tell at a glance whether Operator is listening.
 */
#[tauri::command]
fn set_mic_state(
    dictation: bool,
    detector: bool,
    labels: State<TrayLabels>,
    app: tauri::AppHandle,
) {
    if let Ok(item) = labels.dictation.lock() {
        if let Some(item) = item.as_ref() {
            let _ = item.set_text(if dictation {
                "Dictation: ON — listening to you"
            } else {
                "Dictation: off"
            });
        }
    }
    if let Ok(item) = labels.detector.lock() {
        if let Some(item) = item.as_ref() {
            let _ = item.set_text(if detector {
                "Clap detector: ON"
            } else {
                "Clap detector: off"
            });
        }
    }

    /*
      The tooltip says the STRONGER of the two, because it is one line and the
      question it answers is "can this hear what I am saying".

      Dictation outranks the detector deliberately: the detector holds a
      microphone but cannot produce words, and reporting them as equivalent
      would make the serious state indistinguishable from the harmless one.
    */
    if let Some(tray) = app.tray_by_id("operator") {
        let _ = tray.set_tooltip(Some(match (dictation, detector) {
            (true, _) => "Operator — listening to you",
            (false, true) => "Operator — waiting for a clap",
            (false, false) => "Operator",
        }));
    }
}

/**
 * Bring the window to the front, asked for by the page.
 *
 * This is how a CLAP summons Operator. The clap is detected server-side and
 * reaches the page as a counter; the page decides whether to act on it and calls
 * this. Rust does not listen for claps — the detector already exists, works, and
 * having a second one here would be two things fighting over one microphone.
 *
 * The page only calls this when Operator is NOT focused, which is the owner's
 * own refinement: clapping while already looking at it should do nothing, and a
 * window that raises itself when it is already in front is just a flicker.
 */
#[tauri::command]
fn summon_window(app: tauri::AppHandle) {
    summon(&app);
}

/**
 * Leave fullscreen, if we are in it.
 *
 * @returns true if it actually did something, so the caller knows whether to
 *          treat the keypress as consumed. Escape means "back out of the
 *          current thing", and in fullscreen the current thing IS fullscreen —
 *          navigating away instead would leave him on another page still filling
 *          the screen with no obvious way out.
 */
#[tauri::command]
fn exit_fullscreen(app: tauri::AppHandle) -> bool {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_fullscreen().unwrap_or(false) {
            let _ = window.set_fullscreen(false);
            return true;
        }
    }
    false
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(TrayLabels {
            detector: Mutex::new(None),
            dictation: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![set_mic_state, summon_window, exit_fullscreen])
        .setup(|app| {
            let handle = app.handle().clone();

            /*
              Ctrl+Alt+**letter O**, and it stays that way.

              It was briefly changed to Ctrl+Shift+O on the theory that Ctrl+Alt
              is AltGr on a UK layout and unreliable as a global hook. That was a
              confident explanation for a problem that did not exist — it had
              been working, and was read as Ctrl+Alt+ZERO.

              Ctrl+Shift+O is also actively worse: it is Chrome's bookmark
              manager, and a GLOBAL hook would take it away from every browser on
              the machine. Ctrl+Alt+O collides with far less.

              Three keys either way. A single modifier would steal a keystroke
              from whatever he is working in, and a hotkey that does that is
              worse than no hotkey.
            */
            let shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyO);
            let hotkey_handle = handle.clone();
            /*
              Registration is REPORTED, not assumed.

              The previous attempt failed silently: nothing errored, nothing
              logged, and the only symptom was a key combination that did
              nothing — indistinguishable from the feature not existing. A
              hotkey already held by another application fails exactly this way.
            */
            match app.global_shortcut().on_shortcut(shortcut, move |_app, _sc, event| {
                // Press only. Without this it summons twice — once down, once
                // up — and the second lands after focus has settled.
                if event.state == ShortcutState::Pressed {
                    summon(&hotkey_handle);
                }
            }) {
                Ok(()) => log("[operator] hotkey registered: Ctrl+Alt+O (letter O)"),
                Err(e) => eprintln!("[operator] hotkey NOT registered — something else holds it: {e}"),
            }

            /*
              Ctrl+Alt+M — the microphone, from anywhere.

              The tray menu can toggle it, but a tray icon is a thing you have
              to go and find, and the whole point of arming the mic from outside
              the window is that you are working in something else at the time.
              This is the same event the menu emits, on a key.

              M for microphone. Next to the summon key and equally unlikely to
              be wanted by anything else.
            */
            let mic_shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyM);
            let mic_handle = handle.clone();
            match app.global_shortcut().on_shortcut(mic_shortcut, move |_app, _sc, event| {
                if event.state == ShortcutState::Pressed {
                    // Ask the page, which owns the stream. Same rule as the tray.
                    // Logged for the same reason: a key that registers and a key
                    // that fires are different claims, and only one of them is
                    // visible from the desk.
                    log("[operator] hotkey: Ctrl+Alt+M — asking the page");
                    let _ = mic_handle.emit("operator://toggle-mic", ());
                }
            }) {
                Ok(()) => log("[operator] hotkey registered: Ctrl+Alt+M (microphone)"),
                Err(e) => eprintln!("[operator] mic hotkey NOT registered: {e}"),
            }

            /*
              The tray, and the ADR's condition made visible.

              Background listening is off by default and its state must be
              legible without opening anything. The clap detector is the
              argument: it false-fired for weeks while nobody could see it, and
              a microphone that is on because nobody chose to turn it off is a
              decision by default.

              The label is set from the page, which is the only thing that knows
              whether a stream is actually open.
            */
            let show = MenuItem::with_id(app, "show", "Open Operator", true, None::<&str>)?;
            /*
              Enabled, because he asked to TOGGLE from here rather than only
              read it: *"i cant toggle microphone on or off and if i could that
              would make it all work"*. It is the control that makes the rest
              usable — with the mic on and the window out of focus, a clap or
              the hotkey can bring Operator back.

              It still does not touch the device. Clicking it asks the page,
              which owns the stream; the label only changes when the page
              reports back that something actually happened.
            */
            let detector = MenuItem::with_id(app, "detector", "Clap detector: off", true, None::<&str>)?;
            let mic = MenuItem::with_id(app, "mic", "Dictation: off", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let separator2 = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(app, &[&show, &separator, &detector, &mic, &separator2, &quit])?;

            // Hand both items to the command above so the page can rewrite them.
            // `State` borrows from the app, so bind it before locking rather
            // than chaining — the temporary would be dropped mid-expression.
            let labels: State<TrayLabels> = app.state();
            if let Ok(mut slot) = labels.detector.lock() {
                *slot = Some(detector.clone());
            }
            if let Ok(mut slot) = labels.dictation.lock() {
                *slot = Some(mic.clone());
            }

            TrayIconBuilder::with_id("operator")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Operator")
                .menu(&menu)
                /*
                  Left click opens the MENU, not the window.

                  It was the other way round — left to summon, right for the
                  menu, which is the Windows convention. It was also the wrong
                  call here: the owner clicked the icon repeatedly, nothing
                  happened, and he reported the tray as broken. He was right
                  that nothing happened, because summon was silently failing on
                  the foreground restriction at the time; but he never saw the
                  menu either, so the two toggles he had asked for were
                  invisible behind a gesture he had no reason to try.

                  A tray icon whose whole purpose is showing two microphone
                  states should show them on the obvious click. Summoning is
                  already on Ctrl+Alt+O and on the menu's first item, so
                  nothing is lost.
                */
                .show_menu_on_left_click(true)
                /*
                  Every click is logged, because "the tray doesn't work" has had
                  three distinct causes now and they are indistinguishable from
                  outside: the menu never opened, the click never arrived, or it
                  arrived and the page was not listening. Only the shell can
                  tell the first two apart, and `data/shell.log` is where the
                  answer has to be — release builds have no console.
                */
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "show" => {
                        log("[operator] tray: Open Operator");
                        summon(app)
                    }
                    "mic" => {
                        // Ask, do not act. The page owns the microphone.
                        log("[operator] tray: toggle dictation — asking the page");
                        let _ = app.emit("operator://toggle-mic", ());
                    }
                    "detector" => {
                        log("[operator] tray: toggle clap detector — asking the page");
                        // Also the page's to do: it goes through /api/, which is
                        // authenticated, rather than the shell reaching into the
                        // server behind the identity check.
                        let _ = app.emit("operator://toggle-detector", ());
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            /*
              Closing hides rather than quits.

              This is the point of a tray app — Operator is meant to be reachable
              by a hotkey without being on screen. Quitting on the X would make
              the hotkey work only while the window was already open, which is
              the opposite of the feature.

              Quit is on the tray menu, deliberately explicit.
            */
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("Operator's window could not start");
}
