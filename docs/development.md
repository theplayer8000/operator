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
