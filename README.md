# Operator — Personal OS

A self-hosted personal dashboard. Tasks contribute to missions, missions
contribute to a long-term roadmap — and increasingly, Operator is where its own
development happens.

Everything runs on hardware its owner controls. No cloud, no third-party
backend, no account. The one class of exception is AI model providers, each
approved by name and reached only from the server.

## What's in it

| | |
|---|---|
| **Dashboard** | The daily glance — focus, tasks, notes, live mission and homelab widgets |
| **Daily Routine** | Seven sections on a rail plus a day schedule. Ticks stored per date, so last Tuesday stays readable |
| **Mission Board** | Missions with milestones, dependencies, progress and activity history |
| **Calendar** | Year view, weekly recurrence, per-occurrence notes and skips |
| **Gym** | Today's session as a checklist, keyed by weekday, with skip and rest-day states |
| **Homelab** | A tile per service with a server-side probe that asks the service, not just the port |
| **Orchestrator** | Conversations with AI workers as *jobs* — see below |
| **Dev** | Repo status, a sandboxed file browser, build status, and a terminal for authorised devices |
| **Updates** | The live handoff, a request queue, and a dated changelog of Operator's own development |
| **Settings** | Export, import, per-feature reset |

Learning, Forex, Work, Journey and Statistics are routed placeholders.

## Architecture

**A React frontend and a small Node server.** Data lives in a JSON file
(`data/operator.json`) served over an authenticated API — not in the browser.
`localStorage` survives only as an offline read-mirror, so the app degrades to
last-known data instead of a blank screen when the server is down.

The frontend is React 18 + TypeScript + Vite + Tailwind + React Router +
Recharts + lucide-react, and nothing else. The server was dependency-free until
the Claude Agent SDK arrived, which is confined to a single file on purpose.

**One namespace, one hook, one folder, one page per feature.** Features stay
independent for writes; reads may cross. That constraint is the reason the
codebase has stayed legible while growing.

### The AI side

Work with a model is modelled as a **job**, not a request — an append-only event
log that outlives any HTTP request, so you watch which file it read and which
command it ran rather than a spinner. Jobs survive restarts and are picked up
from any device.

- **Workers** are swappable behind one interface (`server/providers.mjs`).
  Claude Code has full tool access; other providers are model workers.
- **Routing** picks the worker per task — code and repository work to the
  capable agent, questions about your own data to the cheap one.
- **The capability layer** (`server/actions.mjs`) is how a worker changes
  data. Named, validated actions mirroring exactly what the app's own pages do,
  so an AI ticks off a gym session without editing source or touching raw JSON.
- **Permissions are questions, not dead ends.** A tool outside the pre-approved
  list suspends the turn and asks on your phone; answering resumes that same
  turn. Publishing and deleting are never askable — those come back as a
  command to run yourself.

Claude edits Operator from inside Operator, in a **separate git worktree on its
own branch**, so half-finished work is never what the running app is serving.

## Running it

```bash
npm install

npm run dev -- --host   # storage API + Vite, reachable on the network
npm run serve           # built app and API from one port (deployment)
npm run backup          # snapshot the store; runs hourly on its own too
```

`npm run dev` starts **two** processes — the API on 5174 and Vite on 5173. The
extra `--` is required so `--host` reaches Vite; without it a phone can't
connect.

Verification before anything is considered done:

```bash
npx tsc -b        # must exit clean
npx vite build    # must exit clean
```

Neither reads a `.mjs` file, so a clean build says nothing about a server
change — those are syntax-checked separately.

## Security posture

Every `/api/` route requires an identified caller: a device on the owner's
Tailscale network, a bearer token, or loopback. The check sits in front of the
router, so new routes are gated by default.

The embedded terminal and the AI workers share that gate and one more: they run
only for named devices, and start **disarmed** on every boot. Being on the
tailnet gets you the app, not a shell.

There is no sandbox — the terminal runs as the owner. That is a deliberate,
documented trade rather than an oversight, and it is why the gate matters.

## Documentation

`CLAUDE.md` is the entry point and holds the rules; [`docs/`](docs/) has the
long-form reasoning, starting at [`docs/README.md`](docs/README.md). Decisions
that shaped the architecture — and the arguments against them — are in
[`docs/decisions/`](docs/decisions/).

Written by its owner, with Claude Code as a collaborator. The architecture
notes and decision records are part of the project rather than an afterthought:
they exist so a session starting cold, human or otherwise, doesn't silently
reverse a choice that was made for a reason.
