# CURRENT — work in progress

**Updated:** 2026-08-19
**`agent`:** option C built and wired. Uncommitted, awaiting review.
**`main`:** untouched. The live app is still on the CLI runner.
**Rule:** see *"Every piece of work keeps a live handoff"* in `CLAUDE.md`.

## What changes for you next

**Permissions are answerable from the phone now.** A tool outside the pre-allow
list suspends the turn, puts a card in the chat with **Allow / No / Allow and
stop asking**, and carries on with the same turn when you tap. The Snapchat case
is one tap instead of six refusals.

To see it you have to **merge `agent` into `main` and restart** — the API runs
from `main`'s `server/`, so nothing on the live app changes until then. The
suggested commit is at the bottom of this note.

**No environment change is needed.** `OPERATOR_JOB_PROFILE` now only switches
the CLI fallback; the SDK path always runs `default` + the pre-allow list. The
"close the window, open a new shell" dance the last note described does not
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
  claim released. That is the third `canUseTool` argument doing its job — the
  one the last note flagged as missing.

- **The card is confirmed on the phone, merged and live** (2026-08-19, after the
  owner merged and restarted). Tested from inside a real job — the running
  session ran gated commands against itself:

  | Command | Outcome |
  |---|---|
  | `git remote -v` | ran silently — read-only, auto-approved by the SDK's classifier before the callback |
  | `curl … \| node -e …` | `Refused from Operator.` — the deny path |
  | `npm --version` | allowed from the phone; **the same turn resumed** and returned `11.18.0` |

  So both answers work, and the line the pre-allow list draws is landing in the
  right place: read-only sails through, outbound and machine-state commands ask.

### Defect found by using it — a long command made the card unanswerable

`subject` is the whole command, rendered in a `<pre>` above the buttons. A
`log-update.mjs` call carries a paragraph of prose, so the block grew until
**Allow was below the fold on the phone**. The card looked tapped-and-ignored,
which from the agent's side is indistinguishable from a denial.

Diagnosed by contrast rather than description: `npm --version` and `npm root`
were answered immediately, while the same long command came back
`Refused from Operator.` twice.

Fixed in `ClaudeChat.tsx` — the block is capped at `max-h-24` and scrolls, so
the buttons stay reachable whatever is being asked about. **Not yet re-tested on
the phone.** To reach the live app: merge, then

```bash
npm --prefix D:\Projects\Operator run build
```

No restart — it is `src/` only. **Not `npm run build` from here**: that builds
the worktree's `dist/`, which nothing serves, and it fails silently. CLAUDE.md
now says so under "Editing Operator while it runs".

### One rough edge, seen once, not reproduced

On one attempt the tool came back with:

```
Tool permission request failed:
AbortError: Tool permission stream closed before response received
```

That is **not** Operator's deny message — it is the SDK abandoning its own
control stream before an answer arrived, which from the phone looks like a card
that did nothing when tapped. The next identical attempt was answered normally,
so it is intermittent.

Best guess: an answer landing after the SDK had already torn the stream down —
a race in the transport rather than in the questions registry, since a genuine
timeout resolves through `finish()` and would have produced `Refused from
Operator.` instead. **Unproven.** Worth watching for; if it recurs, the thing to
capture is how long the card sat unanswered before the tap, because that is what
separates a transport idle-close from anything of ours.

## Still open

- **Concurrency** and the **usage ceiling** — undecided, both in `CLAUDE.md`.
- **Uploads** — an original ask, design-doc step 2's surviving half.
- `server/workspace.mjs` is dead; delete it once step 1 has a week of use.
- The CLI fallback (`OPERATOR_JOB_RUNNER=cli`) and the whole spawn path should
  come out once the SDK has a few weeks of real use. Two runners is a tax.
- **"Stop asking about this one" matches the exact command, and only that.**
  The test made this visible: `node -e "…"` was refused by the shadowed-`node`
  trap, Claude retried with the real binary, and that was a *second* question
  because the rule string differed. So the button suppresses a repeat, not a
  family. Widening it to a prefix is a real option, but it is the same
  over-matching hazard `matchesStanding` documents — decide it deliberately.
- `remembered` grants are in memory and forgotten on restart. Deliberate — see
  the note on it — but worth revisiting if you find yourself re-tapping.

## Suggested commit — needs your approval first

```
feat(claude): answer a permission from the phone, mid-turn

Wires the SDK runner in on the standing profile's option C: default mode
plus a pre-allow list, so ordinary work stays quiet and anything outside it
suspends the turn and asks. Measured pausing for 6s and resuming 4ms after
the answer.
```

Stage by name — `git add -A` is banned here and two sessions write to this tree:

```
git add server/runner.mjs server/jobs.mjs server/index.mjs \
        src/hooks/useJobs.ts src/components/dev/ClaudeChat.tsx \
        docs/handoffs/CURRENT.md CLAUDE.md
```

The probe scripts under `scripts/` are untracked on purpose, same as the
existing `probe-permission.mjs`.
