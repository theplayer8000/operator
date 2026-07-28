# Documentation structure

**Date:** 2026-07-28
**Commit:** pending approval

## Summary

Established `/docs` as the long-form documentation layer for Operator, populated
from a read-only architectural review of the codebase at `ab2ef1e`. `CLAUDE.md`
remains the entry point and its existing content is unchanged — two additive
blocks were appended (a documentation map, and the Git Workflow section supplied
by the owner).

A future session now has a documented path from "what are the rules"
(`CLAUDE.md`) to "why are they the rules" (`/docs`), and the fifteen defects and
open questions found during the review are recorded with stable IDs instead of
living in a conversation.

**No source code was changed.** This milestone is documentation only.

## Files modified

| File | Change |
|---|---|
| `CLAUDE.md` | **Additive only.** +18 lines: a "Documentation" map after the intro. +15 lines: the "Git Workflow" section at the end. 300 → 333 lines; no existing line altered |
| `docs/README.md` | New — index, reading order, doc conventions, maintenance rules |
| `docs/architecture.md` | New — feature-slice pattern, composition root, **the five invariants**, what the architecture deliberately lacks |
| `docs/data-model.md` | New — storage key registry, type inventory, seed strategy, ID generation, rules for changing a persisted shape, export/import contract |
| `docs/design-system.md` | New — token tables, the three tonal registers, shared primitives, known inconsistencies |
| `docs/adding-a-feature.md` | New — eight-step recipe for a new top-level feature, plus four tempting things that are wrong |
| `docs/roadmap.md` | New — feature status detail, what each unbuilt feature is for, reserved integration points, suggested sequencing |
| `docs/known-issues.md` | New — the defect/debt register, OPS-001 … OPS-015 |
| `docs/development.md` | New — commands, the verification gate and its real weakness, network/secure-context notes, storage debugging, conflict-escalation table |
| `docs/handoffs/README.md` | New — handoff template and naming convention |
| `docs/decisions/README.md` | New — ADR index, rules, template |
| `docs/decisions/0001-local-first-storage.md` | New |
| `docs/decisions/0002-feature-slice-architecture.md` | New |
| `docs/decisions/0003-separate-mission-types.md` | New |
| `docs/decisions/0004-tonal-registers.md` | New |
| `docs/decisions/0005-no-state-management-library.md` | New |

Also present but **not part of this milestone**: `onboarding-report.txt` in the
repo root, written earlier at the owner's request for external review. Its
content is now superseded by `/docs`. See Outstanding issues.

## Architectural decisions

No architectural changes were made — the documentation describes the system as
it already stands. Five existing decisions were *recorded* as ADRs rather than
made:

| ADR | Records |
|---|---|
| 0001 | Local-first storage, no backend |
| 0002 | Feature-slice architecture, and the single-instance hook invariant it depends on |
| 0003 | Two separate mission types |
| 0004 | Different tonal registers per feature |
| 0005 | No state management library |

Each carries a "What would change this" section, so a future session can tell
"this is now wrong" apart from "I would have done it differently".

Decisions made about the documentation itself:

- **`/docs` explains, `CLAUDE.md` rules.** Where both cover a subject,
  `CLAUDE.md` wins. Stated in `docs/README.md` and in the `CLAUDE.md` map, so
  the precedence can't drift.
- **Issues get stable IDs** (`OPS-nnn`) so commits, handoffs, and documents can
  reference them without depending on line numbers.
- **ADRs are immutable once decided** — supersede, never edit. This mirrors the
  purpose they serve.
- **The `decisions/` folder is explicitly distinguished** from the planned
  Decision Log *feature*, which is a life log, not an engineering one. Flagged
  in two places because the name collision is genuinely confusing.

## Technical debt

**Resolved:** none. No code changed.

**Introduced:** documentation drift risk. Fifteen files now describe a codebase
they cannot enforce, and they carry `file:line` references that will age. Two
mitigations are built in: `docs/README.md` states line numbers are a starting
point to be grepped, not gospel; and it carries a "if you change X update Y"
table so drift has an owner.

**Recorded (pre-existing, not new):** OPS-001 … OPS-015 in
`docs/known-issues.md`. Two are active defects rather than debt —

- **OPS-001** `crypto.randomUUID` crashes over Tailscale. Documented in
  `CLAUDE.md`, approved, still unapplied. Eight call sites.
- **OPS-002** Setting a milestone to "In Progress" wipes its progress, via an
  explicit `undefined` in a spread patch. **Not previously documented** — found
  during this review. TypeScript cannot catch it.

## Documentation updated

All of it — this milestone *is* the documentation. `CLAUDE.md`'s existing
instruction to "read all relevant documentation in `/docs` if it exists"
(line 265 pre-edit) is now satisfiable rather than aspirational.

## Outstanding issues

1. **Nothing has been committed.** Working tree holds three untracked paths:
   `CLAUDE.md`, `docs/`, `onboarding-report.txt`. `CLAUDE.md` has never been
   committed — it predates this session but was untracked at `ab2ef1e`.
2. **`onboarding-report.txt` is now redundant.** It was written for review in an
   external tool; everything in it is in `/docs` in better-structured form.
   Recommend deleting it or leaving it untracked rather than committing a
   second, immediately-stale copy of the same analysis. **Owner's call.**
3. **Ten open questions** from the review remain unanswered — they are recorded
   as `Needs decision` in `docs/known-issues.md` and in `docs/roadmap.md`. The
   three that block or shape real work: OPS-003 (schema versioning), OPS-004
   (blocks Statistics), OPS-005 (Dashboard mission widgets).
4. **The verification gate was not run.** `npx tsc -b` and `npx vite build`
   would emit `.tsbuildinfo` and `dist/`, and this milestone changed no source,
   so it was skipped deliberately. It must be run before any code milestone.

## Recommended next milestone

**OPS-001 — the `generateId()` fix.** It is already approved and specified in
`CLAUDE.md:214-231`, it is the only thing currently crashing the app in the
owner's real usage (Tailscale, bare IP, non-secure context), and it gets cheaper
the sooner it lands — every new feature adds call sites. It is also a good first
exercise of the new Git Workflow: small, verifiable, one clear commit.

If the owner would rather build than fix: **Settings**. It is the smallest
unbuilt feature, everything it needs already exists unused
(`exportAllData`/`importAllData`/`resetAllData`, the accent switcher), and it
retires the largest product risk — there is currently **no way to back data out
of the browser**.

## Assumptions & risks

- **Assumption on "do not rewrite CLAUDE.md".** The brief also asked that
  `CLAUDE.md` direct future instances to the new documents, which requires
  touching it. Resolved as: every existing line left byte-identical, two blocks
  appended. If even that is more than intended, both blocks are contiguous and
  trivially revertible.
- **Assumption on duplication.** Some material appears in both `CLAUDE.md` and
  `/docs` (the feature pattern, the design tokens, the status table). This is
  deliberate — `CLAUDE.md` must stand alone as the entry point — but it is two
  places to update. The precedence rule and the maintenance table exist to
  manage that; it is still a real cost.
- **Risk: ADR reasoning is reconstructed, not recorded.** These five decisions
  were inferred from `CLAUDE.md`, the code, and three commits — not from the
  conversations where they were actually made. The *what* is verified against
  source; the *why* is a careful reading. **The owner should correct any ADR
  whose reasoning misrepresents their actual intent**, particularly 0003
  (separate mission types) and 0004 (tonal registers), which encode product
  judgement rather than technical constraint.
- **Risk: line references age.** Every `file:line` in `/docs` was verified
  against `ab2ef1e` and will drift with the next code change.
- **OPS-002 is unverified in a browser.** It was found by reading
  (`MilestoneList.tsx:44-48` → `useMissionBoard.ts:115`) and the mechanism —
  an explicit `undefined` overwriting through a spread — is certain in
  JavaScript. The visible symptom (`width: "undefined%"`) is inferred, not
  observed. Confirm in the UI when fixing it.

## Verification

- [ ] `npx tsc -b` — **not run**; no source changed, and it emits `.tsbuildinfo`
- [ ] `npx vite build` — **not run**; same reason
- [x] All 15 new documents written and present under `docs/`
- [x] `CLAUDE.md` confirmed additive only (300 → 333 lines, no existing line altered)
- [x] Every `file:line` reference in `/docs` verified against source at `ab2ef1e`
- [x] Internal document links checked against the created file tree

What could not be verified: that the documentation is *true to the owner's
intent*, as opposed to true to the code. See the ADR risk above.
