@echo off
REM What Task Scheduler runs to start Operator.
REM
REM Launched by the scheduler so Operator is NOT a child of a Claude Code
REM session — that lineage leaks into every job the Orchestrator page spawns,
REM and a job that inherits a session is a job whose test results are invalid.
REM
REM This file is deliberately a one-liner. All the work is in the .ps1 beside
REM it, because config is read from HKCU (the Task Scheduler service caches the
REM user's environment when IT starts, so setx never reaches a task it
REM launches) and cmd cannot carry a JSON value out of `reg query` intact —
REM measured 2026-08-30: OPERATOR_APPS came back 501 of 541 characters and then
REM crashed cmd on the embedded quotes.
REM
REM The indirection keeps the scheduled task's target stable. Repointing it
REM prompts for the run-as password, so it is worth not having to do again.

powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0operator-serve.ps1"
