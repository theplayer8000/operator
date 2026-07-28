# v6 — Mobile / responsive pass

**Date:** 2026-07-28
**Commit:** pending approval
**Milestone:** M3

## Summary

Operator is now usable from a phone. The sidebar becomes a drawer below
`lg`, every interactive control meets a 44px touch target, inputs no longer
trigger iOS zoom, and long horizontal rows scroll instead of wrapping into
walls.

The most important fix is not cosmetic: the Daily Routine repeat-daily toggle
was `opacity-0 group-hover:opacity-100`, which on a touch device is both
invisible and unreachable. That was a core workflow requiring a desktop, in
direct contradiction of `vision.md`.

This milestone only had value because v5 made desktop and phone share one
dataset — a responsive UI over per-browser storage would have been a nicer
looking wrong app.

## Files modified

| File | Change |
|---|---|
| `src/components/layout/Sidebar.tsx` | Drawer below `lg` (scrim, Escape, body scroll lock, auto-close on navigate); persistent collapsible rail from `lg`. 44px nav rows |
| `src/context/ThemeContext.tsx` | Added `mobileNavOpen` / `setMobileNavOpen`. Presentation state only — still no feature data |
| `src/components/layout/Topbar.tsx` | Hamburger below `lg`; date is now state on a 60s interval rather than module-load (**OPS-010**); search button is a 44px target |
| `src/components/command/CommandPalette.tsx` | Exports `openCommandPalette()`; the Topbar no longer fakes a `KeyboardEvent`. 44px result rows, 16px input, `max-h-[50vh]` on mobile |
| `src/layouts/AppLayout.tsx` | Responsive main padding |
| `src/components/routine/RoutineSectionCard.tsx` | **Repeat toggle always visible**; 44px rows and buttons; larger checkbox |
| `src/components/dashboard/*` | `TodayTasks`, `QuickNotes`, `TodayFocus` — 44px targets, 16px inputs, responsive heading |
| `src/components/ui/Card.tsx` | `p-4 sm:p-5`, `min-w-0` |
| `src/pages/MissionDetail.tsx` | Ten tabs became one scrollable strip; 40px selects/inputs; `accent-xp` replaces a hardcoded hex |
| `src/pages/MissionBoard.tsx` | Filter chips scroll rather than wrap |
| `src/components/missions/*` | `MissionCard`, `NewMissionForm`, `EditableField`, `MilestoneList`, `DependencyEditor` — touch targets and 16px inputs |
| `index.html` | `viewport-fit=cover`, `theme-color` |
| `src/index.css` | Safe-area insets; `overflow-x: hidden` backstop |

**Docs:** `docs/design-system.md` (new Responsive rules section), `CLAUDE.md`
(*Responsive is not optional*), `docs/known-issues.md`, `docs/roadmap.md`.

## Architectural decisions

**None — no new patterns.** This milestone changed presentation only. No hook,
type, storage key, or data shape was touched, and no ADR was warranted.

Two choices worth recording:

- **One breakpoint that matters (`lg`).** The sidebar is the only element whose
  *behaviour* changes; `sm` is used for padding and type size only. Resisting a
  ladder of breakpoints keeps the responsive story describable in a paragraph.
- **`mobileNavOpen` went in `ThemeContext`** rather than a new context or a
  prop drill. It is presentation state, which is exactly what that context
  already holds — extending it beat introducing a parallel one.

## Technical debt

**Resolved:**

- **OPS-010** — stale module-load date, plus the synthetic-`KeyboardEvent`
  coupling between Topbar and CommandPalette.
- Part of **OPS-008** — the `accent-[#E8B04D]` hardcode is gone. `Confetti` and
  `ProductivityScore` remain.

**Introduced:** none knowingly. The drawer adds `document.body.style.overflow`
manipulation, which is conventional but is direct DOM mutation — if a second
component ever needs to lock scroll, that needs coordinating rather than
duplicating.

## Documentation updated

`docs/design-system.md` gained a **Responsive rules** section stating the four
rules that get broken most (44px targets, no hover-gated controls,
`text-base sm:text-sm` inputs, scroll-don't-wrap) with the reason for each.
`CLAUDE.md` points at it from the design section.

## Outstanding issues

1. **Not yet verified on a real phone.** Built and type-checked; the owner
   tested v5 on both devices but v6 arrived after they signed off for the night.
   **This is the main thing to confirm.**
2. **`ShieldProgress` and `Confetti` untouched.** Both are Dashboard-register
   visual elements that scale by props; they looked fine in the responsive grid
   but were not specifically reworked.
3. **`ProductivityScore`'s Recharts container** was not reviewed at narrow
   widths — `ResponsiveContainer` should handle it, unverified.
4. **OPS-009 (daily reset mount-only + UTC) still open** and is arguably more
   pressing now: a phone left open overnight is exactly the case that breaks.
5. **OPS-017 (no backup)** still open and unchanged.

## Recommended next milestone

**Settings.** It is the smallest remaining feature, it is mostly plumbing over
the API that already exists (`GET /api/state` export, `PUT /api/state` import,
`DELETE /api/state/<key>` per-feature reset), and it is the only route to
closing **OPS-017** — there is currently no way to get a backup out of the
store.

**OPS-009** would be a sensible small companion fix: local-date comparison plus
a visibility-change re-check, so an overnight phone actually rolls the routine.

## Assumptions & risks

- **Assumed 44px** as the touch-target floor (Apple HIG). Android's Material
  guidance says 48dp; 44 is the more conservative common denominator and matches
  the existing 40px-ish visual rhythm without redesigning the spacing scale.
- **Assumed `lg` (1024px)** is the right desktop threshold. A landscape tablet
  will get the drawer rather than the rail. That is defensible but is a guess
  about a device the owner has not mentioned — a laptop is coming, which will
  sit above `lg`.
- **`text-base sm:text-sm` is applied per input**, not globally. New inputs will
  not inherit it. This is a convention held only by documentation.
- **Not tested on real hardware** — no iOS Safari, no Android Chrome. The iOS
  zoom behaviour and safe-area insets in particular are implemented to spec, not
  observed.

## Verification

- [x] `npx tsc -b` clean
- [x] `npx vite build` clean
- [x] Dev server running on Tailscale with both processes healthy
- [ ] **Not exercised on a physical phone** — the one thing that actually
      validates this milestone
- [ ] Landscape / tablet widths not checked
