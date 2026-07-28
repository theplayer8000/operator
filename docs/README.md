# Operator — Documentation

`CLAUDE.md` in the repo root is the **entry point**. It holds the rules: what
this project is, what must not be added, and the pattern every feature follows.
It is intentionally short enough to read in full before touching anything.

This folder holds the **long-form knowledge behind those rules** — the why, the
detail, and the things that would otherwise be rediscovered by reading a dozen
files. Nothing here overrides `CLAUDE.md`. Where the two touch the same subject,
`CLAUDE.md` states the rule and the document here explains it.

## Reading order for a new session

If you are picking this project up cold, read in this order and stop when you
have what the task needs:

1. **`CLAUDE.md`** (root) — the rules. Always. Not optional.
2. **[`vision.md`](vision.md)** — why Operator exists. Equal in weight to
   `CLAUDE.md`. The rules say how to build; this says what it is for, and the
   two can pull against each other. When they do, say so before proceeding.
3. **`architecture.md`** — how a feature is put together, and the invariants
   that hold the whole thing up.
3. The document that matches your task (see the map below).
4. **`known-issues.md`** — before shipping anything, so you don't build on top
   of a known defect or re-report one.

## Document map

| Document | Owns | Read it when |
|---|---|---|
| [`vision.md`](vision.md) | Why Operator exists; the long-term destination; the AI philosophy | **Always.** Before any decision with a multi-year consequence |
| [`architecture.md`](architecture.md) | The feature-slice pattern, data flow, composition root, architectural invariants | Adding or changing any feature; anything that touches state |
| [`data-model.md`](data-model.md) | Domain types, the `os.*` storage namespace registry, seed strategy, ID generation, the migration gap | Adding a type, adding a storage key, changing a persisted shape |
| [`design-system.md`](design-system.md) | Design tokens, the three tonal registers, shared primitives | Building any UI |
| [`adding-a-feature.md`](adding-a-feature.md) | Step-by-step recipe for a new top-level feature | Building Learning, Gym, Forex, Work, Journey, Statistics, Settings |
| [`roadmap.md`](roadmap.md) | Feature status, what each unbuilt feature is meant to be, reserved integration points | Planning; deciding what's next |
| [`known-issues.md`](known-issues.md) | The live defect and technical-debt register | Before shipping; when something behaves oddly |
| [`development.md`](development.md) | Commands, the verification gate, network access, the handoff format | Running, verifying, or handing off work |
| [`decisions/`](decisions/) | Architecture Decision Records — the reasoning behind choices that look questionable without context | Before "fixing" something that looks wrong; before proposing a change to an established pattern |

## Conventions used in these documents

- **Code references are `file:line`** (e.g. `hooks/useMissionBoard.ts:115`),
  relative to `src/` unless the path starts with `docs/` or is a root file.
  Line numbers drift — treat them as a starting point, not gospel, and grep to
  confirm.
- **"Verified"** means it was read in the source at the time of writing.
  **"Planned"** means it is agreed but not implemented. **"Proposed"** means it
  is an open suggestion awaiting the owner's decision.
- Issues have stable IDs (`OPS-001`…) so they can be referenced across
  documents and commits without depending on line numbers.

## Keeping these current

The rule from `CLAUDE.md` — *update documentation if architecture or design has
changed* — resolves here as:

| If you change… | Update… |
|---|---|
| A persisted type, a storage key, or seed data | `data-model.md` |
| The feature pattern, or add a cross-feature dependency | `architecture.md` and an ADR in `decisions/` |
| A design token, or add a component to `ui/` | `design-system.md` |
| A feature's build status | `roadmap.md`, and the table in `CLAUDE.md` |
| Anything in `known-issues.md` | Mark it fixed there, in the same commit as the fix |
| A decision that reverses or supersedes an ADR | Write a new ADR; mark the old one Superseded. Never edit a decided ADR's substance |

Do not let a document become a changelog. Git holds the history; these describe
the system as it stands now.
