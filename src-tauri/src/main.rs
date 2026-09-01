// A native window around the app the server already serves.
//
// Read src-tauri/README.md and ADR 0015 before adding anything here. The short
// version: this file is a container. Anything Operator should be able to DO
// belongs in server/actions.mjs, where Gemini and the local model can reach it
// too — a capability that lives in the desktop shell is one only the desktop
// has, which is the boundary ADR 0014 draws for plugins and it applies equally
// here.
//
// What legitimately belongs in this crate is only what a browser refused:
// microphone capture without a user gesture, a global hotkey, choosing the
// audio output device, tray presence, and background operation with no window
// open. None of that is built yet.

// No console window behind the app in a release build. Kept in debug, because
// that is where Rust panics are actually read.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        /*
          Nothing else registered yet, deliberately.

          The temptation with a shell is to wire up the interesting native
          things first — hotkey, tray, microphone — and discover afterwards
          that the window never loaded. Getting an empty container to show the
          real app is the milestone that proves `frontendDist` points somewhere
          real, and it is the one worth reaching before anything is built on
          top of it.
        */
        .run(tauri::generate_context!())
        .expect("Operator's window could not start");
}
