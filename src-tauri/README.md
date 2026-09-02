# The desktop shell

A native window around the app Operator already serves. **Not a second
frontend** — see [ADR 0015](../docs/decisions/0015-tauri-desktop-shell.md) for
why it exists and what it is forbidden from becoming.

## It loads from the running server, not from bundled assets

This is the load-bearing decision, and it is a condition of the ADR rather than
a convenience.

Operator already has three builds that can disagree — the live app, Vite on
`main`, Vite on the `agent` worktree — and `CLAUDE.md` has a table explaining
which command fixes which. A packaged desktop app that ships its own copy of
`dist/` would be a fourth, and the worst kind: it holds a **snapshot**. The
failure is someone debugging a bug they already fixed, in a binary that predates
the fix.

So `frontendDist` points at the running server. `npm run build` keeps meaning
exactly what that table says it means, and the shell is a window onto the same
bytes the browser gets.

Bundling is for the day it needs to work with the server down. That day is not
now: every screen reads the store over `/api/`, so a shell with no server is a
window onto an error message.

## What it may contain

Only what the browser refused to do — microphone without a gesture, a global
hotkey, output device selection, tray presence, background listening.

**Never a capability.** Anything Operator itself should be able to *do* belongs
in `server/actions.mjs`, where Gemini and the local model can reach it too. A
feature that lives here is a feature only the desktop has, which is the
boundary ADR 0014 draws for plugins and the same argument applies.

## Microphone and the tray

Background listening is **off by default** and its state is visible. The clap
detector is the argument: it false-fired for weeks while nobody could see it,
and a microphone that is on because nobody chose to turn it off is a decision by
default.

The owner's framing on accepting the ADR: self-hosting decides who *holds* a
recording, not whether it should have been made.

## Building it

Requires the Rust toolchain and — on Windows — the MSVC linker from Visual
Studio Build Tools with the C++ workload. WebView2 is already present on this
machine; Tauri uses it rather than shipping a browser, which is the difference
between a few megabytes and Electron's ~150.

```bash
npm run tauri:dev     # the shell, against the running server
npm run tauri:build   # a distributable
```

Start the storage server first (`npm run serve`) — the shell has nothing to
show without it, by design.

## Build the profile you are about to run

There are now **two** shell binaries — `target/debug/` and `target/release/` —
and `cargo build` produces only the first. This is the same class of problem as
the three builds in `CLAUDE.md`'s table, and it caught a session on 2026-09-02:
several fixes were built into debug, tested from release, and reported as "still
not working" because the running binary predated them by eleven hours.

`npm run tauri:dev` and `npm run tauri:build` each handle one profile
end-to-end. Reach for a bare `cargo build` only when you know which one is
running, and check the timestamp when a change appears to have done nothing:

```bash
ls -l target/release/operator-shell.exe
```

## Launch it through hidden.vbs, not from a shell

`scripts/operator-shell.cmd`, started by `scripts/hidden.vbs`, exactly as the
server and both Vite instances are.

The binary is built with `windows_subsystem = "windows"` so it creates no
console of its own — but it INHERITS one from whatever starts it. Launching the
exe from a terminal leaves a stray window titled "Operator (2)" full of log
lines sitting on the desktop, which is a launcher problem wearing the costume of
a build problem.
