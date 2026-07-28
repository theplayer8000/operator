# Known Issues & Technical Debt

The live register. Each item has a stable ID so it can be referenced from
commits, handoffs, and other documents without depending on line numbers.

**Read this before shipping.** The five high-severity entries were fixed in v5
(2026-07-28); everything below OPS-005 is still live.

Status values: `Open` · `Approved` (fix agreed, not applied) · `Fixed` ·
`Accepted` (known and deliberately tolerated) · `Needs decision` (blocked on the
owner).

| ID | Title | Severity | Status |
|---|---|---|---|
| [OPS-001](#ops-001) | `crypto.randomUUID` crashes outside a secure context | **High** | **Fixed** (v5) |
| [OPS-002](#ops-002) | Milestone progress wiped when set to "In Progress" | **High** | **Fixed** (v5) |
| [OPS-003](#ops-003) | No schema versioning or migration path | **High** | **Fixed** (v5) |
| [OPS-004](#ops-004) | Feature hooks don't share memory across instances | Medium | **Fixed** (v5) |
| [OPS-016](#ops-016) | New mission lost when created — write dropped on unmount | **High** | **Fixed** (v5) |
| [OPS-017](#ops-017) | `data/operator.json` has no backup | Medium | Needs decision |
| [OPS-005](#ops-005) | Dashboard mission widgets are decorative | Medium | Needs decision |
| [OPS-006](#ops-006) | Storage writes fail silently | Medium | Partly addressed |
| [OPS-007](#ops-007) | Accent theme is ~95% inert | Low | Needs decision |
| [OPS-008](#ops-008) | Hardcoded hex values in components | Low | Open |
| [OPS-009](#ops-009) | Daily reset is mount-only and UTC-based | Low | Open |
| [OPS-010](#ops-010) | Stale module-load date in Topbar | Low | **Fixed** (v6) |
| [OPS-011](#ops-011) | Dead type surface | Low | Open |
| [OPS-012](#ops-012) | No delete or archive path for missions | Low | Needs decision |
| [OPS-013](#ops-013) | Dependency cycles are possible | Low | Open |
| [OPS-014](#ops-014) | Google Fonts breaks the offline-first claim | Low | Needs decision |
| [OPS-015](#ops-015) | Duplicate SVG gradient IDs in `ShieldProgress` | Trivial | Open |

---

## OPS-001

**`crypto.randomUUID` crashes outside a secure context** · High · **Fixed in v5**

> **Fixed 2026-07-28.** `src/lib/id.ts` now exposes `generateId()` with a
> non-crypto fallback, and all eight call sites use it. Verified over Tailscale.
> **Use `generateId()` for any new ID — never `crypto.randomUUID()` directly.**
> The underlying constraint has not gone away: Operator is used at a bare IP, so
> every secure-context API (`crypto.subtle`, `navigator.clipboard`, service
> workers) is still unavailable.

Documented in `CLAUDE.md:202-231`. `crypto.randomUUID()` exists only in a secure
context (`localhost` or HTTPS). The owner accesses the dev server over Tailscale
at a bare IP, which the browser treats as insecure, so **any action that
generates an ID throws and takes down the page** — adding a task, toggling one,
adding a note, creating a mission, adding a milestone, or logging any activity.

Eight call sites, verified:

```
hooks/useDashboardData.ts:38, 56, 64
hooks/useRoutineData.ts:59
hooks/useMissionBoard.ts:29, 48, 66, 100
```

**Fix (approved, spec'd at `CLAUDE.md:214-224`):** add `generateId()` with a
non-crypto fallback, then replace every call site. Grep for `crypto.randomUUID`
rather than trusting the list above — it will be stale if features were added.

Do this before adding a ninth call site.

## OPS-002

**Milestone progress wiped when set to "In Progress"** · High · **Fixed in v5**

> **Fixed 2026-07-28.** `MilestoneList.setStatus` now builds the patch key by
> key and omits `progress` when it should be left alone. `completionDate` still
> passes an explicit `undefined`, because there the overwrite is the intent —
> commented as such at the call site.

*Not in `CLAUDE.md` — found during the 2026-07-28 review.*

`components/missions/MilestoneList.tsx:44-48` builds a patch containing an
explicit `undefined`:

```ts
onUpdate(id, {
  status,
  progress: status === "complete" ? 100 : status === "pending" ? 0 : undefined,
  completionDate: status === "complete" ? new Date().toISOString() : undefined,
});
```

`hooks/useMissionBoard.ts:115` applies it with `{ ...ms, ...patch }`. **A key
present with the value `undefined` overwrites.** So moving a milestone to "In
Progress" sets `progress` to `undefined`:

- `Milestone.progress` is typed `number` but holds `undefined`;
- the bar renders `width: "undefined%"`, which is invalid CSS;
- the bad value is persisted to localStorage.

The same mechanism clears `completionDate`, where it *is* the intent.

TypeScript cannot catch this — an explicit `undefined` is well-typed against
`Partial<Milestone>`.

**Fix options:** omit the key instead of passing `undefined`; or strip
`undefined` values in `updateMilestone` before spreading. The first is smaller
and keeps the "explicit undefined means clear" behaviour available for
`completionDate`.

## OPS-003

**No schema versioning or migration path** · High · **Fixed in v5**

> **Fixed 2026-07-28.** The store now carries `schemaVersion`, and
> `server/index.mjs` runs a `MIGRATIONS` array oldest-first on load. Add one
> entry per persisted shape change. The defensive-read guidance below is still
> good practice, but it is no longer the only line of defence.

`lib/storage.ts:11-19` casts parsed JSON straight to `T` with no validation.
Seeds persist on first render, so every future shape change lands on browsers
already holding the old shape. Add an array field, render it with `.map()`, and
the page white-screens.

`importAllData` (`lib/storage.ts:42-49`) has the same gap from the other
direction — no validation, no version check.

Interim rules are in [`data-model.md`](data-model.md#changing-a-persisted-shape--read-this-first):
additive changes only, defensive reads, never rename or retype a shipped field.

**Decision needed:** add a `schemaVersion` key and a migration hook, or accept
"wipe and re-seed if it breaks" for a single-user app. This gets more expensive
with every namespace added.

## OPS-004

**Feature hooks don't share memory across instances** · Medium · **Fixed in v5**

> **Fixed 2026-07-28.** `lib/remoteStore.ts` holds one module-level cache with
> per-key subscribers, consumed via `useSyncExternalStore`. Every call site now
> reads the same data, so calling a feature hook twice is safe and **Statistics
> is no longer blocked**. Invariant 1 in `architecture.md` is retired.

`useLocalStorage` is `useState` + a write-through effect with no context and no
`storage` listener. Every call site gets an independent copy; two mounted
callers of the same feature hook diverge and clobber each other last-writer-wins.
Two browser tabs do the same.

Safe today only because each page calls its hook once and pages aren't mounted
simultaneously. Nothing enforces it. See Invariant 1 in
[`architecture.md`](architecture.md#1-a-feature-hook-is-called-once-per-mounted-tree).

**This blocks Statistics**, which is by definition a cross-feature reader.
Resolve it deliberately — likely a read-only aggregation path — rather than ad
hoc inside one feature.

## OPS-005

**Dashboard mission widgets are decorative** · Medium · Needs decision

`CurrentMissions` and `ProjectProgress` render `dashboard.missions` seed data
(EPYC 62%, Homelab 40%, Darams 78%, AI 25%) that never changes. `setMissions` is
returned from `useDashboardData.ts:80` and never consumed, so there is no editor
either.

Also: `components/dashboard/CurrentMissions.tsx:22` reads *"start one from
Projects"* — pre-rename copy that should say "Mission Board". That part is a
plain bug and can be fixed independently of the decision.

The separation itself is deliberate
([ADR 0003](decisions/0003-separate-mission-types.md)) — the question is whether
these two widgets should be the exception.

## OPS-006

**Storage writes fail silently** · Medium · Partly addressed

> **Partly addressed 2026-07-28.** Server writes that fail are now queued and
> retried, and the Topbar shows an offline badge — failures are visible rather
> than silent. The `localStorage` mirror write underneath still swallows errors,
> which is now cosmetic rather than data-losing.

`lib/storage.ts:21-27` swallows every write error. On quota exhaustion the app
keeps working from memory and the user finds out on reload.

Deliberate availability trade-off (Invariant 5), recorded here because the cost
is real. Activity-log caps (30 / 20) reduce unbounded growth. Revisit if
attachments or long histories are ever added.

## OPS-007

**Accent theme is ~95% inert** · Low · Needs decision

`ThemeContext` offers four accents and sets `--accent`, but
`components/ui/ShieldProgress.tsx:10` is the only consumer. Everything else uses
the fixed `xp` token, and no UI exists to change the accent.

**Decision needed:** finish it (route `xp` usages through `--accent`, add the
switcher in Settings) or drop it to gold-only and delete the machinery.

## OPS-008

**Hardcoded hex values in components** · Low · Open

Against `CLAUDE.md:102-103`.

- ~~`pages/MissionDetail.tsx:171` — `accent-[#E8B04D]`~~ — fixed in v6
  (`accent-xp`)
- `components/ui/Confetti.tsx:3` — `COLORS` array
- `components/dashboard/ProductivityScore.tsx:24-42` — Recharts colours

The Recharts one is close to unavoidable (props, not classes) and is reasonable
to leave with a comment. The Confetti one is straightforwardly fixable.

## OPS-009

**Daily reset is mount-only and UTC-based** · Low · Open

`hooks/useRoutineData.ts:22-33` runs the reset in an effect with `[]` deps, so a
tab left open across midnight never resets until reload — and a dashboard is
exactly the app people leave open.

Separately, `todayKey()` uses `toISOString()`, i.e. **UTC**. For a UK user in
BST the routine day rolls at 01:00 local, not midnight.

**Fix:** compute the local date (not `toISOString`), and re-check on an interval
or on visibility change rather than mount only.

## OPS-010

**Stale module-load date in Topbar** · Low · **Fixed in v6**

> **Fixed 2026-07-28.** The date is component state refreshed on a 60s interval.
> The synthetic-`KeyboardEvent` hack is also gone — `CommandPalette` now exports
> `openCommandPalette()`, which matters because a faked Cmd+K meant nothing at
> all on a touch device.

## OPS-011

**Dead type surface** · Low · Open

- `DashboardData` (`lib/types.ts:90`) — declared, never used.
- `Task.dueDate` (`lib/types.ts:13`) — declared, never read or written.
- `Task.missionId` (`lib/types.ts:14`) — declared, never read or written. **This
  is the tasks→missions link the product philosophy rests on**; wiring it is a
  product decision, not a cleanup.
- `Target` icon imported but never rendered in `pages/MissionDetail.tsx:6`.
  Compiles because `noUnusedLocals` is `false`.

## OPS-012

**No delete or archive path for missions** · Low · Needs decision

`MissionRecord.archived` exists and is filtered on
(`hooks/useMissionBoard.ts:139`) but nothing can set it, and there is no delete
anywhere in the app. A mistyped mission is permanent.

## OPS-013

**Dependency cycles are possible** · Low · Open

`components/missions/DependencyEditor.tsx:12` excludes only self-reference. A →
B → A is reachable. Nothing crashes — `DependencyChain` renders one level in
each direction — but the data is nonsense and any future traversal (ordering,
critical path, Journey rollup) would need to handle it.

## OPS-014

**Google Fonts breaks the offline-first claim** · Low · Needs decision

`index.html:7-12` loads three typefaces from a CDN. Offline, all three fall back
to generic sans and the deliberate display/body/mono pairing collapses.

`CLAUDE.md:14-17` explicitly allows this as the one permitted network call, so it
is a known trade-off rather than a violation. **Decision needed:** self-host the
fonts to make offline-first literal, or accept degraded typography offline.

## OPS-015

**Duplicate SVG gradient IDs in `ShieldProgress`** · Trivial · Open

`components/ui/ShieldProgress.tsx:17` derives the gradient ID from progress and
size, so two shields at the same progress emit the same DOM ID. Invisible today
because the gradients are identical. Would break if the gradient ever depends on
anything else.

## OPS-016

**New mission lost when created — write dropped on unmount** · High · **Fixed in v5**

> **Fixed 2026-07-28.** Root cause removed by the shared store in
> `lib/remoteStore.ts` (see OPS-004). Writes now leave the component
> synchronously instead of waiting for an effect that may never run.

Reported as *"the New Mission button doesn't work"*.

`NewMissionForm.submit()` called `onCreate(...)` — which queued `setMissions` —
and then `navigate()` in the same handler. React 18 batched both into one
commit, so `MissionBoard` **unmounted before its write-effect ran**.
`MissionDetail` then mounted, read storage fresh, and found nothing:
*"Mission not found."* The mission was gone.

This was OPS-004 surfacing as visible data loss, and it is the reason the
mutator-then-navigate pattern is safe now but was not before.

## OPS-017

**`data/operator.json` has no backup** · Medium · Needs decision

`data/` is gitignored — correctly, since it will hold personal data — which
means **git is not a backup**. The store is currently a single file on one
machine's disk.

Moving it to a NAS (`OPERATOR_DATA=/mnt/...`) improves durability but is still
one copy. The owner has indicated cloud storage as an interim NAS before the
EPYC server.

**Decision needed** once real data goes in: a snapshot or copy job. Until then
the exposure is limited to seed and test data.
