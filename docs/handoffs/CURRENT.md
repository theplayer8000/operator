# LIVE — Mon 7 Sep ~08:40 (job 6)

## Landed on main (c2bbfa4, build clean, NOT pushed — origin still behind)
- calendar: duplicate Next-up card gone; airouter: trim announcements → server log only
- .editorconfig (CRLF fix — renormalize was a no-op: core.autocrlf=true, LF always stored)
- auto-land hook (jobs.mjs): queue drains idle → ff-merge to main → rebuild src/ → notify. Never restarts, never pushes.
- worktree land(): build/restart hint from the WHOLE merged range, not just HEAD

## NEEDS ONE RESTART (then all of the above goes live, incl. auto-land)
Dev Restart or scripts/app.mjs restart. A restart also makes the reborn auto-land land whatever is committed at that point.

## STATS FIX — written + verified, NOT committed (owner declined the commit 08:40)
actions.mjs workRecent: collapse duplicate needsOwner rows by shape (by|jobId|summary|detail) — the "58 waiting on you" was the same failures retried (413 / empty memory write / aborted), ~8 are real decisions. waitingOnYou = deduped count; each row gets dupCount.

## AUTO MODE — written + verified, NOT committed (same refusal)
- job flags: auto / autoRequested / autoUses (blankJob)
- ask(): if job.auto → grant silently + count + log. No phone, no 30-min death (timer lives inside that promise).
- requestAuto(id) export + auto_mode_request action (model-callable, safe: grants nothing)
- CONSENT = answerPermission: owner's "allow" on ANY card of an autoRequested job flips auto=true (owner-only by construction). Deny → stays off.
- Off switch: "turn auto mode off" (voice/prompt).
- UI "Operator tab modal" he mentioned: checked src/ — not built. Batch doesn't depend on it; card answer IS the toggle.

## UNCOMMITTED right now (agent worktree — 6 edits, both gates green)
server/jobs.mjs (4 hunks) + server/actions.mjs (2 hunks). Owner declined the commit — do NOT retry, ask what he wants. Dirty tree blocks land/sync until committed or stashed (stash keeps it; the restore command comes in the stash reply).

## Owner's plate
- git push origin main (he said he would)
- Restart (he offered; needs his confirm phrase, or he taps Dev Restart himself)
- SD502 Part 1 → GEH pension officer BEFORE Thu 10 Sep (in memory)
- Call creditor Tue 8 Sep morning: 17 Sep £427.43 final (in memory)
- Auto mode first test: have a job call auto_mode_request, then allow its next card

## Notes
- handoff_write dirties main's CURRENT.md → blocks next land until someone commits it (hit 3× today). Possible fix: commit handoffs as part of land. NOT fixed.
- git push is refused for agents by policy — always his/desk command.
- calendar-check.png untracked in worktree — leftover render, cannot delete from here.
