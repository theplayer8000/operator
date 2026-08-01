# CURRENT — work in progress

**Updated:** 2026-08-01
**Branch:** `main`
**Rule:** see *"Every piece of work keeps a live handoff"* in `CLAUDE.md`.
Overwrite this file as work proceeds; fold it into a dated handoff at a
milestone and reset it to the template at the bottom.

## What this is

Design-doc step 1 is **done and merged** — folded into
[`2026-08-01-job-model.md`](2026-08-01-job-model.md). Read that first.

This note covers only what is still in flight.

## Waiting on the owner

1. **A restart**, to load the `server/jobs.mjs` change. The frontend is already
   built into `dist/` and degrades correctly until then.
2. **Two decisions**, still open in `CLAUDE.md` — concurrency (one job at a time
   or several) and the usage ceiling.
3. **Deleting `server/workspace.mjs`** — 472 lines, no importer, dead since the
   merge. Denied to Claude by the standing profile:

   ```
   git rm server/workspace.mjs
   ```

4. **Which step is next.** The recommendation is **step 3 before step 2** —
   reasoning under *Recommended next milestone* in the handoff. Step 2 is a
   rewrite of `jobs.mjs`, and it cannot be tested from inside Operator until the
   runner stops living inside the server it restarts.

## Landmines

- **`node` on PATH is broken and fails silently.**
  `D:\projects\node_modules\.bin\node` — one directory above this repo — shadows
  `C:\Program Files\nodejs\node.exe` and points at a POSIX path that does not
  exist here. `node --check` exits 0 without running, and `node -e` prints
  nothing. Verify server code with the full path to `node.exe` or you are
  verifying nothing.
- **The two gates do not cover `server/`.** `tsc` and `vite build` never look at
  `.mjs`. A clean build says nothing about a server change.
- **Do not merge a server change on the strength of a clean build.** That is
  what put a half-migration on `main` the first time.

## Next

1. Restart, then trip the standing profile once and confirm the card offers the
   command rather than a grant button.
2. Settle the two open decisions.
3. Start the agreed step.

---

## Template

```markdown
# CURRENT — work in progress

**Updated:**
**Branch:**

## What this is
## Done
## Not done
## Landmines
## Next
```
