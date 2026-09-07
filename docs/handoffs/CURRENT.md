# LIVE — Mon 7 Sep ~10:00 (job 6)

## All on main (a890001, build clean, NOT pushed — git push is always his/desk)
- Last night's 2 commits: duplicate Next-up card gone (live), airouter trim announcements move to server log (needs restart)
- .editorconfig added — CRLF fix complete: renormalize was a NO-OP (core.autocrlf=true ⇒ LF always stored)
- AUTO-LAND hook (jobs.mjs): when the queue drains idle → ff-merge to main → rebuild src → phone notify. Never restarts, never pushes. Inert until restart.
- worktree land(): build/restart hint now reads the WHOLE merged range, not just HEAD
- AUTO MODE (jobs.mjs + actions.mjs), per owner's design: a job can request (`auto_mode_request` → `requestAuto`) but the flag flips ONLY in answerPermission — the owner's ALLOW on any gated card is the gate (owner-only by construction). Auto-allowed tools counted+logged (autoUses). No 30-min death (timer lives inside the ask promise). Off: say "turn auto mode off".
- STATS FIX: workRecent collapses duplicate needsOwner records by shape — the "58 waiting on you" was retried failures (413 / empty memory write / aborted); now one entry per shape with dupCount; waitingOnYou is the honest unique count

## ONE RESTART ACTIVATES ALL OF IT
Dev → Restart (or scripts/app.mjs restart). Then auto-land + auto mode + quieter airouter are live. First auto-mode test: a job calls auto_mode_request → owner allows its next card → auto on, no more pings.

## Owner's income scale plan (saved to memory, stated)
Break-even ~£500/mo off Operator → quit Darams (£1.4k/mo now @25h; Kieron £1.8k @~37.5h); £2.5k/mo → quit GEH. He's at work with low attention — auto mode is the point.

## Outstanding for owner
1. RESTART — give me the restart phrase, or tap Dev → Restart himself
2. git push origin main (7+ ahead)
3. SD502 Part 1 → GEH pension officer BEFORE Thu 10 Sep
4. Call creditor TOMORROW morning (Tue 8 Sep): 17 Sep £427.43 final; move to 24th → 18th → split; £200 top-up halves it; pay manually
5. "Operator tab modal" — NOT built (he confirmed); optional future home for an auto-mode switch + stats

## Notes
- handoff_write dirties main's CURRENT.md → blocks next land until committed (hit 4× today). Consider committing handoffs as part of land — NOT fixed.
- agent worktree dirty: only untracked calendar-check.png
