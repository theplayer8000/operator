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

/// Bring the window back, wherever it went.
///
/// Unminimise, show and focus, in that order — a window that is merely shown
/// while still minimised stays in the taskbar, which looks exactly like the
/// hotkey not working.
fn summon(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
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

/// The tray's microphone line, so the page can rewrite it.
struct MicLabel(Mutex<Option<MenuItem<tauri::Wry>>>);

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
fn set_mic_state(active: bool, label: State<MicLabel>, app: tauri::AppHandle) {
    if let Ok(item) = label.0.lock() {
        if let Some(item) = item.as_ref() {
            let _ = item.set_text(if active {
                "Microphone: ON"
            } else {
                "Microphone: off"
            });
        }
    }
    // The tooltip carries it too, so hovering answers without opening the menu.
    if let Some(tray) = app.tray_by_id("operator") {
        let _ = tray.set_tooltip(Some(if active {
            "Operator — listening"
        } else {
            "Operator"
        }));
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(MicLabel(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![set_mic_state])
        .setup(|app| {
            let handle = app.handle().clone();

            /*
              Ctrl+Alt+O. Deliberately awkward.

              A single modifier would collide with something in whatever he is
              working in, and a hotkey that steals a keystroke from another app
              is worse than no hotkey. Three keys and a letter that is not used
              for anything common.
            */
            let shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyO);
            let hotkey_handle = handle.clone();
            app.global_shortcut().on_shortcut(shortcut, move |_app, _sc, event| {
                // Fire on press only. Without this it summons twice — once down,
                // once up — and the second one lands after focus has settled.
                if event.state == ShortcutState::Pressed {
                    summon(&hotkey_handle);
                }
            })?;

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
            let mic = MenuItem::with_id(app, "mic", "Microphone: off", false, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(app, &[&show, &mic, &separator, &quit])?;

            // Hand the item to the command above so the page can rewrite it.
            if let Ok(mut slot) = app.state::<MicLabel>().0.lock() {
                *slot = Some(mic.clone());
            }

            let tray_handle = handle.clone();
            TrayIconBuilder::with_id("operator")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Operator")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "show" => summon(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(move |_tray, event| {
                    // Left click opens it. The menu is on right click, which is
                    // what a tray icon does everywhere else.
                    if let tauri::tray::TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = event
                    {
                        summon(&tray_handle);
                    }
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
