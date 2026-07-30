# v19–20 — Authentication on every API route, and a terminal

**Date:** 2026-07-30
**Commits:** `e7912bb` … `HEAD`
**Milestone:** M13
**ADRs:** [0010](../decisions/0010-tailnet-identity-authentication.md) (auth),
[0011](../decisions/0011-remote-terminal-for-authorised-devices.md) (terminal,
amending 0009)

Fourth handoff of the day. Read `2026-07-30-backups-and-shift-notes.md` first.

## Summary

Two milestones, in the order they had to happen.

**v19 — the API authenticates.** It previously did not, anywhere. `OPS-018`
accepted that on the stated grounds that *"the tailnet is the security
boundary"* — a premise that was **false**: the server binds `0.0.0.0`, Windows
Firewall allows inbound Node on the **Private** profile, and
`curl http://192.168.1.100:5174/api/state` returned the entire store from the
LAN. Shifts, notes, missions, and the repo via `/api/dev/*`. Re-rated **High**
and fixed rather than accepted.

**v20 — the terminal.** The execution half of the Embedded Claude Workspace, so
the owner can drive Claude Code from his phone. ADR 0009 had approved it
local-machine-only "until authentication and authorisation exist"; v19 supplied
that, and ADR 0011 amends 0009 in the open.

## Why this order, and why now

The owner moved to phone-only access mid-session — travelling, not at the
machine "for a while". That changed two things at once: the tailnet became the
*only* path in from arbitrary networks, and a local-only terminal stopped being a
reduced feature and became no feature at all.

## What landed

| Commit | |
|---|---|
| `e7912bb` | Backups moved from an OS task into the storage server (hourly, skips unchanged stores) |
| `525a826` | Auth on every `/api/` route; `xfwd: true` on the Vite proxy |
| `73a3820` | 401 handled as a refusal, not an outage, across the client |
| `466759c` | The terminal: `server/terminal.mjs`, `TerminalPanel.tsx` |
| `028b3bf` | Arm/disarm from the app instead of an env var at the machine |
| `aa82a15` | Poll for output instead of streaming; allow `ls/dir/cat/pwd` |
| `e59ba15` | Spawned commands get no stdin |
| *this one* | Resolve npm-style script shims, so `npm run build` works |

## Findings worth carrying forward

Each of these was found by testing something rather than reasoning about it, and
each would have shipped silently broken.

**1. The Vite proxy launders the client address into loopback.** It proxies
`/api` to `localhost`, so the API sees the proxy, not the phone. A plain
trust-loopback rule authenticated *anything that could reach the dev server* as
if it were at the keyboard. Fixed with `xfwd: true` plus splitting loopback:
bare loopback is this machine, loopback *with* a forwarded address is the proxy.

**2. `xfwd` appends, so the leftmost forwarded address is attacker-controlled.**
Reading it authenticated a LAN peer **as the owner's iPhone**. Now reads the
rightmost entry — the one the trusted proxy observed. Assumes exactly one hop;
a TLS proxy for the planned domain needs an explicit hop count.

**3. Streaming worked on the desktop and failed on the phone.**
`response.body.getReader()` delivered nothing on iOS Safari — the run exited 0,
the output never appeared. Replaced with polling. **The generalisable lesson:
this feature is used from a phone, so "works on the desktop" is not evidence it
works.**

**4. Spawned commands inherited an open stdin.** `claude -p` sat waiting 3
seconds; a bare `cat` would have hung for the full 15-minute timeout. Now
`stdio: ["ignore", "pipe", "pipe"]`.

**5. Windows `.cmd` shims come in two shapes.** `claude.cmd` names a real
`claude.exe`; `npm.cmd` names `node.exe` **and** `npm-cli.js`. Taking the exe
first ran `node run build` → `Cannot find module '…\run'`. In a script shim the
exe is the *interpreter*. npm also lists `npm-prefix.js` before `npm-cli.js`, so
"first .js" is wrong too. Both handled; `npm run build` now exits 0.

**None of these were fixed with `shell: true`**, which would have made all of
them go away and made the audit log a lie about what ran.

## Architectural decisions

Both in ADRs rather than here. The one line worth repeating: **the security
boundary is authentication plus the device list, not the command allowlist.**
Allowing `claude` is allowing arbitrary execution, because Claude Code runs
commands. A future session must not relax the auth on the grounds that commands
are restricted.

## Technical debt

**Resolved:** OPS-018, properly — and its false rationale corrected in place so
it cannot be re-accepted on the same reasoning.

**Introduced:** the terminal's armed state is in memory, so it does not survive a
restart. That is deliberate (fail-closed), but it means an unattended restart
leaves the owner unable to run anything until he taps Arm.

## Outstanding

1. **No client-side token path.** Tailscale identity covers every current device,
   so nothing needed one. The planned move to a real domain does: a login screen
   that stores a token and sends it as a bearer header. `server/auth.mjs` already
   accepts it; only the UI is missing.
2. **A TLS proxy will break the rightmost-address rule** — needs an explicit
   trusted-hop count before `operator.com` happens.
3. **No per-command confirmation, no working directory other than the repo root.**
4. **Not tested with the terminal armed while genuinely away** — every phone test
   so far has been on the same LAN.

## Recommended next milestone

**AI Provider Manager**, per the owner's stated order. One decision first: whether
it calls `api.anthropic.com` directly — a new billing path needing its own named
approval under the external-hosts rule — or shells out to the Claude Code the
owner is already logged into, as the terminal does. They solve different problems
and the answer shapes the design.

## Verification

- [x] `npx tsc -b` and `npx vite build` clean
- [x] **13 auth request shapes**: loopback, tailnet direct, tailnet via proxy and
      token all pass; LAN direct, LAN via proxy, leftmost-spoof, loopback-spoof,
      multi-hop spoof, unknown tailnet peer, `100.63.x`, `100.128.x`, and a wrong
      token all refused and logged
- [x] **No shell proven, not assumed**: `git status && rm -rf x` reaches git as
      literal args, errors `unknown switch 'r'`, exit 129, nothing deleted
- [x] **Device authorisation**: `carbon` (a real tailnet device, not listed) is
      refused on arm and on run and told why; listed devices can arm, run and
      disarm
- [x] **Real use from the owner's iPhone**: `ls`, `git log --oneline -8`,
      `claude --version`, `claude -p "…"` all exit 0 with output displayed
- [x] `npm run build` exits 0 through the terminal
- [ ] Not tested from outside the home network
