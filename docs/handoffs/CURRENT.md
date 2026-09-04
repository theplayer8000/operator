# Current work

**Everything below is ON MAIN and NOT LOADED. The server has not been restarted
since 23:12, and every change here is in `server/`.**

## The uploads answer: it was built twice and never merged

He asked why attaching a file in chat still did nothing. Both halves existed and
neither was on `main`:

- `data/job-resources/` carved out of `workspace.mjs`'s `data/` refusal, so a
  claimed TEXT file is actually readable.
- Image attachments turned into **vision parts** in `airouter.mjs` — base64
  data URIs after the text, capped at 4 images / 5 MB each, skipped ones NAMED
  rather than silently dropped, and a 400 from the router retries once with the
  images stripped and repairs its own replay history.

Both sat **uncommitted in the agent worktree** while the server serves `main`.
So all four full restarts loaded a build that had never contained the fix. The
work was fine; nothing had landed it.

Committed on `agent` as `9bc35be`, **by name** — deliberately NOT `actions.mjs`
or `roblox-studio.mjs` (see below). Fast-forwarded onto main.

Also flipped `providers.mjs` `attachments: false` → `true`. The session that
wrote the feature left it false under a comment saying it should be true,
because it could not make the edit land — honest about failing, and still a flag
contradicting the comment directly above it.

## Also landed

- **`9a90adb`** — the health credential check was blind to `BRAVE_SEARCH_API_KEY`
  and `RUNWAY_API_KEY`. Both approved and shipped 2026-09-04, never added to
  `APPROVED_CREDENTIALS`, so when he set them from his phone the page said
  "nothing set in the registry is missing from the running server" — true of the
  two names it looked at, silent about the two it did not. Regex also anchored
  per alternative; `^(OPERATOR_|A|B$)` bound the `$` to the last one only, so
  `AIROUTER_API_KEY_OLD` counted as the real thing.
- **`CLAUDE.md` approval row for `apis.roblox.com`** (uncommitted as of writing).
  The passthrough shipped in `8093110` with no row. The consent was clearly
  given — he set the key and the module documents his intent — but the record
  was missing, and a host in use and absent from that table is the exact thing
  the rule prevents. Worth knowing: it is **the one approved host where a worker
  can change state on a service he does not own** (mutating verbs, every scope
  ticked).

## Outstanding, in order

1. **Full restart.** Nothing above is live. `restart operator now`.
2. **Then prove the uploads path** — attach a text file AND an image to an AI
   Router job. Neither layer has ever run.
3. **Roblox Studio MCP is built but NOT landed.** `server/roblox-studio.mjs` is
   still untracked in the agent worktree and `actions.mjs` imports it at the top
   level — **committing one without the other is a server that will not boot.**
   Land them together, open Studio, then probe `roblox_studio tools_list` first;
   tool names are discovered, not hardcoded.
4. **2 commits unpushed** (`9bc35be`, `9a90adb`) plus the CLAUDE.md commit.
   Denied to this session; run it yourself:
   ```bash
   git -C D:\Projects\Operator push origin main
   ```

## Loose ends

- `BRAVE_API_KEY` (31 chars) is still in the registry alongside the correct
  `BRAVE_SEARCH_API_KEY`. Nothing reads it. Harmless, and one more name than
  there should be.
- The agent worktree is now **1 behind main** and still dirty with the Roblox
  Studio pair, so `worktree_sync` will refuse until those are committed — which
  is correct, that IS half-finished work.
- `server/roblox.mjs`'s header and base host come from Roblox's docs, not from a
  call that succeeded. First real call is the test.
- Job-1 has run 48 turns on one thread. Event logs die on the next restart; the
  work log and this file are what survive.
