@echo off
rem Every four hours: what the voice layer heard and did not understand.
rem
rem Launched hidden by scripts\hidden.vbs from the OperatorIntentDigest task,
rem the same way the server and the two Vite instances are — a window that
rem appears on the desktop every four hours is a window that gets closed, and
rem then the digest silently stops running.
rem
rem A .cmd rather than the command inline in the task: hidden.vbs takes ONE
rem argument, and a command line with its own quotes in it cannot survive being
rem nested inside the task's quoted argument. Registering it that way looked
rem right and left the task hung in "running" forever.
rem
rem Node by full path. `node` on PATH is shadowed here by
rem D:\projects\node_modules\.bin\node, which points at a POSIX path that does
rem not exist on Windows and fails silently.
cd /d D:\Projects\operator
"C:\Program Files\nodejs\node.exe" scripts\intent-misses.mjs --notify >> data\intent-digest.log 2>&1
