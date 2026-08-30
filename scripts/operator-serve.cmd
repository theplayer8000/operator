@echo off
REM What Task Scheduler runs to start Operator.
REM
REM Launched by the scheduler so Operator is NOT a child of a Claude Code
REM session — that lineage leaks into every job the Orchestrator page spawns,
REM and a job that inherits a session is a job whose test results are invalid.
REM
REM ## Why this file is in the repo
REM
REM It used to live in a Claude session's scratchpad directory, which is
REM temporary: whenever that directory is cleaned the scheduled task points at
REM a file that no longer exists, and Operator stops starting with no
REM explanation at all. It holds no secrets — they are read from the registry
REM below — so there is nothing keeping it out of version control.
REM
REM ## Secrets come from the registry, not from the environment
REM
REM The Task Scheduler service caches the user's environment block when IT
REM starts, so a variable set with `setx` afterwards never reaches a task it
REM launches. The server came up with no GEMINI_API_KEY and silently offered
REM only Claude, which looked like the provider code being broken. Reading HKCU
REM here gets the current value at launch and keeps the key out of this file.

setlocal

for /f "tokens=2,*" %%A in ('reg query "HKCU\Environment" /v GEMINI_API_KEY 2^>nul') do set "GEMINI_API_KEY=%%B"

REM Operator's own spending brake, read the same way for the same reason.
REM Set it with:  setx OPERATOR_USAGE_BUDGET_USD 10
REM
REM Read the note above BUDGET_USD in server/jobs.mjs before trusting it: the
REM counter is in memory and resets on every restart, and it sums *valuation*
REM dollars rather than money actually charged. It is a brake on runaway work
REM within one run, not a lifetime budget. ADR 0013 supersedes it in principle
REM and has not been built.
for /f "tokens=2,*" %%A in ('reg query "HKCU\Environment" /v OPERATOR_USAGE_BUDGET_USD 2^>nul') do set "OPERATOR_USAGE_BUDGET_USD=%%B"

cd /d "%~dp0.."

set "LOG=%~dp0..\data\serve.log"
echo ==== serve started %DATE% %TIME% ==== >> "%LOG%"
if defined GEMINI_API_KEY (echo ==== GEMINI_API_KEY: present ==== >> "%LOG%") else (echo ==== GEMINI_API_KEY: MISSING ==== >> "%LOG%")
if defined OPERATOR_USAGE_BUDGET_USD (echo ==== usage ceiling: $%OPERATOR_USAGE_BUDGET_USD% ==== >> "%LOG%") else (echo ==== usage ceiling: none ==== >> "%LOG%")

npm run serve >> "%LOG%" 2>&1
