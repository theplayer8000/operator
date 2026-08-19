# CURRENT — work in progress

**Updated:** 2026-08-19
**`main`:** option C merged (`9d41470` via `agent`). **Needs a restart** — the
API is loaded into memory at boot, so the live app is still on the CLI runner
until then.
**`agent`:** merged into `main`, nothing outstanding but untracked probes.
**Rule:** see *"Every piece of work keeps a live handoff"* in `CLAUDE.md`.

## What changes for you next

**Permissions are answerable from the phone now.** A tool outside the pre-allow
list suspends the turn, puts a card in the chat with **Allow / No / Allow and
stop asking**, and carries on with the same turn when you tap. The Snapchat case
is one tap instead of six refusals.

**No environment change is needed.** `OPERATOR_JOB_PROFILE` now only switches
the CLI fallback; the SDK path always runs `default` + the pre-allow list. The
"close the window, open a new shell" dance an earlier note described does not
apply to this.

## It is measured, not assumed

`scripts/probe-optionc.mjs`, run 2026-08-19. One turn, $0.35:

```
18412ms  tool_use: Read — package.json          ← pre-allowed, no callback
18435ms  tool_result (ok=true)
20803ms  tool_use: Write — probe-scratch.txt    ← not pre-allowed
20812ms  >>> canUseTool FIRED
20812ms  >>> holding the answer for 6s...
26812ms  >>> answering DENY
26816ms  tool_result (ok=false)                 ← 4ms after the answer
28915ms  text: "The write was refused … PROBE-DONE"
```

Four things at once: `allowedTools` suppresses the callback for listed tools;
an unlisted tool **genuinely suspends the turn**; the deny held (no file); and
the turn **carried on to finish** after the refusal instead of ending — which is
the whole difference from the CLI.

A PASS is trustworthy from anywhere; contamination can only suppress the
callback, never invent one. So this stands despite being run from a session.

## Two findings that constrain the design — don't re-litigate them

**1. A bare tool name in `allowedTools` auto-approves that tool everywhere.**
The SDK warns about it on stderr (`CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`). So
`Write` in the list means every write on the disk, not every write in the repo.

**2. The obvious fix does not work.** `Write(**)` was tried
(`scripts/probe-scope.mjs`, $0.35): it matched nothing, and an in-repo write and
a temp-dir write **both** asked. A workspace that asks permission for every file
edit is one nobody will use.

So `Write`/`Edit` are bare deliberately — it is your standing decision
("everything except `git push` and deleting"), it is not a regression from
`bypassPermissions`, and what contains the blast radius is the worktree, not
this list. The reasoning is written out above `ALLOWED_TOOLS` in `jobs.mjs`.
**Measure before narrowing it**; both probes are kept.

Same warning names a third shadow: allow rules in `.claude/settings.local.json`
also bypass the callback, and the SDK can't see them to warn.

## What changed

| File | What |
|---|---|
| `server/runner.mjs` | three-arg `canUseTool` (the third carries `signal`), `allowedTools`, `allowDangerouslySkipPermissions`, session id announced on `init` rather than only returned |
| `server/jobs.mjs` | `ALLOWED_TOOLS`; the questions registry (`ask`, `answerPermission`, `dropQuestions`); `runViaSdk`; `halt()`; the system prompt no longer tells Claude it can't be asked |
| `server/index.mjs` | `POST /api/jobs/:id/permission` |
| `src/hooks/useJobs.ts` | `answerPermission`, the `permission_answer` event, `asking` |
| `src/components/dev/ClaudeChat.tsx` | the live question card, the tab dot, "holding — waiting on your answer" |

Two bugs fixed on the way, both of the same family as the ones already
documented in `jobs.mjs` — a rule that looks right and can never fire:

- **`SETTINGS_FILE` pointed at `ROOT`, not `JOB_CWD`.** Since jobs run in the
  worktree, every grant from the old button was written to the main checkout for
  a Claude that reads the worktree. Inert. `toRulePath` had the same fault.
- **`appendSystemPrompt` is the CLI's flag name, not the SDK's.** Passing it
  would have been silently ignored — the instruction would simply never reach
  the model. It needs `systemPrompt: {type:'preset', preset:'claude_code', append}`.

## Verified / not verified

- `npx tsc -b` and `npx vite build` both clean.
- All three `.mjs` files pass `node --check` with the real binary (v24.12.0).
- **The whole server path is proven**, not just the runner. The worktree's own
  server was started on `:5176` against a throwaway store and driven over HTTP:

```
19891ms  tool_use: Bash — node -e "console.log(6*7)"     ← not pre-allowed
19891ms  QUESTION id=perm-1 pending=true
19891ms  summary says asking=1, status=running           ← the tab dot's data
19891ms  >>> holding 5s before answering...
24900ms  >>> answered: {"answered":true,...}
25602ms  ANSWER   id=perm-1 decision=allowed by=this machine
27708ms  tool_result                                     ← the turn carried on
```

  Cancel was tested the same way, against an outstanding question: `perm-2`
  settled as `cancelled` and `asking` went to 0 within 12ms, and the runner
  claim released. That is the third `canUseTool` argument doing its job.

- **Reviewed at the desk before merging.** `/api/jobs/:id/permission` sits
  behind `deviceAuthorised()`, the same device-list gate as the terminal — the
  "not behind `assertMine`" note is about job *ownership*, not authentication.
- **The card is proven on the phone** (2026-08-19, after the restart). A `curl`
  outside the pre-allow list emitted `permission_request id=perm-1`, the turn
  held, and Allow / No / "Allow, and stop asking about this one" rendered on the
  iPhone. Nothing about option C is unverified now.

  Worth knowing for the next report of "it didn't work": the first attempt
  looked like a failure because the phone still had the pre-merge bundle, which
  has no concept of a live question and falls back to the old *"it couldn't ask,
  so it stopped"* card. The server was correct throughout. **Check the bundle
  before believing the UI** — the event log is the authority, and a
  `permission_request` carrying an `id` is the new path.

## Landmines

- **`git add -A` is banned here** (`CLAUDE.md`). Two writers share this tree.
- **`node` is version-shadowed, not broken.** Both binaries catch syntax errors.
- **`tsc` and `vite build` never read `.mjs`.** A clean build says nothing about
  a server change.
- **The deny list is not a boundary.** `git -C <path> push` ran with zero
  denials; a file was deleted via `node -e`. It is a speed bump against
  accidents. What makes that acceptable is the worktree.
- **`overflow-x: hidden` silently kills `position: sticky`.** It makes the
  element a scroll container, so every sticky descendant anchors to a box that
  is not the one being scrolled. It was on `html, body` in `index.css` — for a
  good reason, stopping sideways drift on a phone — and cost the sidebar and
  topbar on every long page for months. `overflow-x: clip` does the same job
  without creating a scroll container. Fixed 2026-08-19; if either bar ever
  scrolls away again, look for a new `overflow` on an ancestor first.
- **A modal inside an animated card is not fixed to the viewport.**
  `animate-fade-up` sets a transform, which makes that card the containing block
  for `position: fixed` descendants. `FilePeek` portals to `<body>` for this
  reason; anything else that pops over the page must do the same.

## The frontend work that landed the same day

`8f873e4`, `b1ac55a`, `012f18e`, `be3814d`, `4be4332` — all pushed:

- **This file is rendered in the app.** Updates shows it read-only above the
  queue (`src/components/updates/HandoffCard.tsx`, via `/api/dev/file`). Not
  copied into the store: one file, one truth. **Writing this badly is visible on
  his phone** — lead with what changes what he does next.
- **File paths in it are tappable**, opening `FilePeek` over the page, with
  *Open in Dev* behind it (`/dev?file=<path>`).
- **Updates pages by entry**, eight at a time; long details clamp to three lines
  with a *Show more*.
- **Every change gets logged** — `node scripts/log-update.mjs "title" "detail"`,
  now a rule in `CLAUDE.md`. The changelog is dated history and is never
  rewritten; this file is the moving picture and is overwritten as it moves.
- **The Darams CRM tile** now points at `https://tosin-pc.tail07eb22.ts.net:7443`
  — Tailscale serves that app there, not on `:5000`, so the old link was refused
  from the phone.

## All three servers run from Task Scheduler

`OperatorServe` (5174), `OperatorViteMain` (5173), `OperatorViteAgent` (5175),
wrappers in the session scratchpad. **Deliberately not launched from a Claude
Code session** — the probe proved that lineage leaks into everything spawned
beneath it, and jobs from the Claude page would inherit it. Stop one with
`schtasks /end /tn <name>`. Each shows a console window; closing it stops that
server.

## The probes are kept

Untracked in the worktree: `probe-permission.mjs`, `probe-optionc.mjs`,
`probe-scope.mjs`, `probe-task.cmd`, plus the scheduled task `OperatorSdkProbe`.
That set is the only known way to measure the SDK on this machine without a
Claude Code session contaminating the result. Re-run after any Claude Code or
SDK upgrade — the same standing instruction `jobs.mjs` carries for the deny-list
checks.

## Still open

- **Concurrency** and the **usage ceiling** — undecided, both in `CLAUDE.md`.
  One job at 6 turns cost **$12.47**, so the ceiling is no longer theoretical.
- **Uploads** — an original ask, design-doc step 2's surviving half.
- `server/workspace.mjs` is dead; delete it once step 1 has a week of use.
- The CLI fallback (`OPERATOR_JOB_RUNNER=cli`) and the whole spawn path should
  come out once the SDK has a few weeks of real use. Two runners is a tax.
- **"Stop asking about this one" matches the exact command, and only that.**
  `node -e "…"` was refused by the shadowed-`node` trap, Claude retried with the
  real binary, and that was a *second* question because the rule string
  differed. So the button suppresses a repeat, not a family. Widening it to a
  prefix is a real option, but it is the same over-matching hazard
  `matchesStanding` documents — decide it deliberately.
- `remembered` grants are in memory and forgotten on restart. Deliberate, but
  worth revisiting if you find yourself re-tapping.
- **Remote Control** (`claude --remote-control [name]`) — a startup flag, not
  something a running session switches on. Unaudited. This machine holds the
  store, the token and an armable terminal.
