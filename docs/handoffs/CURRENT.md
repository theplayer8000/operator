# CURRENT — work in progress

**Updated:** 2026-08-20
**`main`:** `0616046` — audited, fixed, committed, pushed, and **restarted
live**. `stale: false` confirmed. The orchestrator layer described below is
what's actually running now, not a proposal.
**Rule:** see *"Every piece of work keeps a live handoff"* in `CLAUDE.md`.

## What shipped, in order

1. **Uploads and the provider boundary**, written by Codex, ran out of usage
   credits mid-task, nobody had reviewed it. Audited (not trusted), one real
   bug found and fixed, committed as `0616046`, pushed, restarted. See *The
   audit* below for the detail — kept because the reasoning still matters, not
   because any of it is still pending.
2. **Retry finished.** The server route existed with nothing calling it;
   `useJobs.retry()` and a button now close that gap.
3. **Post-restart verification**, live against the real server: job history
   survived (`job-6` restored with `provider`/`task`/`handoff`/`attempts`
   correctly populated), the provider list is live, `POST
   /api/jobs/resources` returns `201` once the terminal is armed. One false
   alarm along the way — an empty response on a single poll, not a real bug;
   the full raw dump right after showed everything correct.
4. **The page renamed:** "Claude" → **Orchestrator**, `/chat` → `/orchestrator`
   (old URL redirects, same pattern as the `/events` → `/calendar` rename).
   Not a relabel — the milestone is that `jobs.mjs` now dispatches through
   `providers.mjs` instead of calling the Claude runner directly, so a job is
   a task routed to a worker, not inherently "a Claude conversation." Only one
   worker is enabled today. `src/components/dev/ClaudeChat.tsx` **keeps its
   name** on purpose — it's still specifically the Claude Code worker's chat
   surface, and renaming it would claim a generality it doesn't have until a
   second worker exists.
5. **A minimal, honest UI for `attempts`.** A "N attempts" toggle appears
   above the Retry button, but only once there are two or more — one attempt
   is just how the job ran, not a history worth reading. `task`/`handoff`
   deliberately got **no** UI: their content is identical on every job today
   (`verification.status` always `"not-run"`, same canned note), so there is
   nothing true to show yet. Typed as `unknown` on the frontend rather than
   modelled in full, with the reasoning in the type's own comment — revisit
   once a verifier or a second worker gives them real content.

## The capability layer — built 2026-08-20, uncommitted

**An AI worker can now change Operator's data without editing code.**
`server/actions.mjs` exposes 19 named, validated actions across Gym, Mission
Board, Calendar and Daily Routine; a worker calls them with
`node scripts/operator-action.mjs <action> '<json>'` (`list` prints the
catalogue), or over `GET`/`POST /api/actions`.

This is the thing that makes a second provider cheap: Gemini and Codex will
call the same CLI, so the capability layer knows *how* and no worker needs
bespoke integration code. That was the whole argument for building it before
adding another provider.

**`server/store.mjs` is new and matters more than it looks.** `index.mjs` had
the store's cache, migrations and load/persist inline, so a second writer
would have been a second in-memory copy that could disagree with the first.
It's now one module, and `withState()` is a race-safe read-modify-write —
proven by test, two concurrent ticks both land rather than clobbering.
**Read its comment before adding another writer.**

Deliberately excluded: Homelab (service tiles describe infrastructure, not
tasks) and Updates (already has `log-update.mjs`; a second mechanism for the
same thing is worse than none). Calendar recurrence is read-only — creating a
rule interacts with skip state and expansion in ways worth a deliberate pass,
not a guess in the first cut of something a worker calls unsupervised.

**Verified, 27/27** in an isolated test against a throwaway store: every
action, every validation path, the `dependsOn` sweep on mission delete, the
empty-day-key drop on both gym and routine, and the concurrency case. Then
over real HTTP on an isolated server (`:5188`): catalogue lists, a real call
succeeds, a bad one returns `400` with the reason a model can correct itself
from, and `GET`/`PUT /api/state` still behave exactly as before the
extraction. `node --check` on all four server files; `tsc -b` and
`vite build` clean.

Four test failures on the first run were **the test's bug, not the code's** —
it imported `actions.mjs` twice (once cache-busted), so `err instanceof
ActionError` compared across two module instances with two separate classes.
Worth knowing if a future test does the same thing.

**Not restarted.** `server/` changed, so the live API is still on the previous
code until someone restarts it.

## The audit — kept for the reasoning, already acted on

## Uploads — complete, reviewed, safe to commit on its own

`server/uploads.mjs` (staging, 10 MB cap, safe filenames, path-escape checks,
cleanup), wired into `jobs.mjs` (`claimResources`/`removeJobResources`,
`promptWithResources`), `useJobs.upload()`, and a paperclip button + removable
attachment chips in `ClaudeChat.tsx`.

Independently verified, not just re-read: all four files pass `node --check`
on the real binary; the modules load cleanly; `npx tsc -b` is clean; and
`POST /api/jobs/resources` was hit directly against the live server and
returned `201`. No reference to the old `jobs.mjs` `MODELS` export survives
outside this file (checked — the only other hits are in dead `workspace.mjs`).
`data/job-resources/` is covered by the existing blanket `data/` gitignore
entry, so nothing binary risks being committed.

**This is genuinely done** — the surviving half of design-doc step 2 and an
original ask, going back to the very first handoffs on this feature.

## Orchestrator scaffolding — present, inert, one real bug found

`server/providers.mjs` (new) plus additions to `jobs.mjs`: `task`, `attempts`,
`handoff`, `verification`, a `retry` route. This is genuine new architecture,
not part of uploads — the two are interleaved in the same functions
(`create`, `input`, `indexOf`, `restore`, `blankJob`, `summary`) because Codex
built them together, not because they need to be.

**Confirmed dormant.** Nothing in `useJobs.ts` or `ClaudeChat.tsx` reads
`task`, `handoff`, or `attempts` — only `provider: string` exists on the
frontend type and nothing consumes it. So leaving this in the tree changes
nothing about how the app behaves today; it is inactive data modelling, not a
live code path.

**`providers.mjs` respects the provider-approval rule correctly** — one worker
registered (Claude), and its own header comment states outright that adding a
speculative Codex/OpenAI adapter now would be an unapproved integration. That
part was built the right way round.

**The bug — fixed.** Found by tracing every `setStatus()` call site against
`beginAttempt()`: in `runTurn()`, the budget-ceiling early return
(`budgetBlock()`) called `setStatus(job, "blocked", …)` *before* `beginAttempt`
had run for that turn — every other early return in the function called it
after. Ordinarily harmless, because the guard in `setStatus` only closes out
an attempt whose status is currently `"running"`, and a fresh or already-
finished attempt never matches that. But `restore()` rebuilds a job's
`attempts` array verbatim from disk, including whatever status an attempt was
in at the moment of a crash — so a job that crashed mid-turn, was restored,
and later hit the budget ceiling on its *next* genuine turn would have had its
stale, already-abandoned `"running"` attempt incorrectly closed out as
`"blocked"`, with a `handoff` event describing the wrong attempt.

`beginAttempt(job, prompt)` now runs unconditionally at the top of `runTurn`,
before `budgetBlock()` is even checked — every turn, blocked or not, closes
out its own attempt and gets its own handoff record, which also fixes the
smaller inconsistency where a blocked turn got no handoff at all. Re-verified
after the change: `node --check`, module load, `tsc -b`, full `vite build`,
all clean.

## Retry is now reachable — it wasn't

`server/jobs.mjs` grew `retry()` and `POST /api/jobs/:id/retry` with the
attempts model, and nothing called it: no method on `useJobs`, no button in
`ClaudeChat.tsx`. A server action nobody can trigger is the same class of gap
as the ordering bug — half a feature, not a whole one — so it's finished
rather than left dormant next to the rest of the scaffolding.

`useJobs.retry(id)` posts to the route and re-reads events/list. A **"Retry
this turn"** button appears next to the job's error line whenever
`status` is `failed`, `blocked`, or `cancelled` — the exact set the server
itself will act on, kept as one `RETRYABLE` constant on the frontend with a
comment pointing at the server check so the two can't quietly drift apart.
The one real limit — an attempt that can't be replayed because its prompt
didn't survive a restart — isn't pre-guessed by the button; the server's own
refusal surfaces through the existing `j.error` line, which teaches the limit
once rather than the UI getting it wrong twice.

`task`/`handoff`/`attempts` themselves are still not rendered anywhere. That
remains a real decision, not an oversight — see *Next*.

## What the owner actually said, so this isn't re-litigated

He wants the orchestrator hierarchy built — confirmed directly, not inferred
from Codex's own "the owner approved" line in its handoff, which was
unverifiable when written and is superseded now. What he asked for is
**sequencing**: uploads isolated and safe first, this audit before anything
new is added to the orchestrator, nothing committed/pushed/restarted until
the boundary between the two is mapped — which is what this section is.

## Next

1. `task`/`handoff` still have no UI, deliberately — see item 5 at the top.
   Revisit once a verifier exists or a second worker is approved, not before.
2. A second worker, when one is actually approved by name (not before —
   `providers.mjs`'s own header comment says as much). `selectWorker` and
   `runWorkerTurn` are the two functions a second worker plugs into.
3. The narrower items from before this audit are still open and unaffected:
   concurrency, the usage ceiling, deleting `server/workspace.mjs`, the CLI
   fallback's eventual removal, and "stop asking" matching an exact command
   rather than a family.

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
  iPhone.

  Worth knowing for the next report of "it didn't work": the first attempt
  looked like a failure because the phone still had the pre-merge bundle, which
  has no concept of a live question and falls back to the old *"it couldn't ask,
  so it stopped"* card. The server was correct throughout. **Check the bundle
  before believing the UI** — the event log is the authority, and a
  `permission_request` carrying an `id` is the new path.

- **Then tested from inside a real job**, the running session running gated
  commands against itself:

  | Command | Outcome |
  |---|---|
  | `git remote -v` | ran silently — read-only, auto-approved by the SDK's classifier before the callback |
  | `curl … \| node -e …` | `Refused from Operator.` — the deny path |
  | `npm --version` | allowed from the phone; **the same turn resumed** and returned `11.18.0` |

  So both answers work, and the line the pre-allow list draws lands in the right
  place: read-only sails through, outbound and machine-state commands ask.

### A long command made the card hard to answer

`subject` is the whole command, rendered in a `<pre>` above the buttons. A
`log-update.mjs` call carries a paragraph of prose, so the block grew until
**Allow was pushed down the card** — and a card you cannot reach is
indistinguishable, from the agent's side, from one you denied.

Inferred from contrast, not observed directly: `npm --version` and `npm root`
were answered immediately, while the same long command came back
`Refused from Operator.` twice in a row. Same bundle, same gate, minutes apart,
and the only variable was length. **It is possible those two were simply
declined on purpose** — the agent cannot tell a deny from an unreachable button,
which is itself the point.

Fixed in `ClaudeChat.tsx` either way: the block is capped at `max-h-24` and
scrolls, so the buttons stay reachable whatever is being asked about.

**Merged, built and confirmed on the phone** (`ca05a4c`, 2026-08-19). Both this
and the contradiction below were re-tested end to end: a gated command raised the
card, Allow was tapped, the turn resumed, and no false refusal rendered
underneath.

To reach the live app after a `src/` change: merge, then

```bash
npm --prefix D:\Projects\Operator run build
```

No restart — it is `src/` only. **Not `npm run build` from the worktree**: that
builds a `dist/` nothing serves, and it fails silently. CLAUDE.md now says so
under "Editing Operator while it runs". Note the backslashes are correct for
PowerShell and Operator's own terminal, but Git Bash eats them — use
`"D:/Projects/Operator"` there.

### The answered card contradicted itself — fixed

Once a live question was answered, `answers[event.id]` was set, the live branch
stopped rendering, and the event **fell through to the CLI card**. So a
permission that had just been allowed rendered in red as *"Needed permission —
it couldn't ask, so it stopped"*, with a grant button, directly above
*"you allowed it · from tosin-pc"*.

The three cards are now selected in an explicit order, written out above the
`case`:

| Condition | Renders |
|---|---|
| has an `id`, unanswered | the question, with the buttons |
| has an `id`, answered | **nothing** — `tool_use` above named it, `permission_answer` below reports it |
| `standing` | unchanged — hands over the command, no question to answer |
| neither | the CLI fallback's report, **grant button removed** |

The grant button is gone because it writes a rule the SDK path does not need —
and worse, one that shadows `canUseTool` silently if the runner is ever switched
back. `useJobs.allowRule` and `POST /api/jobs/allow` are now **unreferenced from
the UI**; left in place, but they are candidates for removal with the CLI path.

### One rough edge, seen once, not reproduced

On one attempt the tool came back with:

```
Tool permission request failed:
AbortError: Tool permission stream closed before response received
```

That is **not** Operator's deny message — it is the SDK abandoning its own
control stream before an answer arrived. Two candidate explanations, both
consistent with it: a card that could not be reached until the SDK gave up
(above), or a stale bundle rendering the old dead-end card so nothing was ever
sent. Either way the server was doing the right thing. If it recurs, capture how
long the card sat before the tap.

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
