# Current work

**The full restart drains properly now. NOT YET RESTARTED, so it is not live.**

`server/` is loaded at boot, so this fix — and the AI Router file tools, and
`/api/health/checks` — only exist after a full restart. His call.

## Landed 2026-09-04 (desk session)

**The "soft stop" was a kill with a pause in front** (`server/reboot.mjs`,
`server/jobs.mjs`, `server/index.mjs`). He caught the claim himself. Three
separate holes:

- `stopAll()` marked every job cancelled IN MEMORY and never called `persist()`
  — `remove()` and `clear()` both do. So `shutdown()` exited before anything
  reached disk and `data/jobs.json` kept the attempt recorded as `"running"`,
  which is the precise state reboot.mjs's own comment said the call prevented.
- `process.exit(0)` behind a 750ms `setTimeout`, awaiting nothing. `exit` does
  not wait for pending I/O, so a write in flight could be cut between
  `writeFile` and `rename`. Tmp-then-rename stops a truncated file; it does
  nothing for a write that never ran.
- No `server.close()` and no SIGINT/SIGTERM handler anywhere in `server/`, so
  in-flight requests and job event streams were severed at the socket.

Now: **stop listening → cancel → await the save → exit**, bounded by
`DRAIN_MS` (8s) with each step reporting whether it made it. `jobs.flush()` is
the awaitable persist; every other call site stays fire-and-forget, which is
right mid-turn and wrong on the way out.

**`closeHttp` closes connections in two steps, deliberately.** Idle keep-alive
sockets go immediately (they are what would otherwise hold `close()` open until
the deadline every single time); `closeAllConnections()` only after a 1.5s grace,
because `reboot.mjs` schedules the shutdown a beat after answering the request
that asked for it, and the forced sweep would destroy the `restarting: true`
reply on its way to his phone.

**The listener is REGISTERED, not imported** (`onShutdown()` in reboot.mjs,
called by index.mjs). The first cut had reboot.mjs do `await import("./index.mjs")`
to fetch the closer — which would have booted a second server inside
`scripts/operator-action.mjs`, since that path reaches reboot.mjs via actions.mjs
with index.mjs never loaded. Registration also runs the way the dependency
already points.

**Verified**, not just compiled: a harness on a throwaway port and throwaway
data files, 8 assertions, all pass. `closeHttp` resolved in **2ms** with an idle
keep-alive socket open, and the port refused connections afterwards. `tsc -b`
and `vite build` clean. Never calls `fullRestart` — that spawns the helper,
which kills the real server by command-line match.

## The Dev page restart still hard-exits, and that is FINE

`POST /api/restart` writes the response then `setTimeout(() => process.exit(75), 150)`:
no `stopAll`, no drain, no listener close. That is not an oversight to fix —
**his words: that button is primarily for when he already knows everything is
saved.** It is the fast one, taken deliberately when nothing is running, and
draining it would add up to 8s to the only restart that is currently instant.

The two are now honestly different tools rather than one being a broken copy of
the other: `/api/restart` reloads CODE and assumes a quiet server;
`operator_restart` drains, saves, and re-reads the ENVIRONMENT. Do not "fix"
the first into the second.

## Open, needs him

1. **`BRAVE_SEARCH_API_KEY` and `RUNWAY_API_KEY` are unset.** He has the Brave
   one. `secret_set`, then a full restart — the shallow one re-reads no
   environment.
2. **The restart phrase is still the default**, `restart operator now`.
   `OPERATOR_RESTART_PHRASE` is unset in both User and Machine registry, so the
   phrase is printed in the refusal and stops accidents only. He tried
   `Operator_Restart`, which flattens to `operator restart` and is correctly
   refused.
3. **Look at the map in a browser.** Still nothing has rendered it. Both Vite
   instances are down (5173 and 5175) — `OperatorViteMain` / `OperatorViteAgent`
   in Task Scheduler.
4. **`git push origin main`** — now 9 commits ahead, this session cannot push.

## Loose ends

- Agent worktree is **4 behind main and dirty** (1 uncommitted file), so
  `npm run land` will refuse the fast-forward until that is dealt with.
- The test harness tripped a libuv assertion on exit (`UV_HANDLE_CLOSING`) from
  the clap detector's audio handle being torn down by `process.exit`. Harness
  only, after all assertions passed — but it is the same class of thing as the
  bug above, and the real server exits the same way.
- Store is 1.1 MB, 12x its oldest restore point in 4 days; `knowledge.notes` is
  737 KB of it and the whole store crosses the wire on every write.
- Turn stats: p50 38.4s, p95 354.7s over 147 turns, 21 errored.
- `.agents/` is untracked and duplicates `.claude/skills/`.
