# Design System

Tokens live in `tailwind.config.ts`. `CLAUDE.md:100-141` states the rules; this
document is the working reference, including the parts that are easy to get
wrong.

## Tokens

Never hardcode a hex value in a component. Use the token classes.

### Base — surfaces and structure

| Token | Hex | Use |
|---|---|---|
| `base-950` | `#0A0C11` | Deepest background — sidebar, checkbox ticks |
| `base-900` | `#0F131A` | App background |
| `base-800` | `#161B24` | Card / surface |
| `base-700` | `#1E2530` | Raised surface, hover, input fill (usually at `/40`) |
| `base-600` | `#2A3240` | Border — the default everywhere |
| `base-500` | `#3D4859` | Muted border, divider, hover-border |

### Ink — text

`ink-100` `#F3F5F8` primary · `ink-300` `#C7CEDA` secondary · `ink-500`
`#8892A3` muted · `ink-700` `#5C6577` faint/disabled.

A useful heuristic from existing code: card titles are `ink-300`, body copy is
`ink-300`, values and headings are `ink-100`, captions and metadata are
`ink-700`.

### Accent

| Token | Hex | Meaning |
|---|---|---|
| `xp` | `#E8B04D` | **The** primary accent — "experience gold". Buttons, active nav, progress fills, focus rings. `xp-bright` for hover, `xp-soft` for tinted fills |
| `rank` | `#8D7FE0` | Secondary — "in progress" states, the repeat-daily indicator, active dependency chips |
| `vital-up` | `#4FB477` | Genuinely positive binary state — streak alive, milestone complete |
| `vital-down` | `#D9685F` | Genuinely negative binary state — streak broken, mission blocked, high-priority dot |

`vital-*` is reserved for binary states. It is not a general red/green palette —
don't use it for emphasis.

### Type

`font-display` (Space Grotesk) for headings · `font-body` (Inter) for everything
else · `font-mono` (JetBrains Mono) for **anything numeric** — stats,
percentages, timestamps, counts, durations. The mono-for-numbers pairing is
deliberate and consistent across all three built features; keep it.

### Shape

`rounded-card` (18px) for cards · `rounded-badge` (10px) for buttons, inputs,
chips, and small icon tiles. Shadows: `shadow-card` (default),
`shadow-glow` (xp-tinted, currently unused).

Use the **`.card-base` utility** (`index.css:38-40`) rather than reassembling
`bg-base-800 border border-base-600 rounded-card shadow-card bg-glass-sheen` by
hand. Pair it with `.animate-fade-up` for entrance.

## The three tonal registers

This is the least obvious rule in the project and the easiest to break by
accident. The tonal differences are **intentional** — see
[`decisions/0004-tonal-registers.md`](decisions/0004-tonal-registers.md).

| Register | Feature | Signature elements | Never |
|---|---|---|---|
| **Playful-but-premium** | Dashboard | Hexagonal `ShieldProgress` badges, `Confetti` on task completion, animated `StatCounter`, a rotating daily quote | — |
| **Calm** | Daily Routine | Vertical rail with filled/unfilled section nodes, minute budgets, `StatCounter` for the day total | Confetti, shields |
| **Neutral / tool-like** | Mission Board | Dot + pill `StatusBadge`, four-dot `DifficultyPips`, plain linear bars with numeric %, tabbed detail | Shields, confetti, XP language, levels, any game HUD framing |

Mission Board should read like Linear or Notion. If you are extending it and
reach for a gamified element, that is the signal to stop.

**When adding a new top-level feature**, decide its register before building
(`CLAUDE.md:138-141`). Infer it from the request's own tone if it isn't stated,
and say which one you picked. Rough guide: daily-glance surfaces lean playful;
long-horizon record-keeping leans neutral; habit and recovery surfaces lean calm.

## Shared primitives (`components/ui/`)

| Component | Notes |
|---|---|
| `Card` | Dashboard grid primitive. `title`, `icon`, `action`, `span` (1–3 columns). Wraps `.card-base` + `.animate-fade-up` |
| `EmptyState` | Icon + message, centred. Use it rather than an inline "nothing here" paragraph on Dashboard widgets |
| `StatCounter` | Animates a number to its value over 600ms with cubic easing. Renders `font-mono tabular-nums` |
| `ShieldProgress` | The Dashboard's signature hexagonal badge. **Dashboard register only** |
| `Confetti` | Burst on completion. Re-trigger by changing its `key`. **Dashboard register only** |

These primitives are described in `CLAUDE.md:87-88` as "Dashboard-flavoured",
which is accurate — `Card` and `EmptyState` are register-neutral and reusable,
`ShieldProgress` and `Confetti` are not. Mission Board uses **none** of them; it
composes `.card-base` directly, which is consistent with its register.

Feature-specific components live in `components/<feature>/`. Promote something
to `ui/` only when a second feature genuinely needs it — not in anticipation.

## Responsive rules

Operator is used from a phone today (`vision.md` — *"no core workflow should
require a desktop computer"*). Desktop is still the primary experience, but
nothing may be desktop-only.

**Breakpoint:** the app uses one meaningful break, Tailwind's `lg` (1024px).
Below it the sidebar becomes a drawer; above it, a persistent rail. `sm`
(640px) is used for padding and type-size tweaks only.

**The rules that matter:**

1. **44px minimum touch target.** Use `min-h-[44px]` on rows and `w-11 h-11`
   on icon buttons. The old 28px (`w-7 h-7`) buttons were unusable on a phone.
   Small *visual* elements are fine — put the padding on the hit area, not the
   icon.
2. **Never gate a control behind `hover:`.** Touch devices have no hover. An
   `opacity-0 group-hover:opacity-100` control is invisible *and* unreachable —
   that is what made the Daily Routine repeat toggle desktop-only. Hover may
   enhance; it may never reveal.
3. **Inputs are `text-base sm:text-sm`.** Anything under 16px makes iOS Safari
   zoom the whole page on focus. The pattern is 16px on mobile, 14px from `sm`.
4. **Long horizontal rows scroll, they don't wrap.** Mission Detail's ten tabs
   and Mission Board's filter chips use
   `overflow-x-auto scrollbar-none -mx-4 px-4 sm:mx-0 sm:px-0` — a single
   scrollable strip that bleeds to the screen edge on mobile and is inert on
   desktop.
5. **A detail panel that sits after a long list in document flow is a trap on
   mobile.** Calendar's day panel used to render below all twelve month grids;
   selecting a day near the top of the year meant scrolling past everything
   below it to reach the form, which read as broken rather than as a long
   page (the owner's words: *"I thought it was broken at first"*). The fix,
   established in `pages/Events.tsx` and reusable for the next page with the
   same shape (a grid/list you pick from, plus a panel for the selection):
   below `lg`, the panel becomes a scrim + floating overlay on selection
   (Escape or scrim-tap closes it, `document.body.style.overflow = "hidden"`
   while open — same mechanism as the Sidebar's mobile drawer); at `lg`+ the
   same component renders as a normal static block, unchanged. One component,
   two positioning modes via conditional classes — not two components.

Also: `min-w-0` on flex children that contain truncating text, or the flexbox
default (`min-width: auto`) makes them refuse to shrink and pushes the page
sideways. `html, body { overflow-x: hidden }` in `index.css` is a backstop, not
a licence to skip this.

Safe-area insets are handled in `index.css` via `env(safe-area-inset-*)`, paired
with `viewport-fit=cover` in `index.html`.

## Known inconsistencies

Tracked properly in `known-issues.md`; summarised here so they aren't copied as
precedent:

- **Hardcoded hex** in `components/ui/Confetti.tsx:3` and
  `components/missions/MissionBadges.tsx` (`STATUS_HEX`, feeding
  `MissionStatusChart`'s Recharts pie). The Recharts one is close to
  unavoidable (it takes props, not classes — and its values are the same
  design tokens as `STATUS_META`'s Tailwind classes, kept in step by comment);
  the Confetti one is not (**OPS-008**). The `accent-[#E8B04D]` in Mission
  Detail was replaced with `accent-xp` in v6. (`ProductivityScore.tsx`, the
  earlier holder of this note, was deleted in v9 — see
  [ADR 0008](decisions/0008-dashboard-reads-the-real-board.md).)
- **The accent switcher is inert.** `ThemeContext` offers four accents and sets
  a `--accent` CSS variable, but `ShieldProgress.tsx:10` is its only consumer —
  everything else uses the fixed `xp` token, and no UI exists to change it
  (**OPS-007**).
- **`darkMode: "class"`** is configured and `<html class="dark">` is static, but
  there are **zero** `dark:` variants in the codebase. There is no light theme
  and none is planned; the config is vestigial.
