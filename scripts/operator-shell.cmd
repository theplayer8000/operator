@echo off
rem The desktop shell, launched with no console behind it.
rem
rem Started by scripts\hidden.vbs, the same way the server and both Vite
rem instances are. Launching the exe from a shell instead gives it that shell's
rem console — a stray window titled "Operator (2)" full of log lines, which is
rem what the owner saw and reasonably asked about.
rem
rem The binary itself is built with `windows_subsystem = "windows"` in release,
rem so it creates no console of its own. It inherits one when something with a
rem console starts it, which is a launcher problem rather than a build problem.
start "" "D:\Projects\operator\src-tauri\target\release\operator-shell.exe"
