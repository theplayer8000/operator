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
| [OPS-017](#ops-017) | `data/operator.json` has no automatic backup | Medium | Automated (v17); still single-machine |
| [OPS-018](#ops-018) | Dev browser exposes the repo over HTTP with no auth | **High** (was Medium) | **Fixed** (v19) |
| [OPS-019](#ops-019) | Homelab status reports port-open, not health | Low | Accepted |
| [OPS-020](#ops-020) | Deletes have a confirm step but no undo | Low | Open |
| [OPS-022](#ops-022) | Vite dev server served every file under the project root | **High** | **Fixed** (v7) |
| [OPS-021](#ops-021) | Separate project with real client data sits inside this repo | Medium | Mitigated, relocation optional |
| [OPS-005](#ops-005) | Dashboard mission widgets are decorative | Medium | **Fixed** (v9) |
| [OPS-006](#ops-006) | Storage writes fail silently | Medium | Partly addressed |
| [OPS-007](#ops-007) | Accent theme is ~95% inert | Low | Needs decision |
| [OPS-008](#ops-008) | Hardcoded hex values in components | Low | Open |
| [OPS-009](#ops-009) | Daily reset is mount-only and UTC-based | Low | **Fixed** (v10) |
| [OPS-010](#ops-010) | Stale module-load date in Topbar | Low | **Fixed** (v6) |
| [OPS-011](#ops-011) | Dead type surface | Low | Open |
| [OPS-012](#ops-012) | No delete or archive path for missions | Low | **Fixed** (v7) |
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

**Dashboard mission widgets are decorative** · Medium · **Fixed** (v9)

`CurrentMissions` and `ProjectProgress` rendered `dashboard.missions` seed data
(EPYC 62%, Homelab 40%, Darams 78%, AI 25%) that never changed. `setMissions`
was returned from `useDashboardData` and never consumed, so there was no editor
either.

The open product question — *should these read the real board?* — was answered
by the owner in v9: yes. Both widgets now read `missions.records` through
`useMissionBoard()`, read-only, and link to `/missions/:id`. The Productivity
Score card had the same defect (a "7-day trend" over seven hardcoded numbers)
and was replaced by `MissionStatusChart`, derived from the same real data.

`dashboard.missions`, `dashboard.productivityHistory`, the `Mission` type and
`seedMissions` are all retired. See
[ADR 0008](decisions/0008-dashboard-reads-the-real-board.md), which supersedes
ADR 0003.

The stale *"start one from Projects"* copy went with the rewrite.

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

**Daily reset is mount-only and UTC-based** · Low · **Fixed** (v10), **moot** (v16)

> **Moot as of v16.** The reset this describes no longer exists.
> `routine.completions` is keyed by date (schema v3), so a date with no entry is
> simply a date nothing was ticked on — there is nothing to roll back and no
> midnight boundary to get wrong. The wider lesson at the bottom of this entry
> still stands and still applies to every date-keyed slice.

Two defects in the same effect. `useRoutineData` compared
`new Date().toISOString().slice(0, 10)` — the **UTC** day — so between midnight
and 01:00 during BST it reported yesterday and the routine rolled an hour late
for half the year. And it ran on mount only, so a tab left open across midnight
never reset at all: a phone in a pocket overnight, which is the common case.

Fixed in v10. The comparison now uses `toDateKey()` from `lib/time.ts`, which
reads the local date parts, and the check re-runs on `visibilitychange` and
`focus` as well as on mount. `lastReset` guards it, so re-checking is free.

Demonstrated before fixing, under `TZ=Europe/London`:

| Local time | `toDateKey` | `toISOString().slice(0,10)` |
|---|---|---|
| 00:30, 2 July | `2026-07-02` | `2026-07-01` ← wrong day |
| 01:00, 2 July | `2026-07-02` | `2026-07-02` |

**The wider lesson is in `lib/time.ts`:** never build a calendar day with
`toISOString()`. It converts to UTC first. Anything date-keyed — the routine
reset, events, a future Gym log — must use `toDateKey`.


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

**No delete or archive path for missions** · Low · **Fixed** (v7)

`MissionRecord.archived` existed and was filtered on but nothing could set it,
and there was no delete anywhere in the app. A mistyped mission was permanent.

Fixed in v7 along with edit/delete for tasks, notes, routine steps and
milestones. `setArchived` and `deleteMission` live in `useMissionBoard`;
both are surfaced at the bottom of `MissionDetail`, below the tabs, with an
"Archived" filter on the board so an archived record can be reached and
restored. `deleteMission` also sweeps the deleted ID out of every other
mission's `dependsOn` — see the note in `data-model.md`.

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

## OPS-018

**Dev browser exposes the repo over HTTP with no auth** · **High** · **Fixed** (v19)

> **The accepted-risk rationale below was false, and this was worse than
> "Medium".** It read *"accepted because the tailnet is the security boundary"* —
> but the server binds `0.0.0.0`, Windows Firewall allows inbound Node on the
> **Private** profile, and `curl http://192.168.1.100:5174/api/state` returned the
> entire store from the LAN. The tailnet was never the boundary; every interface
> was. This exposed the store as well as the repo, so it was never only a Dev-page
> issue.
>
> **Fixed in v19** by authenticating every `/api/` route — see
> [ADR 0010](decisions/0010-tailnet-identity-authentication.md). Tailscale device
> identity (resolved via the local daemon), a bearer token fallback, and loopback
> for the machine itself. Two near-misses found while testing are documented in
> that ADR: the Vite proxy laundering the client address into loopback, and
> `X-Forwarded-For` append semantics making the leftmost entry spoofable.
>
> The rationale is now true rather than assumed — but **it depends on
> `xfwd: true` staying on the Vite proxy**. Remove it and port 5173 becomes a
> full bypass again.

`server/dev.mjs` serves the project directory read-only at `/api/dev/*`. It is
sandboxed — traversal outside the repo root is rejected, and `node_modules`,
`.git`, `dist` and `data` are excluded.

Verified at implementation: `..`, `../../../Windows`, `data`, `node_modules`
and an absolute-ish sibling path were all rejected.

## OPS-019

**Homelab status reports port-open, not health** · Low · Accepted

`server/homelab.mjs` does a TCP connect. A process that is hung but still
holding its port reads as online. This is deliberate — see
[ADR 0007](decisions/0007-homelab-server-side-probes.md); anything richer means
per-service health endpoints, which couples Operator to each service's
internals. The Homelab page states the limitation on the page itself rather
than implying more certainty than it has.

Revisit the first time a tile says "online" about something visibly broken.

## OPS-020

**Deletes have a confirm step but no undo** · Low · Open

v7 added delete for tasks, notes, routine steps, milestones and missions. Each
is two-step (`components/ui/ConfirmButton.tsx`) and self-disarms after four
seconds, but once confirmed the record is gone — there is no undo buffer and no
soft-delete for anything except missions, which have archive.

The store is a single JSON file with no history, so recovery today means
restoring the whole file — which is also **OPS-017**, and is the second reason
that one matters. A cheap improvement would be a short-lived "undo" toast
holding the deleted item in memory; the honest fix is snapshots.

## OPS-022

**The Vite dev server served every file under the project root** · **High** ·
**Fixed** (v7)

`npm run dev -- --host` binds to the tailnet, and Vite's static middleware will
serve anything under the project root as an asset. No auth, by design — Vite
assumes localhost.

Verified before the fix, against the running dev server:

| Path | Result |
|---|---|
| `GET /data/operator.json` | **200 — the entire Operator store, 36 KB** |
| `GET /Darams-CRM/darams_crm.db` | **200 — the CRM's SQLite database, 53 KB** |
| `GET /Darams-CRM/uploads/tenancies/1/EICR.pdf` | **200 — a real tenancy document** |

This is a **third, independent door**. `.gitignore` does not apply to it, and
neither does the `DENY` set in `server/dev.mjs` — those guard git and the Dev
browser respectively. It is easy to close one and assume the others followed.

Fixed with `server.fs.deny` in `vite.config.ts`, covering `data/`,
`Darams-CRM/`, `*.db`, `*.sqlite` and `.env*`. Re-verified: all of the above
now return 403, while the app and the `/api` proxy still return 200.

**Production is unaffected** — `npm run serve` serves `dist/` only, and never
had this behaviour. This was dev-server-only, which is also why it went
unnoticed: dev is exactly where `--host` gets used.

If a future change adds a directory holding anything private, add it to that
deny list. The lesson worth keeping: three different mechanisms decide what
leaves this machine, and they share no configuration.

## OPS-021

**A separate project with real client data sits inside this repo** · Medium ·
Mitigated, relocation optional

`Darams-CRM/` is a separate Flask project (its own repo, own database, own
handoff) that currently lives inside Operator's working directory. It contains
`darams_crm.db` and `uploads/` — real tenancy documents and personal details.

Two live exposures were found and closed in v7:

- **It was untracked but not ignored.** A `git add -A` would have staged client
  PII into a repo with a GitHub remote. Now in `.gitignore`.
- **The Dev browser listed it.** The extension allowlist stopped `.db`/`.pdf`
  *contents* being served, but `listTree` exposed tenancy document *filenames*
  over HTTP. `Darams-CRM` is now in the `DENY` set in `server/dev.mjs`.

A third exposure — the Vite dev server serving the CRM's database and uploads
over the tailnet — turned out to be a **general Operator defect** rather than a
consequence of nesting, and is tracked separately as **OPS-022**.

**Relocating is no longer required.** The owner opted to keep the CRM nested
and hidden, which is sound now that all three doors are shut:

| Door | Guard |
|---|---|
| git history | `Darams-CRM/` in `.gitignore` |
| Dev browser (`/api/dev/*`) | `Darams-CRM` in `DENY`, `server/dev.mjs` |
| Vite dev server | `**/Darams-CRM/**` in `server.fs.deny`, `vite.config.ts` |

**Do not remove any of the three.** They are independent mechanisms sharing no
configuration, so removing one will not fail loudly.

Two things remain true regardless of where the directory sits:

- **The CRM has no version control of its own.** There is no `Darams-CRM/.git`,
  and Operator's repo ignores it — so that project currently has *no history at
  all* while it is being actively rewritten. `git init` in that directory is
  worth doing on its own merits, and a nested repo is invisible to Operator.
- **Operator's backup story still has to cover it** (**OPS-017**), and it is
  now excluded from the one mechanism that was implicitly copying it.

## OPS-017

**`data/operator.json` has no automatic backup** · Medium · Partly addressed (v9)

`data/` is gitignored — correctly, since it holds personal data — which means
**git is not a backup**. The store is a single file on one machine's disk.

**v9 gave it a manual route out.** Settings > Export downloads the whole store
as JSON, read from the server rather than the local mirror (so it's complete,
not just what this browser has loaded), and Import merges one back.

That is a real backup path and it closes the "no way to get a copy at all"
half of this issue. **It does not close the automation half** — an export only
exists if the owner remembers to take one, and nothing is scheduled. The store
now holds real data (9 missions, live routine), so this matters more than when
it was logged.

**v17 automated it.** `scripts/backup.mjs` is a standalone, dependency-free
snapshot job — reads the file off disk, refuses to copy a broken store, verifies
what it wrote before pruning, skips unchanged stores, and keeps
`OPERATOR_BACKUP_KEEP` (60) restore points in `OPERATOR_BACKUP_DIR`. It imports
nothing from the app and never calls the API, so it survives the server being
down. See [`development.md`](development.md#backups) for the `schtasks`
registration and the restore procedure.

**Two things keep this open rather than fixed:**

1. **Backups are still on the same physical machine.** The default is
   `<home>/OperatorBackups`, which protects against a bad write, a bad
   migration, or a mistaken clear — not against losing the disk. There is no NAS
   yet (confirmed with the owner, 2026-07-30); local was accepted as the interim.
   Pointing `OPERATOR_BACKUP_DIR` at a NAS share is the whole remaining step.
2. **Backups only run while the storage server runs.** The schedule lives in
   `server/index.mjs` (owner's choice over an OS task, so it follows the app to
   the EPYC box). If the server is down for a week, no snapshots are taken that
   week — though a store that isn't being written isn't accumulating changes to
   lose either. `npm run backup` remains the manual path and needs no server.

There is also **no automatic pre-migration snapshot**: v8's schema migration ran
against live data with nothing taken first. `npm run backup` before a migration
is now a one-liner, but it is still a habit rather than a mechanism — the
server does not snapshot before running `MIGRATIONS`.
