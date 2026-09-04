# Current work

**Nothing in flight. Eleven commits on `main`, gates clean, nothing pushed.**

**The server has NOT been restarted.** `server/` is loaded at boot, so the AI
Router file tools and `/api/health/checks` do not exist until it is. That is
deliberate — a restart destroys every job's event log, and it is his call.

## Landed 2026-09-04

**AI Router can touch the code** (`85e8b05`). `server/workspace.mjs` — read,
list, search, write, edit, and a fixed set of **named** checks. No shell:
`run_check` picks which check runs, never what runs. `jobs.mjs` had always
passed `onPermission` into every provider's turn and only the SDK path ever
called it, so a write raises the same card on his phone with no second
permission model. 24 boundary checks pass: `data/` refused (the store, the
per-device push secret, the command audit), `.git/`, `.claude/`, `.env`,
outside-project, write-outside-checkout, and "rm -rf /" as a check name.
`tools` stays `"capability-actions"` — that exact value is the no-escalation
guard — and the new flag is `files: true`, which the reroute also accepts.
ADR 0016 amended: this lets the MODEL choose files where the 09-02 amendment
approved files a CALLER hands down. `OPERATOR_WORKER_FILES=0` revokes it.

**The Health page** (`2d68e50`), `/health` + `GET /api/health/checks`. Every
check is a failure that actually happened: `node --check` across all 55 `.mjs`
(the gate `tsc` and `vite` do not cover), a stale `dist/`, a server older than
`server/`, worktree drift, backups, store growth, environment set in the
registry but absent from the process. Degrades to "could not check" rather than
to red. **Not a plugin** — ADR 0014 is explicit that one reaches `claude-code`
alone.

**The map opens up when you zoom** (`edb18de`). Separation grows faster than
size, so the graph spills off screen and the strands stretch. Denser starfield,
four parallax bands, drawn in screen space. **Nothing has rendered it** — no
dev server was up, so the maths is verified and the look is not.

**The clap will never touch playback** (`e6d352f`). Removed from
`presence-layer-design.md`, and the TV framing is gone from there and from
`dashboard-graph-design.md`. Also a new section on scheduled and triggered
tasks, which is where the templates he saw belong.

**The launcher stopped dropping settings** (`e6d352f`). It named each variable
and had missed ten, including `AIROUTER_API_KEY` and the VAPID keys — the same
silent no-op that made the ceilings unreachable, fourth time. Every `OPERATOR_*`
in the registry is forwarded as a group now (23, where the list named ~9) and
the banner logs **names only**, because the namespace now includes secrets.

**`land.mjs` would have crashed after merging** (`0edef41`).
`execFile("npm.cmd")` throws EINVAL on Node 24, and it failed *after*
`git merge --ff-only` had advanced main.

**The harness is written down** (`0b9ca2e`). `runner.mjs` now passes
`settingSources` explicitly — the SDK's own default, so nothing changes. The
point is that a probe measured 60 inherited commands and nobody had chosen
them.

## Two security findings, both fixed

**greptile was enabled** in `~/.claude/settings.json` — refused by ADR 0014 for
indexing the whole repository on `api.greptile.com`, and its payload is an HTTP
MCP server pointed there. No key was set, so nothing had left the machine. Off.

**The agent worktree had its own permission file with no deny list.** Claude
Code resolves `.claude/settings.local.json` against the session cwd, and jobs
run in the worktree — so it is a *different gitignored file* from the one a desk
session edits. Main had 9 allow / 17 deny; the worktree had 9 allow / **0
deny**, and its allow rules were the single-use kind ADR 0014 called out.
`jobs.mjs`'s `disallowedTools` still covered Operator's own jobs, so this
mattered for a session opened by hand in that worktree. Mirrored; backup beside
it. Written up in the vault as `verified`.

## Task splitting — analysed, and the answer is NO

Measured against 139 recorded turns. **Two of the three things you would build
it for already exist**: concurrency is live at 3, and `delegate.mjs` already
does worker-to-worker hand-down and is pre-allowed. The third is unproven.

The long tail is **not** one model thinking — `job-6/7` ran 895s for $1.11 while
`job-7/7` ran 38s for $1.25. It is tool execution and waiting on a permission
tap, and a split shortens neither. On a median request a merge round trip costs
more than it saves.

Three things instead, cheapest first: pass `usage.rounds` through instead of the
hardcoded `turns: 1`; have `delegate.mjs` and `semantic.mjs` call `recordTurn`
so sub-task **quota** stops being invisible; then decide with a week of data.

## Open, needs him

1. **Restart the server**, then ask AI Router to make a small change and watch
   the permission card appear.
2. **Look at the map in a browser.** Nothing rendered it.
3. **Brave Search API** — vault note. New external host, needs its own named
   approval row. Not touched.
4. **Runway** for video generation — same, needs the row first.
5. **`git push origin main`** — eleven commits ahead, this session cannot push.

## Loose ends

- **No capability action stops a running job.** `jobs_list` and `job_events` are
  read-only, so a chat worker can watch a job it cannot stop. A note in this
  file said he is building that; left alone rather than duplicated.
- The bundle is one 953 kB chunk (269 kB gzipped). Lazy-loading the heavy
  routes, `MissionMap` above all, is a deliberate `src/` change.
- Two comments in `jobs.mjs` still say "one job at a time"; concurrency is 3.
- `.agents/skills/` is an untracked duplicate of `.claude/skills/` — six
  identical files in a directory nothing reads.
- `stash@{0}` in the agent worktree holds its old `AGENTS.md`.
