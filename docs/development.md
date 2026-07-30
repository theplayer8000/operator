# Development

## Commands

```bash
npm install
npm run dev              # storage API (5174) + Vite (5173)
npm run dev -- --host    # same, bound to all interfaces (Tailscale, LAN, phone)
npm run dev:web          # Vite only, assumes the API is already running
npm run server           # storage API only
npm run build            # tsc -b && vite build
npm run serve            # built app + API from one port — deployment mode
npm run backup           # snapshot the store (skips if nothing changed)
npm run backup:list      # show restore points, newest first
npx tsc -b               # typecheck alone
```

`npm run dev` runs **two processes** via `scripts/dev.mjs`. The extra `--` in
the host form is required so npm passes the flag through to Vite rather than
consuming it itself.

Vite's port is pinned (`strictPort`). Without it, a stale dev server on 5173
pushes Vite to 5174 — the API's port — and it proxies `/api` to itself and
hangs. If ports are stuck:

```bash
netstat -ano | grep LISTENING | grep ":5173 "   # find the PID
taskkill //F //PID <pid>
```

### Environment

| Variable | Default | Purpose |
|---|---|---|
| `OPERATOR_DATA` | `data/operator.json` | Where the store lives. Point at a NAS mount |
| `OPERATOR_PORT` | `5174` | Storage API port |
| `OPERATOR_HOST` | `0.0.0.0` | Storage API bind address |
| `OPERATOR_SERVE_DIST` | unset | `1` serves `dist/` too (same as `--serve-dist`) |
| `OPERATOR_BACKUP_DIR` | `<home>/OperatorBackups` | Where snapshots go. **Point this at the NAS when there is one** — that's the whole migration |
| `OPERATOR_BACKUP_KEEP` | `60` | Restore points to keep. Unchanged stores are skipped, so this is 60 *distinct states*, not 60 scheduler ticks |
| `OPERATOR_BACKUP_INTERVAL_MS` | `3600000` (1h) | How often the storage server takes a backup. Floor is 60000 |
| `OPERATOR_TOKEN` | unset | Bearer token accepted as a fallback when the caller isn't on the tailnet. Needed for the future public-domain setup; not needed for phone-over-Tailscale |
| `OPERATOR_TAILSCALE_BIN` | `tailscale` | Path to the tailscale binary, if it isn't on `PATH` |
| `OPERATOR_TERMINAL` | unset | `1` starts the terminal **armed**. Otherwise it starts disarmed and a listed device arms it from the Dev page. The armed state is in memory, so a restart disarms it |
| `OPERATOR_TERMINAL_DEVICES` | empty | Comma-separated tailnet device names allowed to run commands **and to arm it**. Empty means nobody; loopback is always allowed. Environment only — never make this app-editable |
| `OPERATOR_TERMINAL_ALLOW` | `claude,git,npm,npx,node,tsc,rg,ls,dir,cat,pwd` | Executables that may be launched, by name. Never add `cmd`, `powershell`, `sh` or `bash` — that hands back the shell the design exists to avoid |
| `OPERATOR_TERMINAL_TIMEOUT_MS` | `900000` (15m) | Per-run wall clock before the process is killed |
| `OPERATOR_TERMINAL_MAX_BYTES` | `2000000` | Per-run output ceiling |
| `OPERATOR_TERMINAL_BIN_<NAME>` | unset | Explicit path for one command, e.g. `OPERATOR_TERMINAL_BIN_CLAUDE`, for unusual installs |

## Backups

**This is infrastructure, not a feature** (owner's framing, 2026-07-30, when the
store stopped holding demo data). `scripts/backup.mjs` has no dependencies,
imports nothing from `src/` or `server/`, and never calls the API — it reads
`data/operator.json` off disk, so it works when the server is down, when Vite
is down, and when the app has never been opened. **Nothing about it depends on
the Operator UI.** Settings > Export remains as a second, independent route.

Reading the file directly is safe because the server writes via temp file +
rename (atomic), so a reader sees either the whole old file or the whole new
one.

What it guarantees:

- **It refuses to back up a broken store.** Unparseable JSON, a missing `state`
  object, or an empty `state` are all rejected with exit 1 and the existing
  restore points are left untouched — if the live store is broken, the last
  good backup is the valuable thing.
- **It reads back what it wrote** and hash-compares before pruning anything, so
  there is never a window with no good copy.
- **It skips an unchanged store**, so restore points track real edits rather
  than scheduler ticks.
- **Timestamps are local**, never `toISOString()` — an evening backup in BST
  would otherwise be filed under tomorrow (the OPS-009 trap), and a backup with
  the wrong date on it is one you reach for and get wrong.

### Scheduling — the storage server runs it

**The schedule lives in the app, not in the OS** (owner's choice, 2026-07-30).
`server/index.mjs` calls `runBackup()` once on startup and then every
`OPERATOR_BACKUP_INTERVAL_MS` (default 1 hour, floor 1 minute). Nothing to
register; starting the server starts the backups, and moving to the EPYC box
carries the schedule with it instead of leaving a `schtasks` entry behind on a
machine that no longer holds the data.

Hourly is cheap because unchanged stores are skipped inside `runBackup()`: a
quiet hour costs one file read and no restore point. With `KEEP=60` that is the
last 60 times the data actually *changed*, not the last 60 ticks.

The startup run is deliberate — a restart is usually either a deploy or a
crash, and both are moments you want a copy from.

**The import goes one way only** (server → script, never the reverse), so the
script stays standalone: `npm run backup` still works with the server down,
which is exactly when a server-driven timer can't help you. A failing backup is
caught and logged, never allowed to take the storage server down.

If you ever want an OS-level schedule as well — belt and braces, or because the
server isn't always up — this still works:

```bash
schtasks /create /tn "Operator Backup" /tr "cmd /c cd /d D:\Projects\Operator && node scripts\backup.mjs" /sc hourly /st 00:15 /f
```

### Restoring

There is deliberately **no `--restore` flag**. Restoring overwrites live data,
and a one-word command that does that is how the wrong file gets copied over
the right one. Do it by hand:

```bash
npm run backup:list                      # pick a restore point
npm run backup -- --force                # snapshot the current file first
# stop the server, then copy the chosen file over data/operator.json, restart
```

Migrations run on load, so restoring an older-schema backup is fine — the
server brings it up to the current version when it reads it.

## The verification gate

```bash
npx tsc -b        # must exit clean
npx vite build    # must exit clean
```

**Both, before any work is considered done** (`CLAUDE.md:233-242`).

This is the entire safety net. There is no test runner, no linter, and no CI, so
the type checker is the only automated check — and it is weaker than it looks:

- `noUnusedLocals` and `noUnusedParameters` are **both `false`**, so dead
  imports and unused parameters compile.
- Two `eslint-disable` comments exist (`hooks/useRoutineData.ts:32`,
  `components/ui/StatCounter.tsx:30`) with **no ESLint installed** — they do
  nothing.
- Whole classes of bug pass cleanly. **OPS-002** is the standing example: an
  explicit `undefined` in a spread is perfectly well-typed and silently corrupts
  data.

So: read the diff, and exercise the actual UI path you changed. Passing `tsc`
does not mean it works.

`dist/` and `node_modules/` are gitignored and must not be committed or included
when packaging the project for delivery.

## Running over the network

The owner accesses the dev server over Tailscale at a bare IP
(`http://100.x.x.x:5173`). Browsers treat that as a **non-secure context**,
which is what caused **OPS-001** — `crypto.randomUUID()` is unavailable there
and throws. Use `generateId()` from `lib/id.ts`.

The phone reaches the storage API through the same host, via Vite's `/api`
proxy, so both devices read and write one dataset.

If you are debugging something that only reproduces "on the server", check
whether it is a secure-context API before anything else. `crypto.subtle`,
`navigator.clipboard`, and service workers are all in the same category.

## Inspecting and resetting data

The store is `data/operator.json` — open it in an editor, it is pretty-printed.

```bash
curl -s localhost:5174/api/health              # which file is in use
curl -s localhost:5174/api/state               # everything
curl -X DELETE localhost:5174/api/state/missions.records   # back to seed
```

Seeds only reappear for keys that are **absent**, so deleting a key is how you
get seed data back.

`localStorage` under the `os.` prefix is now only an offline mirror. Clearing it
proves nothing about the real store — and is a good way to verify the migration
worked, since the app should look identical afterwards.

## Milestone handoffs

Every completed milestone ends with a handoff written to
[`docs/handoffs/`](handoffs/) — see the template and naming convention in
[`handoffs/README.md`](handoffs/README.md).

The required contents are fixed by `CLAUDE.md:288-300`:

- Summary of completed work
- Files modified
- Architectural decisions made
- Technical debt introduced or resolved
- Outstanding issues
- Recommended next milestone
- Assumptions or risks for the next session

Write it assuming the next session has **no memory beyond the repository and the
documentation**. That assumption is the whole point — if something only exists
in the conversation, it does not exist.

## Git workflow

The rules are in `CLAUDE.md` under *Git Workflow*. In short: review, update
docs, write the handoff, propose a Conventional Commit message, **wait for
approval**, then stage and commit. Never push unless explicitly told to.

Commit message scopes that match this codebase: `dashboard`, `routine`,
`missions`, `storage`, `docs`, `ui`, `build`. Reference issue IDs where relevant
(e.g. `fix(missions): preserve milestone progress on status change (OPS-002)`).

## When a request conflicts with the documented architecture

Say so before implementing (`CLAUDE.md:267`). The conflicts most likely to come
up, and where the reasoning lives:

| Request | Conflict | Read first |
|---|---|---|
| Add cloud sync / a third-party backend / an external account | Hard constraint — self-hosted only | [ADR 0006](decisions/0006-json-file-storage-server.md) |
| Add Redux / Zustand / React Query | Hard constraint | [ADR 0005](decisions/0005-no-state-management-library.md) |
| Merge the two mission types | Deliberate separation | [ADR 0003](decisions/0003-separate-mission-types.md) |
| Store a value outside `useRemoteStorage` | Bypasses the store, export, and migrations | [`data-model.md`](data-model.md) |
| Extract a generic entity/data layer | Explicitly ruled out | `CLAUDE.md:60-62`, [ADR 0002](decisions/0002-feature-slice-architecture.md) |
| Add confetti/shields/XP to Mission Board | Wrong register | [ADR 0004](decisions/0004-tonal-registers.md) |
| Add file uploads | Reserved, needs design | `CLAUDE.md`, Mission Board Overview tab |

Explaining the conflict is not refusing the request. State it in a sentence or
two, then either implement the version that fits, or implement what was asked
with the trade-off recorded — the owner's call, not yours.
