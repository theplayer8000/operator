# Current work

**Four commits on main, NONE of them live. `server/` loads at boot.**

## Landed this session

**`cc2dc76` — the worktree is a loop now, not a one-way valve.** Four actions
plus the check that was missing:

- `worktree_status` — behind / **ahead** / dirty. `ahead` is the new one and it
  is the whole point: every existing check asked "is the agent running old
  code", none asked "did finished work ever land". That question cost a day.
- `worktree_land` — fast-forward main to the worktree branch. Lands **only what
  is already committed** and never stages anything. That constraint is the
  feature: an auto-lander that staged everything would have shipped
  `roblox-studio.mjs` half-finished next to an `actions.mjs` that imports it,
  which is a server that does not boot, landed automatically.
- `worktree_stash` — asked for as "clear dirty trees", built as **stash**.
  `checkout -- .` + `clean -fd` is unrecoverable and this project has no undo.
  Returns the ref and the pop command.
- `main_rollback` — reset, not revert (revert moves forward and still needs
  landing and restarting; the case this is for is a server that will not start).
  Four guards: never rewrite anything on origin/main, backwards only, stash
  first, and report the pre-reset SHA so the undo is undoable.
- `health.mjs` `git:unlanded` — grades committed-but-unlanded loud, and
  uncommitted-only quiet.

**Rejected: gating the merge on an automated check.** `tsc` and `vite build`
never open a `.mjs`, so for `server/` changes a green gate means almost nothing,
and `semantic.mjs` is a 3B model whose guess must not render as a status. A gate
the agent's own work can satisfy replaces a real review with one blind to the
bug class it guards against.

**`f08b6c5` — line endings.** `core.autocrlf=true` with no `.gitattributes` left
the tree mixed: 7 of 44 `server/` files CRLF, and they were the five an agent
edits most. An agent matches exact text, so a multi-line LF match cannot match a
CRLF file — which is why a session gave up on a ONE-WORD change to
`providers.mjs` on 2026-09-04 and left the flag contradicting its own comment.
`* text=auto eol=lf`, 14 files converted, content verified identical.

## Diagnosed, NOT fixed — needs his call

**Arm-on-restart cannot survive a full restart, structurally.** The intent rides
exit code 76 to `supervise.mjs`, which sets `OPERATOR_TERMINAL=1` for one launch.
But `operator_restart` exits **0** on purpose, so the supervisor exits too and
Task Scheduler starts a fresh one with no memory of the request. So arming works
on the Dev page restart and is **silently dropped** by the full restart — which
is the one he actually uses.

Two ways out, and the second is a boundary decision:
1. `operator_restart` takes `arm` and reports it **refused**, the way the shallow
   path already does when unsupervised. Honest, no new mechanism.
2. Actually carry it — which needs the marker in the registry, i.e. the server
   writing an `OPERATOR_*` variable. That is the self-granting escalation the
   env-only rule exists to prevent, even though the caller already passed
   `deviceMayManage`.

Recommend (1). Not built either way.

## Health page triage

Two of the five are not defects: **"server changed since this process started"**
is just this session building, and **"agent worktree behind + dirty"** is the
Roblox pair waiting to land. **"4 commits unpushed"** is his to run.

The two real ones:

- **Store growth.** 1133 KB, and `remoteStore` refetches ALL of `/api/state`
  whenever `updatedAt` moves — so the whole 1.1 MB crosses the wire on every
  write, on 4G. `knowledge.notes` is 741 KB of it. The fix is per-slice fetching
  and it touches client and server, so it is a proposal rather than a tidy-up.
- **"23 of 187 turns ended in an error" is misleading.** Most are his own
  restarts: `stopAll` cancels the running turn and it is recorded as failed. The
  metric alarms in the wrong direction. Worth separating cancelled-by-restart
  from genuinely failed.

Also seen twice at 21:06–21:08: `memory_add` refusing a fact over 240 characters
and asking for it to be split. Small, but it stopped a turn twice.

## Outstanding

1. **Full restart** — nothing above is live.
2. **Land or stash the Roblox pair.** `actions.mjs` + `roblox-studio.mjs` must go
   together or the server will not boot. Studio is open, so the probe is ready.
3. **Push — 4 commits, denied to the session:**
   ```bash
   git -C D:\Projects\Operator push origin main
   ```
4. Prove the uploads path — still never run.
