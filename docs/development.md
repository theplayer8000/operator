# Development

## Commands

```bash
npm install
npm run dev              # Vite dev server, localhost only
npm run dev -- --host    # bind to all interfaces (Tailscale, LAN, phone)
npm run build            # tsc -b && vite build
npm run preview          # serve the production build
npx tsc -b               # typecheck alone
```

The extra `--` in the host form is required so npm passes the flag through to
Vite rather than consuming it itself.

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
which is what causes **OPS-001** — `crypto.randomUUID()` is unavailable there
and throws.

If you are debugging something that only reproduces "on the server", check
whether it is a secure-context API before anything else. `crypto.subtle`,
`navigator.clipboard`, and service workers are all in the same category.

## Browser storage

All state is under the `os.` prefix in localStorage. Useful in DevTools:

```js
// see everything Operator has stored
Object.keys(localStorage).filter(k => k.startsWith("os."))

// reset one feature to its seed (reload after)
localStorage.removeItem("os.missions.records")

// full reset (reload after)
Object.keys(localStorage).filter(k => k.startsWith("os.")).forEach(k => localStorage.removeItem(k))
```

Remember that seeds only reappear for keys that are **absent** — clearing a key
is the only way to see seed data again once the app has run.

Two tabs open on Operator will fight over shared keys (**OPS-004**). Use one tab
when testing persistence.

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
| Add sync / a backend / an account | Hard constraint | `CLAUDE.md:14-17`, [ADR 0001](decisions/0001-local-first-storage.md) |
| Add Redux / Zustand / React Query | Hard constraint | [ADR 0005](decisions/0005-no-state-management-library.md) |
| Merge the two mission types | Deliberate separation | [ADR 0003](decisions/0003-separate-mission-types.md) |
| Share one hook across two mounted components | Breaks Invariant 1 | [`architecture.md`](architecture.md), **OPS-004** |
| Extract a generic entity/data layer | Explicitly ruled out | `CLAUDE.md:60-62`, [ADR 0002](decisions/0002-feature-slice-architecture.md) |
| Add confetti/shields/XP to Mission Board | Wrong register | [ADR 0004](decisions/0004-tonal-registers.md) |
| Add file uploads | localStorage can't hold binary | `CLAUDE.md:181-185` |

Explaining the conflict is not refusing the request. State it in a sentence or
two, then either implement the version that fits, or implement what was asked
with the trade-off recorded — the owner's call, not yours.
