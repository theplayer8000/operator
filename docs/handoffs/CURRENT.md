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

- **Items 2–5 of the dev-tooling request** are undecided. Item 3 — one honest
  answer to *"is this app actually up?"* — is the strongest of them: it is pure
  Node, needs no dependency, and fixes a failure that has already happened twice
  in both directions (a green tile over a dead app, and a *Running* task with
  nothing listening).
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
