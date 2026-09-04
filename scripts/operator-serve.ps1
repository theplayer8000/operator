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

# --- what the server actually runs with -----------------------------------
#
# Forwarded as GROUPS rather than one variable at a time, and that change is the
# fix for a bug this file has now produced four times.
#
# Naming each variable was deliberate: this was meant to be the one place that
# says what the server runs with. What it produced instead was a silent no-op
# every time something new arrived. `secret_set` writes OPERATOR_CEILING_JOB_USD
# from his phone and the server never saw it. AI Router was approved 2026-09-02
# and AIROUTER_API_KEY was not on the list. Web Push landed 2026-09-01 and its
# VAPID keys were not either. A setting that writes successfully and does
# nothing is worse than one that refuses, and "remember to add it here" has now
# been tried for months and does not work.
#
# So every OPERATOR_* in the registry is forwarded. That namespace IS Operator's
# configuration, so a new one is always wanted - including the ones that are
# security boundaries (OPERATOR_TERMINAL_DEVICES, OPERATOR_APPS,
# OPERATOR_MAX_CONCURRENT). Those are registry-only precisely so a worker with
# Write across the tree cannot reach them, and this is the only door they come
# through.
#
# CREDENTIALS STAY A NAMED LIST. Matching *_API_KEY by pattern would sweep
# unrelated keys off his account into a process that talks to third parties, and
# the whole point of CLAUDE.md's approvals table is that each host is named. Add
# a line here when a provider is approved - and only then.
#
# Always read from the registry, never trust $env:. Task Scheduler caches the
# environment it launched with, so anything set afterwards is invisible until
# something reads it fresh. That is the entire reason this file exists.

$credentials = @("GEMINI_API_KEY", "AIROUTER_API_KEY")
$extras = @("PHONEMIZER_ESPEAK_LIBRARY", "PHONEMIZER_ESPEAK_PATH", "ESPEAK_DATA_PATH")

$secretsPresent = @()
foreach ($name in $credentials) {
    $value = Read-UserEnv $name
    if ($value) {
        Set-Item -Path "Env:$name" -Value $value
        $secretsPresent += $name
    }
}

foreach ($name in $extras) {
    $value = Read-UserEnv $name
    if ($value) { Set-Item -Path "Env:$name" -Value $value }
}

$forwarded = @()
try {
    $envKey = Get-Item -Path "HKCU:\Environment" -ErrorAction Stop
    foreach ($name in $envKey.GetValueNames()) {
        if ($name -like "OPERATOR_*") {
            $value = $envKey.GetValue($name)
            if ($value) {
                Set-Item -Path "Env:$name" -Value $value
                $forwarded += $name
            }
        }
    }
} catch { }

# Read back for the banner below, so what is logged is what the process holds
# rather than what this script believes it set.
$gemini = $env:GEMINI_API_KEY
$budget = $env:OPERATOR_USAGE_BUDGET_USD
$ntfyUrl = $env:OPERATOR_NTFY_URL
$ntfyTopic = $env:OPERATOR_NTFY_TOPIC
$espeakLib = $env:PHONEMIZER_ESPEAK_LIBRARY
$concurrent = $env:OPERATOR_MAX_CONCURRENT
$focusScreen = $env:OPERATOR_FOCUS_SCREEN
# Both of these were missed when the forwarding became a group, and the banner
# then reported "hosted apps: none" and "clap listener: off" for two things
# that were set and forwarded correctly. The environment was right and the log
# was wrong, which is the harder half to notice - read every name the banner
# below uses, not just most of them.
$apps = $env:OPERATOR_APPS
$listen = $env:OPERATOR_LISTEN

# Roll the log if it has got large, keeping exactly one previous file.
#
# It appends forever otherwise. A disconnected microphone alone produced about
# two thousand identical lines in a day, and the interesting part - the startup
# banner, actions, jobs - ends up buried under whatever is currently broken.
#
# Rotated at START rather than while running: nothing holds a handle at this
# moment, so there is no risk of truncating a file the server is mid-write on.
# One previous file, because the reason to read this is almost always "what
# happened just now", and anything older is in git or the changelog.
$maxLogBytes = 2MB
if ((Test-Path $log) -and ((Get-Item $log).Length -gt $maxLogBytes)) {
    $previous = "$log.1"
    if (Test-Path $previous) { Remove-Item $previous -Force -ErrorAction SilentlyContinue }
    Move-Item -Path $log -Destination $previous -Force -ErrorAction SilentlyContinue
}

$stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
Add-Content -Path $log -Value "==== serve started $stamp ===="

if ($gemini) { $geminiState = "present" } else { $geminiState = "MISSING" }
Add-Content -Path $log -Value "==== GEMINI_API_KEY: $geminiState ===="

if ($budget) { $budgetState = "`$$budget" } else { $budgetState = "none" }
Add-Content -Path $log -Value "==== usage ceiling: $budgetState ===="

# NAMES ONLY, and that is a deliberate change from the previous version.
#
# It used to log OPERATOR_CEILING_* as name=value, on the correct reasoning that
# a ceiling is a policy rather than a secret. That reasoning does not survive
# forwarding the whole namespace: OPERATOR_VAPID_PRIVATE and OPERATOR_NTFY_TOKEN
# match OPERATOR_* too, and this log is read by the Dev page and by every worker
# that greps it. A key in here is a key published to the tailnet - the same
# mistake that cost the Gemini key a reissue, arriving by a different door.
#
# The names are what was actually missing anyway. "Is it reaching the server"
# was the question every one of those four silent no-ops asked.
if ($forwarded.Count -gt 0) {
    Add-Content -Path $log -Value ("==== OPERATOR_* forwarded (" + $forwarded.Count + "): " + (($forwarded | Sort-Object) -join ", ") + " ====")
} else {
    Add-Content -Path $log -Value "==== OPERATOR_* forwarded: none ===="
}
if ($secretsPresent.Count -gt 0) {
    Add-Content -Path $log -Value ("==== credentials present: " + (($secretsPresent | Sort-Object) -join ", ") + " ====")
} else {
    Add-Content -Path $log -Value "==== credentials present: none ===="
}

if ($ntfyUrl -and $ntfyTopic) { $ntfyState = $ntfyUrl } else { $ntfyState = "off" }
Add-Content -Path $log -Value "==== notifications: $ntfyState ===="

if ($espeakLib) { $espeakState = "present" } else { $espeakState = "MISSING" }
Add-Content -Path $log -Value "==== espeak-ng: $espeakState ===="

if ($concurrent) { $concState = $concurrent } else { $concState = "1 (default)" }
Add-Content -Path $log -Value "==== max concurrent turns: $concState ===="

if ($focusScreen) { $screenState = $focusScreen } else { $screenState = "2 (default)" }
Add-Content -Path $log -Value "==== summon to screen: $screenState ===="

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
