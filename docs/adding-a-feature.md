# Adding a Feature

The recipe for a new top-level feature (Learning, Gym, Forex, Work, Journey,
Statistics, Settings). Follow it in order. Every step matches what the three
built features already do — deviating is a decision that needs stating, not a
detail.

## Before you write anything

1. **Read `CLAUDE.md`** and [`architecture.md`](architecture.md).
2. **Decide the tonal register** — playful, calm, or neutral. See
   [`design-system.md`](design-system.md). If the request doesn't say, infer it
   from the request's own tone and **state which you picked** in your response.
   Don't default to copying whichever feature you read last.
3. **Check [`roadmap.md`](roadmap.md)** for what this feature is already
   intended to be, and which reserved integration points point at it. Journey
   and Knowledge Vault in particular already have free-text fields in
   `MissionRecord` waiting for them.
4. **Confirm the scope of persistence.** If the feature seems to need a backend,
   a database, sync, or any network call — stop and raise it (`CLAUDE.md, "What this is"`).
   That is a hard constraint, not a default.

## The steps

### 1. Types — `lib/types.ts`

Append a new section at the end. Keep the section-comment style:

```ts
// --- Gym -----------------------------------------------------------------
// One or two lines on what this feature owns and why the shape is what it is.
```

Do not modify or reuse another feature's types. Duplication across features is
acceptable here and cross-feature coupling is not — that is the same call made
for `Mission` vs `MissionRecord`
([ADR 0003](decisions/0003-separate-mission-types.md)).

Keep it flat: a typed array of objects. No generic entity base type
(`CLAUDE.md, "Architecture pattern"`).

### 2. Seed data — `lib/seed.ts`

Add one export, `seed<Feature>`. Use the existing relative-date helpers
(`futureMonth`, `pastDays`, `nextDays`, `hoursAgo`) rather than absolute dates so
a fresh install never looks stale. Use short literal IDs (`"g1"`, `"g2"`) — the
literal/UUID split is a useful signal that a record is untouched seed content.

Seed content should reflect the owner's actual life, in the register you chose.
Look at `seedMissionRecords` for the standard.

### 3. Hook — `hooks/use<Feature>.ts`

This is the only file allowed to touch the feature's storage.

```ts
export function useGymData() {
  const [sessions, setSessions] = useRemoteStorage<GymSession[]>(
    "gym.sessions",
    seedGymSessions
  );

  function addSession(/* ... */) { /* ... */ }

  // derived values computed here, never stored
  const weekVolume = sessions.reduce(/* ... */);

  return { sessions, addSession, weekVolume };
}
```

Rules:

- **One namespace**, `gym.*`. Multiple slices under it are fine (Dashboard has
  nine); a key outside it is not.
- Expose **state + mutator functions**, never the raw setter, unless a page
  genuinely needs it.
- Compute derived values here. Don't store them (Invariant 3).
- Use `generateId()` from `lib/id.ts`, never `crypto.randomUUID()` — it throws
  in the non-secure context Operator actually runs in (**OPS-001**).
- If the feature has a user-visible event log, cap it (missions cap at 30,
  dashboard at 20).

### 4. Components — `components/<feature>/`

Presentational only: props in, `on*` callbacks out. No `useRemoteStorage`, no
storage imports, no knowledge of keys.

Reuse `ui/Card` and `ui/EmptyState` if the register fits. `ShieldProgress` and
`Confetti` are Dashboard-register only. Add a `<feature>Meta.ts` if you need
static per-item icons or copy — `components/routine/routineMeta.ts` is the
pattern.

### 5. Page — `pages/<Feature>.tsx`

Calls the hook and threads state down as props. Since v5 the store is shared,
so calling a hook from two places is no longer a correctness bug — but keeping
the page as the single owner keeps components presentational and the data flow
readable.

### 6. Route — `App.tsx`

Replace the `ComingSoon` placeholder:

```diff
-<Route path="/gym" element={<ComingSoon title="Gym" />} />
+<Route path="/gym" element={<Gym />} />
```

The nav entry in `components/layout/Sidebar.tsx` and the command-palette
destination in `components/command/CommandPalette.tsx` already exist for all
seven planned routes — check before adding duplicates.

### 7. Verify

```bash
npx tsc -b        # must exit clean
npx vite build    # must exit clean
```

Both, every time. See [`development.md`](development.md).

### 8. Document

- Flip the row in [`roadmap.md`](roadmap.md) **and** the table in `CLAUDE.md`.
- Add the new keys to the registry in [`data-model.md`](data-model.md).
- If the feature changes an existing persisted shape, add a migration in
  `server/index.mjs` and bump `SCHEMA_VERSION`.
- Write an ADR in [`decisions/`](decisions/) **only** if you made a genuinely
  architectural choice — a new pattern, a cross-feature dependency, a deviation
  from the recipe. Not for routine features.
- Produce the milestone handoff (`CLAUDE.md, "Engineering Handoff"`, format in
  `development.md`).

## Things that will look tempting and are not

**"These two features share a shape — let me extract a generic hook."** No.
`CLAUDE.md, "Architecture pattern"`. Duplication across slices is the design.

**"Statistics needs data from every feature, so I'll call every hook."** This is
now allowed — the store is shared as of v5, so multiple hooks see the same data.
Keep it **read-only**: Statistics should aggregate, never mutate another
feature's slice.

**"Settings should own other features' data to reset it."** It shouldn't — the
API is generic. `GET /api/state` is export, `PUT /api/state` is import, and
`DELETE /api/state/<key>` drops one slice back to its seed, none of which
require knowing what features exist.

**"This feature needs files/attachments."** localStorage cannot hold binary at
any real size. The reserved section in Mission Board's Overview tab is a
placeholder for a design conversation, not an invitation to add uploads
(`CLAUDE.md, "Destructive actions"`).
