# Landed 2026-09-06: attach button + git:secrets + Studio pair

The update the owner was waiting on is ON main and verified live:

1. **Attach button in the everyday chat (OperatorChat)** — ported the paperclip + chips + one-upload-at-send from OrchestratorChat. Verified working end-to-end today: an image the owner attached through the button reached job-resources and was read back (real PNG data). This fixes "pictures never send."
2. **Idea 3: `git:secrets` health group** (`server/health.mjs`) — pre-land credential scan of what is about to leave the disk (worktree tracked+untracked, main...HEAD, unpushed origin/main..main). High-confidence shapes fail, generic assignments warn; values never echoed.
3. **Roblox Studio MCP passthrough pair** (`server/actions.mjs` rework + `roblox-studio.mjs`) — landed UNPROBED. Studio is open; probe `roblox_studio tools_list` to confirm the pair works.

Worktree verified clean: 0 ahead / 0 behind main, no unlanded commits, no dirty files. Owner ran the landing commands himself (commit pair → rebase → ff → push).

## Still open
1. **"Operator Build Key" value not stored** — he masked it in his screenshot; HE MUST PASTE the actual value so it can be stored as a secret. The OAuth app + API key exist on Roblox's side.
2. Vault graph: off-centre settle + detached fragment.
3. Renderer reliability vs the live map (unsolved).
4. Security guard agent — parked by the owner for "a few months"; idea 3 (pre-land review) was the piece implemented.
