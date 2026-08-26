# CURRENT — work in progress

**Updated:** 2026-08-26
**`main`:** `901e586` plus uncommitted work below. **Not committed — awaiting approval.**
**Workers:** asleep. Terminal disarmed.
**Rule:** see *"Every piece of work keeps a live handoff"* in `CLAUDE.md`.

## In flight — the agent can look at what it builds

**Item 1 of [`2026-08-26-dev-tooling-request.md`](2026-08-26-dev-tooling-request.md)**,
the one that file says to build if only one gets built. Written and working,
not yet committed.

- `server/render.mjs` — **new.** HTML or SVG → PNG, via headless Edge. Pure
  Node, no npm package, no Python. The no-dependency rule of ADR 0012 holds.
- `scripts/render.mjs` — **new.** The CLI a worker calls. Standalone like
  `backup.mjs`: it imports the module rather than going through the API,
  because nothing here touches Operator's data.
- `server/jobs.mjs` — `Bash(node scripts/render.mjs:*)` added to
  `ALLOWED_TOOLS`, and `APPEND_PROMPT` now tells the model to look at its own
  visual output.

Verified end to end: a page was rendered at 420×780 and read back as an image,
and `http://localhost:5174/` was rendered at iPhone width. Refusals were
exercised too — an external host, a `.md`, a `.pdf`.

### The finding that shrank the job

**PDFs and images never needed building.** The Agent SDK's `Read` takes a
`pages` range for PDFs and shows images visually, and `Read` is bare-pre-allowed
for every job — checked against `sdk-tools.d.ts` in
`@anthropic-ai/claude-agent-sdk` 0.3.220. The three round trips of *"does this
look right?"* that the request describes were spent on a capability the session
already had and did not know about.

So `pypdfium2` is not needed, and neither is a Python runtime. The real gap was
HTML and SVG, which have no picture until something lays them out. **The other
half of the fix is `APPEND_PROMPT`** — a capability nobody mentions does not get
used, which is the actual lesson.

### Two traps, both measured, both in the file's header

Headless Edge reports success it has not earned, twice over. It exits 0 having
written nothing when it hands the page to an already-running instance — the
isolated `--user-data-dir` prevents that. And the process Node spawns is a
launcher that exits *before* the image is written, so checking on exit reported
a render that had worked as a failure. Only a stable file on disk is evidence.

## Also in flight — restart a hosted app, and wait for it

**Item 2**, built after the owner chose how it should be gated (2026-08-26):
named apps in the environment, rather than behind the terminal's armed gate.

- `server/apps.mjs` — **new.** `OPERATOR_APPS` maps a name to its stop, start,
  health URL and log. A caller says *which app*; there is no input that becomes
  *what command*. Environment-only on purpose — a worker has `Write` across the
  tree, so a registry on disk is one the agent could extend, exactly the reason
  `OPERATOR_TERMINAL_DEVICES` is env-only.
- `scripts/app.mjs` — **new.** `list`, `status`, `restart`.
- `server/jobs.mjs` — `list` and `status` pre-allowed; **`restart` deliberately
  is not.** Taking down something someone may be using is worth one tap on the
  phone, which ADR 0012 made cheap. Widen to `Bash(node scripts/app.mjs:*)` if
  it becomes friction.

It confirms the app *actually stopped* before starting it, which is the lesson
from Operator's own restart: `schtasks /end` returns success while the process
keeps holding the port, so the relaunch fails to bind and the old build carries
on serving. Tested against a service that would not stop — it refused to start
on top of it and exited non-zero, rather than reporting a restart it had not
performed.

## A restart is pending — `server/` changed

`jobs.mjs` is loaded at boot, so the new pre-allow entry and prompt do not exist
for a running server. The previous restart is done and this is a new one.

```powershell
schtasks /end /tn OperatorServe
Get-NetTCPConnection -LocalPort 5174 -State Listen |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
schtasks /run /tn OperatorServe
```

Ending the task alone leaves the old process holding the port; the relaunch then
fails to bind while everything looks restarted. The terminal comes back
**disarmed**, by design (ADR 0011).

## The limit of the tool, learned immediately

The first thing rendered at 390px looked like a responsive bug — the dashboard's
Homelab rows cut off mid-word, clean again by 600px. **It was not a bug.** The
owner checked his actual phone and it is fine.

This is headless *desktop* Chromium, which ignores `<meta name="viewport">`;
mobile Safari honours it. `--width 390` therefore renders a 390px-wide desktop
browser, which is not an iPhone, and the two disagree here. Real device
emulation needs the DevTools Protocol, which no CLI flag reaches.

**So: check the device before believing a responsive bug seen only in a render.**
Recorded as trap 4 in `render.mjs` and in the CLI's own usage text, because a
screenshot is persuasive in a way a wrong conclusion should not get to borrow.

## Waiting on the owner

- **`OPERATOR_APPS` is not set yet**, so `scripts/app.mjs` has nothing to act
  on. Set it at the desk — **never through Operator's terminal**, which logs
  every command, and never in a file, which a worker could edit. Format is in
  the header of `server/apps.mjs`. Darams CRM is the obvious first entry.
- **Items 4 and 5 of the dev-tooling request** are CRM-side scaffolding
  (migration generator, test runner) that Operator has no particular claim on.

## Saved for tomorrow, not started

[`docs/devices-and-harness-notes.md`](../devices-and-harness-notes.md) — written
late on 2026-08-26 at the owner's request, because he was too tired to process
it and did not want it re-derived. Two threads, deliberately separated:

- **Operator is already an agentic harness.** The gaps are specific and ranked —
  verification, planning, repair loops, context strategy, evals. **Verification
  first**, because fanning out workers before their output can be checked
  multiplies unverified work.
- **"Connect any device to Operator and have it work seamlessly."** His stated
  direction. A camera is the first instance, wanted both on the box and in the
  browser. A camera is a new *input*, not a better loop — it does nothing for
  the five gaps, and the two should not be confused.

Three matching entries are in the Updates queue so they surface on his phone.
The open questions are at the foot of that document; the first is whether a
camera frame is ever allowed to leave the machine, which decides whether the
camera work waits on the Ollama box.
- **Stray files in the agent worktree**, which deletes are denied on:

  ```
  cmd /c rmdir /s /q "D:\Projects\Operator-agent\.tmp-uploads"
  cmd /c rmdir /s /q "D:\Projects\Operator-agent\.tmp-outside"
  ```

  Its `docs/handoffs/CURRENT.md` also holds a stale pre-merge copy, and the
  branch sits behind `main`. `git -C D:\Projects\Operator-agent checkout -- docs/handoffs/CURRENT.md`
  then a fast-forward would tidy it — left alone because discarding another
  session's uncommitted file is the owner's call.
- **Concurrency and usage ceilings** remain undecided. ADR 0013 settled the
  accounting, not the limits.
