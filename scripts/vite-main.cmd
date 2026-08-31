@echo off
REM Vite on main - the :8443 dev build. Scheduler-launched, same reason as serve.
REM
REM This lives in the repo deliberately. It used to sit in a Claude session's
REM scratchpad under %LOCALAPPDATA%\Temp, which is scoped to one conversation
REM and gets cleaned up - at which point the scheduled task would break and
REM :8443 would simply stop working with no obvious cause.
REM
REM Logs go to data\ next to serve.log rather than beside this script, so the
REM repo stays clean and every log is in one place.
cd /d D:\Projects\operator
echo ==== vite main started %DATE% %TIME% ==== >> "D:\Projects\operator\data\vite-main.log"
npx vite --port 5173 --host >> "D:\Projects\operator\data\vite-main.log" 2>&1
