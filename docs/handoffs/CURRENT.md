# Current work

**Restart done and verified.** All four worktree actions, `web_search`, `runway_*`
and the new `git:unlanded` health check are live. That check already reads
correctly: "Nothing committed is waiting to land. 2 file(s) uncommitted in agent
— work in progress, not stranded."

## Landed

- `df5567e` AI Router `run_command` — every command asks, `git push` and delete
  refused before the card, denials survive a shell. 12-case table.
- `cd4fa2e` external links in the Tauri shell. Not a permissions problem;
  `target="_blank"` is inert in a webview. `open_external` via `explorer.exe`,
  deliberately not `cmd` (`cmd /C start "" <url>` is a command injection — `&`
  separates commands). Shell rebuilt; both hotkeys register on start.
- `5f53189` the vault graph. Two measured defects, below.

## The graph, and how it was found

**Annealing changed the balance of forces, not the rate.** Heat scaled the
repulsion and nothing else — springs and the radial pull were never multiplied
by it — so as the graph cooled the only outward force fell to 6% while every
inward force stayed at 100%. It was guaranteed to collapse.

Invisible to one screenshot. Rendered at 1s it filled the frame; at 10s it had
collapsed into a lopsided clump with a detached fragment, which is what he had
been looking at. **His call, and it was the whole diagnosis: "ur viewing at
certain moments not when it fully loads."** Sample the settle, not a frame.

**Rings could not hold their populations.** `MIN_ORBIT*0.7 + tier*190` ignored
how many nodes land on each rung: 68 nodes on a ring with room for 19, 82 on one
with room for 29. Now sized to population. The repulsion cutoff (620) was
smaller than those rings' radii, so the spreading force was off exactly where
the crowd was.

Still wrong: the settled graph is off-centre and keeps a detached fragment.

## Renderer reliability — UNSOLVED, and one theory is dead

`scripts/render.mjs` against the live map either finishes in 7-10s or **hangs
until the timeout and writes nothing**. Not slowness: raising the timeout from
20s to 90s changed nothing. Baseline measured 5 ok / 3 failed over 8 runs,
across both flat and solid.

**Theory tested and WRONG:** that the shared `--user-data-dir` was the lock, so
back-to-back renders blocked on each other. Gave each render its own profile.
Result: **1 ok / 5 failed** — materially worse. Reverted; `server/render.mjs` is
back at HEAD, unchanged.

Next theory, untested: the page polls `/api/state`, and Chromium's virtual-time
budget waits on pending network fetches — so a poll in flight when the budget
should expire stalls it indefinitely. That would explain the intermittency and
the binary outcome. Would mean not relying on `--virtual-time-budget` for a page
that polls.

**This matters more than it looks.** Looking at the map is the whole reason the
renderer is wanted, and a coin-flip renderer is worse than none — you cannot
tell a failed render from a broken layout.

**Runway cannot help here** and was considered: it GENERATES video from a
prompt, it does not capture a page. Pointed at this it would invent a plausible
graph animation rather than show what the code draws, which is the opposite of
evidence.

## Open

1. Off-centre settle + detached fragment in the vault graph.
2. Renderer reliability — the unlock for him doing UI work with his own agent.
3. Roblox Studio pair still uncommitted in the worktree (`actions.mjs` +
   `roblox-studio.mjs` must land together or the server will not boot). Studio
   is open.
4. Push — denied to this session:
   ```bash
   git -C D:\Projects\Operator push origin main
   ```
5. Asked for, not started: rework the Operator chat UI.
