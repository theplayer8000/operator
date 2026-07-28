# Engineering Handoffs

One document per completed milestone. Required by `CLAUDE.md` — *Engineering
Handoff* and *Git Workflow*.

**Naming:** `YYYY-MM-DD-short-slug.md` — e.g. `2026-08-02-generate-id-fix.md`.
Date first so the folder sorts chronologically.

**Audience:** the next session, which has **no memory beyond the repository and
this documentation**. Anything that lives only in a conversation does not exist.
Write accordingly — name files, name issue IDs, name what you decided and why.

**Length:** as short as it can be while still being complete. A one-line fix
gets a short handoff. Don't pad it.

---

## Template

```markdown
# <Milestone name>

**Date:** YYYY-MM-DD
**Commit:** <hash, or "pending approval">

## Summary

What was completed, in two or three sentences. What the user can now do that
they could not before, or what now works that did not.

## Files modified

| File | Change |
|---|---|
| `src/...` | one line |

## Architectural decisions

Decisions made during this milestone and why. If any of them is genuinely
architectural — a new pattern, a cross-feature dependency, a deviation from
the recipe in `docs/adding-a-feature.md` — write an ADR in `docs/decisions/`
and link it here rather than burying the reasoning in this handoff.

Write "None — followed the established pattern" if that is the truth. It
usually should be.

## Technical debt

**Resolved:** OPS-nnn, ... (and mark them Fixed in `docs/known-issues.md` in
the same commit)
**Introduced:** anything knowingly left rough, added to `docs/known-issues.md`
with a new ID.

## Documentation updated

Which documents changed and why. If none did, say so and confirm none needed
to — an architectural change with no doc update is a defect.

## Outstanding issues

What is still broken or unfinished in the area you touched. Not the whole
register — just what the next session needs to know before continuing here.

## Recommended next milestone

One suggestion, with a sentence on why it is the right next thing.

## Assumptions & risks

Anything you assumed rather than verified, anything that could bite the next
session, anything you would have asked the owner given the chance.

## Verification

- [ ] `npx tsc -b` clean
- [ ] `npx vite build` clean
- [ ] Exercised the actual UI path in a browser

Note what you could **not** verify and why — that is more useful than a tidy
list of ticks.
```
