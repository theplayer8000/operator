# CURRENT HANDOFF — Tue 7 Sept 2026 ~00:05

Owner heading to sleep; he will pick up the dev build in the morning. Keep it brief, it's past 10pm — no prose, facts only.

## State: on main (landed, LIVE)
- cfe4c4e: presence/calendar reminders loop, worker npm fix, week agenda — landed, built, restart done. Reminders VERIFIED live tonight: log shows `[presence] reminded at 00:15: ⏰ reminder loop test` (test event created + deleted after). 09:00 CSV reminder event armed for Tue 7 Sept.
- npm install done in worktree; typecheck + syntax (63 mjs) GREEN.
- No more: This-week agenda visible on main only — Next up card was removed locally (see next section).

## PENDING — committed on agent branch, NOT landed (land refuses while a job runs; after idle, LAND)
- 1a26a45: calendar — drop duplicate Next up card, keep This week agenda; lockfile sync from npm install.
- 4f6a58a: airouter — stop announcing context trims (`_Trimmed …_ / _Still …KB_`) in the thread; log to server log instead. THIS was the clutter the owner asked to remove tonight.
- Sequence when idle: land both, then `npm run build` in MAIN checkout D:\Projects\Operator, then refresh. Reminder: land logic drops the build hint when a commit touches both src/ AND server/ — the airouter commit is server/-only so build is optional; 1a26a45 is src/ so NEEDS the build.

## Owner rules recorded in memory (do not re-derive)
- 8ac18a1d: new feature's live test IS the self-verification gate; if test returns true/good, may land — owner handles authorization.
- 7589bd49: wants committed work landed as soon as a job finishes and nothing is processing (currently only blocks on an OPEN job; fix is an Orchestrator hook "job idle → land if ahead of main").
- Memory calls: ALWAYS pass real text — sending empty params throws "a fact needs some text" and annoys him. Happened twice.

## CRLF/LF — root cause found, fix scoped for dev session (NOT done: 00:05, tree-wide rewrite)
- .gitattributes already declares `* text=auto eol=lf` (added 04/09 after providers.mjs incident).
- Gap: tree never renormalized (`git add --renormalize .` + commit in main checkout); no .editorconfig; edit_file only exact-matches, CRLF bricks it.

## Housekeeping
- calendar-check.png untracked in worktree root (leftover render copy — can't delete from agent, leave it).
