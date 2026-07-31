# v25–29 — Installable on the phone, and Operator can now edit its own server

**Date:** 2026-07-31
**Commits:** `adeecc3` … `e1dfe68`
**Milestone:** M15
**Read first:** [`docs/ai-workspace-design.md`](../ai-workspace-design.md) — still the
plan for the chat. One of its four problems got solved by a different, smaller
route than the one it proposes; see *Self-editing* below.

## Summary

Two threads. Operator became a real home-screen app on the owner's iPhone, and
it gained the ability to restart its own backend — which was the last thing
standing between him and working on Operator from Operator.

Everything is over HTTPS now, at the MagicDNS name, which quietly removed a
constraint this codebase has had since v5.

## HTTPS, and the secure-context trap is gone

`tailscale serve --bg 5174` puts the app on `https://<host>.<tailnet>.ts.net`
with a real certificate, tailnet-only, no domain and no public exposure.

That was not cosmetic. Browsers gate `crypto.randomUUID`, `navigator.clipboard`
and service workers behind a secure context, and a bare IP over plain HTTP is
not one. **OPS-004 and the `lib/id.ts` workaround are now avoidable** — they
should stay until someone deliberately removes them, because the LAN address
still exists, but new code no longer has to assume they apply.

The dev server is on `:8443` via a second mapping, so both builds are reachable
from the phone at once. `vite.config.ts` needed `allowedHosts` for that —
scoped to the owner's tailnet, not `true`, because the dev server has the whole
repo behind it (see the `fs.deny` list and OPS-022).

**A trap worth knowing:** `tailscale serve --bg 5174` *replaces* the config
rather than adding to it. Running it again to fix one mapping silently removed
the other. Both commands, always, together.

## The installable app

`public/manifest.webmanifest`, the apple meta tags, and icons generated from
the owner's own logo.

**HTTPS alone is not enough** and this cost a round trip: without a manifest and
`apple-mobile-web-app-capable`, iOS installs a bookmark that still opens inside
Safari's chrome. The manifest is not read for that on iOS — the meta tag is.

**The status bar is `black`, not `black-translucent`.** Translucent runs the page
under the status bar and hands the insets back to you, which only works for a
layout built edge-to-edge. This one is not: the sidebar drawer, the topbar and
the command palette are all fixed or sticky, and **a `padding-top` on `body`
cannot reach a fixed element** — it positions against the viewport. The clock
landed on top of the sidebar header. If a future session wants an edge-to-edge
look, every fixed overlay needs its own inset first.

Icons were generated with `node:zlib` — a hand-rolled PNG encoder and decoder,
about 120 lines, in the scratchpad rather than the repo. The stack is fixed and
a one-off crop is not a reason to grow it. The WebP source was converted with
the codec Windows already has, via PowerShell's `BitmapDecoder`.

## Mobile gestures

- **Swipe the drawer.** Left edge to open, swipe to close, tracking the finger
  with the scrim fading in step. Opening is edge-only because the pages
  underneath have their own horizontal scrollers.
- **Pull down at the top to search**, opening the command palette. Only at
  `scrollY === 0`.

Both decide the gesture's axis once, after 8px, and abandon permanently if the
first movement is vertical. A drawer that grabs every touch makes the page
impossible to scroll. Both register `touchmove` non-passive so they can
`preventDefault` iOS's rubber-band — which is only safe *because* of the axis
check.

## The bug that made the app look broken

**Nothing retried after iOS suspended the app.** Switching away freezes the web
view and drops its connections; on resume the page is restored from a snapshot
and every subsequent fetch fails. The store had a `retry()` and nothing called
it, so the app sat on a screen of "storage server unreachable" that could never
recover.

The diagnosis came from `/api/clients`, not from guessing: the phone's own
record showed **186 successful requests, the last one a minute before the
screenshot**. It was never a network problem.

`remoteStore` now re-reads on `visibilitychange`, `focus` and `pageshow`,
sharing one in-flight request. Side effect worth having: a phone picks up
desktop edits just by being opened.

## Self-editing — solved, and not the way the design doc proposed

The design doc's problem ④ (the agent can't restart its own backend) is fixed by
`scripts/supervise.mjs`: a parent process that relaunches the server when it
exits with code 75. `POST /api/restart` answers first, then exits. `npm run
serve` goes through it; `npm run serve:once` is the raw escape hatch.

**This is deliberately not crash recovery.** A server that dies unexpectedly
stays dead — resurrecting a crash-looping process turns a loud failure into a
mystery. Five restarts in thirty seconds stops the supervisor with the real
error left on screen.

Gated on `deviceMayManage`, the same list that may arm the terminal. Restarting
is a denial of service to every other device, so it must not become something
any authenticated tailnet device can do.

**The frontend half never needed fixing.** `dist/` is read from disk per
request, so `npm run build` puts a change live with no restart at all. That was
already true and nobody had noticed. So:

| Changed | Dev URL `:8443` | Live URL |
|---|---|---|
| `src/` | instant | `npm run build` |
| `server/` | Restart | Restart |

Those two rules are on the Dev page next to the Restart button, because the
moment you need them is the moment you are about to press it.

Step 3 of the design doc — splitting the runner into its own process — is
**no longer required for self-editing**. It may still be wanted for the other
reasons listed there (crash isolation, running the agent on another machine),
but it is not blocking anything now.

## The chat was lying about remembering

`server/workspace.mjs` held the transcript **and the `session_id`** in memory
only. A restart wiped both — so the history vanished and Claude genuinely
forgot, while the page still said the chat remembers. Losing the transcript was
the visible half; losing the id was the half that mattered.

Now saved to `data/chat.json` (gitignored), written after every message and
immediately on receiving a `session_id` — not on a timer, because the case worth
surviving is the process dying, which is exactly when a timer doesn't run.

**New chat deletes the file**, not just memory. That button is how the owner
ends a piece of work; a cleared chat that reappeared after a restart would be a
worse lie than never persisting. He was explicit that he does not want a
permanent log — that answers design-doc open question 1 for the chat, though
not for jobs.

## Terminal: four fixes, one root cause

The root cause was that **what resolved depended on which shell started the
server**, and nothing said so.

1. **Git for Windows only puts some tools on PATH.** `git` and `curl` are in
   `mingw64\bin` (added by the installer); `ls`, `dir`, `grep`, `wc` are in
   `usr\bin` (not). Those directories are now searched when PATH comes up empty.
2. **`bash` was WSL.** Windows ships the WSL launcher as `bash.exe` in System32
   *and* as an App Execution Alias under `WindowsApps` — the alias won — so
   `bash -c "…"` answered "Linux has no installed distributions". WSL stubs are
   demoted below anything else, kept as a last resort.
3. **Output is decoded per chunk.** WSL writes UTF-16LE; forcing UTF-8 kept the
   null byte after every character, so output arrived as `W i n d o w s`.
4. **ANSI escapes are stripped**, and `clear`/`cls` are intercepted client-side.
   `clear` printed `[H[2J[3J` — the command working perfectly, into a `<pre>`
   that can't act on it.

Also: a leading-dash command now says "that's a flag" instead of suggesting
`OPERATOR_TERMINAL_BIN_--LS`.

### Two process lessons from this, worth more than the fixes

**Verifying from the wrong shell proves nothing.** I confirmed `ls` and `dir`
resolved, from Git Bash, and reported it working. The server runs with cmd.exe's
PATH — a different set of directories. The correct test sets `PATH` to
`Machine + User` and runs from there; it is in the scratchpad as
`resolve-test.mjs` and is worth rebuilding if this area is touched again.

**Never write a control character literally into source.** An earlier version of
`stripAnsi` had raw ESC bytes in it, invisible in every editor and diff, which
produced `Invalid regular expression: Unterminated group` on *every* command. It
would have taken the terminal out completely. Reading the file did not reveal
it; a test that extracted the function from source and executed it did. The
patterns are now built with `String.fromCharCode`.

## Smaller things

- **Changelog pages by day** (3, then "Show earlier"). 33 shipped entries at
  once was unreadable on a phone. Paged by day rather than count, because
  cutting at N would slice a date group and imply that was all that shipped.
- **`disarm` / `lock`** typed into the terminal disarms it. No `arm`
  counterpart on purpose — that direction grants execution.
- **`resume operator build`** is a documented trigger phrase in `CLAUDE.md`, and
  ghosts into an empty chat. The owner's idea, from a dashboard note.
- **A Builds card** on `/dev` showing whether the live app is behind `src/`,
  whether the API is behind `server/`, and whether the dev server is up — plus a
  `you: dev` / `you: live` badge read from `import.meta.env.DEV`. Exact;
  inferring from the port is not, because the proxy shows you its own port.
- **`ConfirmButton` takes an optional `icon`.** The two-step bargain is worth
  reusing for disruptive-but-not-destructive actions; a trash can is not.

## Dead ends — do not re-attempt

**Haptics (OPS-021).** Safari implements no vibration API on any platform. The
iOS 17.4+ hidden-switch trick was implemented and tested on the owner's phone:
nothing. Removed the same night rather than left as a silent no-op, because a
feature that cannot be observed to fail is worse than an absent one.

**Telling the installed app from Safari server-side.** The old signal was
omission — WebKit used to drop `Version/` and `Safari/` when standalone — but
iOS 18 sends a byte-identical user-agent either way. Verified on the owner's
phone. Same for Brave, which reports itself as Chrome deliberately. Neither is
in the request; only the page knows. Anything further means the client
volunteering it in a header, which the owner has not asked for.

## Outstanding

1. **The four open decisions** in `CLAUDE.md` are still unanswered for jobs
   (history, permission profiles, concurrency, usage ceiling) — though the chat
   answered the history one for itself.
2. **Design doc steps 1–2** — the job model and `stream-json`. Still the right
   next build: they close streaming, file uploads, image uploads and in-turn
   permissions together. Step 3 is no longer blocking.
3. **Usage counter** — honest framing only, "Operator has used X".
4. **SSH to EPYC**, **Wake-on-LAN** (needs a relay on that network), and the
   **two renames** — all unchanged from the last handoff.
5. **No service worker yet.** The manifest makes the app installable; offline
   behaviour still depends on the store's local mirror. A service worker is now
   *possible* (HTTPS) and would make a cold start work with the server down.

## Recommended next milestone

**Design doc step 1 — the job model, still using `claude -p` underneath.** It
removes the 10-minute cap and gives live visibility without changing the process
model. Ask the open decisions first; they are in `CLAUDE.md` now specifically so
they get asked rather than guessed.

## Verification

- [x] `npx tsc -b` and `npx vite build` clean at every commit
- [x] Restart tested end to end on a spare port: new PID, health 200, supervisor
      log shows the relaunch
- [x] Chat persistence round-tripped: messages, `session_id`, model and the
      `since` offset all survive a restart
- [x] Executable resolution tested with the **machine** PATH: `ls`, `dir`,
      `bash`, `grep`, `git`, `npm`, `curl`, `wc` all resolve
- [x] `bash -c "git log --oneline | head -3"` runs through Git's bash, exit 0
- [x] ANSI stripping tested against the real function extracted from source, and
      end to end against a live server: `clear` → empty, `git log` → clean text
- [x] Tailnet identity survives `tailscale serve`, and a forged
      `X-Forwarded-For` is ignored (recorded in ADR 0010)
- [ ] The mobile gestures have **not** been verified by me on the phone — swipe,
      pull-to-search and the safe-area fixes are the owner's to confirm
- [ ] Nothing tested from outside the home network
- [ ] Terminal state at handoff: **armed** — the owner was using it
