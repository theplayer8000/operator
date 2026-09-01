# What actually starts Operator. Invoked by operator-serve.cmd, which is what
# Task Scheduler points at - that indirection keeps the task's target stable
# while the logic lives somewhere quoting works.
#
# ## ASCII ONLY IN THIS FILE
#
# Windows PowerShell 5.1 reads a .ps1 as ANSI unless it carries a UTF-8 BOM, so
# a single em-dash in a comment is enough to corrupt the following string
# literal and fail the whole script at PARSE time - before one line of it runs.
# Measured 2026-08-30: an em-dash inside a catch block produced "Unexpected
# token 'check'" and "The string is missing the terminator", pointing at three
# lines that were all fine. Operator simply did not start, and the log said
# nothing because logging happens after parsing.
#
# ## Why PowerShell rather than the .cmd doing it
#
# Config is read from HKCU\Environment rather than the inherited environment,
# because the Task Scheduler service caches the user's environment block when
# IT starts, so a `setx` afterwards never reaches a task it launches. Operator
# once came up with no GEMINI_API_KEY and silently offered only Claude, which
# looked like the provider code being broken.
#
# The .cmd used `for /f` over `reg query` for that. It works for a key and a
# number and falls apart on JSON: measured the same day, OPERATOR_APPS came
# back 501 of 541 characters and then crashed cmd outright on the embedded
# quotes. PowerShell reads the registry as a value rather than as text to be
# re-parsed, so quotes, spaces and backslashes survive.
#
# ## Nothing here is a secret in the file
#
# Values live in the registry; this script only names them. That is what keeps
# it committable - and OPERATOR_APPS in particular must stay outside the repo
# for a stronger reason than secrecy: a worker has Write across the tree, so an
# app registry on disk is one the agent could add its own entry to.

$repo = Split-Path -Parent $PSScriptRoot
$log = Join-Path $repo "data\serve.log"

function Read-UserEnv([string]$name) {
    try {
        (Get-ItemProperty -Path "HKCU:\Environment" -Name $name -ErrorAction Stop).$name
    } catch {
        $null
    }
}

# Secrets and config, straight from the registry.
$gemini = Read-UserEnv "GEMINI_API_KEY"
if ($gemini) { $env:GEMINI_API_KEY = $gemini }

# Operator's own spending brake. Read the note above BUDGET_USD in
# server/jobs.mjs before trusting it: the counter is in memory and resets on
# every restart, and it sums *valuation* dollars rather than money charged. It
# brakes a runaway within one run; it is not a lifetime budget, and ADR 0013
# supersedes it in principle.
$budget = Read-UserEnv "OPERATOR_USAGE_BUDGET_USD"
if ($budget) { $env:OPERATOR_USAGE_BUDGET_USD = $budget }

# The hosted-app registry (server/apps.mjs). JSON, which is the reason this
# file is PowerShell at all - see the header.
$apps = Read-UserEnv "OPERATOR_APPS"
if ($apps) { $env:OPERATOR_APPS = $apps }

# The microphone the clap listener watches (server/listen.mjs). Absent means it
# does not run at all - an always-open microphone is a decision, not a default,
# which is also why this lives in the registry rather than anywhere a worker
# could write to it.
$listen = Read-UserEnv "OPERATOR_LISTEN"
if ($listen) { $env:OPERATOR_LISTEN = $listen }

# Where phone notifications go (server/notify.mjs). The URL is loopback - the
# owner's own ntfy server, exposed to the tailnet by tailscale serve. Absent
# means notifications are simply off, which is why nothing here has a default.
# Environment rather than the store for the reason OPERATOR_APPS is: a worker
# has Write everywhere, and a destination it could edit would be a general
# outbound channel with Operator's own code doing the sending.
$ntfyUrl = Read-UserEnv "OPERATOR_NTFY_URL"
if ($ntfyUrl) { $env:OPERATOR_NTFY_URL = $ntfyUrl }
$ntfyTopic = Read-UserEnv "OPERATOR_NTFY_TOPIC"
if ($ntfyTopic) { $env:OPERATOR_NTFY_TOPIC = $ntfyTopic }
$ntfyToken = Read-UserEnv "OPERATOR_NTFY_TOKEN"
if ($ntfyToken) { $env:OPERATOR_NTFY_TOKEN = $ntfyToken }
$appUrl = Read-UserEnv "OPERATOR_APP_URL"
if ($appUrl) { $env:OPERATOR_APP_URL = $appUrl }

# Where espeak-ng lives, for Kokoro's phonemiser (server/tts.mjs).
# Read explicitly rather than trusting inheritance, for the same reason every
# other variable here is: Task Scheduler's environment has not been reliable,
# which is the whole reason this script exists.
$espeakLib = Read-UserEnv "PHONEMIZER_ESPEAK_LIBRARY"
if ($espeakLib) { $env:PHONEMIZER_ESPEAK_LIBRARY = $espeakLib }
$espeakExe = Read-UserEnv "PHONEMIZER_ESPEAK_PATH"
if ($espeakExe) { $env:PHONEMIZER_ESPEAK_PATH = $espeakExe }
$espeakData = Read-UserEnv "ESPEAK_DATA_PATH"
if ($espeakData) { $env:ESPEAK_DATA_PATH = $espeakData }

$stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
Add-Content -Path $log -Value "==== serve started $stamp ===="

if ($gemini) { $geminiState = "present" } else { $geminiState = "MISSING" }
Add-Content -Path $log -Value "==== GEMINI_API_KEY: $geminiState ===="

if ($budget) { $budgetState = "`$$budget" } else { $budgetState = "none" }
Add-Content -Path $log -Value "==== usage ceiling: $budgetState ===="

if ($ntfyUrl -and $ntfyTopic) { $ntfyState = $ntfyUrl } else { $ntfyState = "off" }
Add-Content -Path $log -Value "==== notifications: $ntfyState ===="

if ($espeakLib) { $espeakState = "present" } else { $espeakState = "MISSING" }
Add-Content -Path $log -Value "==== espeak-ng: $espeakState ===="

if ($apps) {
    try {
        $appNames = (($apps | ConvertFrom-Json).name) -join ", "
    } catch {
        $appNames = "UNPARSEABLE, check the registry value"
    }
} else {
    $appNames = "none"
}
Add-Content -Path $log -Value "==== hosted apps: $appNames ===="

if ($listen) { $listenState = $listen } else { $listenState = "off" }
Add-Content -Path $log -Value "==== clap listener: $listenState ===="

Set-Location $repo

# Redirect inside cmd, NOT with PowerShell's *>&1. In 5.1 redirecting a native
# command's stderr wraps every line in a NativeCommandError, which turns npm's
# ordinary progress chatter into terminating errors. cmd does the append and
# PowerShell never inspects the stream.
& cmd /c "npm run serve >> `"$log`" 2>&1"
