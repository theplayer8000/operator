# 0011 — The terminal runs for authorised devices, not just at the keyboard

**Status:** Accepted
**Date:** 2026-07-30
**Amends:** [ADR 0009](0009-permitted-abstraction-boundaries.md) — the
local-machine-only restriction on the embedded terminal.
**Depends on:** [ADR 0010](0010-tailnet-identity-authentication.md).

## Context

ADR 0009 approved the embedded terminal **with restrictions**: local machine
only, no execution over the tailnet "until authentication and authorisation
exist". That was the right call at the time — the API had no authentication of
any kind, so a remote terminal would have handed a shell to anything that could
reach the tailnet, or the LAN (see OPS-018, which turned out to be worse than
documented).

Two things changed on the same day:

1. **ADR 0010 added authentication**, including per-device identity from the
   local Tailscale daemon. The precondition the restriction named is met.
2. **The owner is travelling and will not be at the machine "for a while".** A
   local-only terminal is therefore not a reduced version of the feature — it is
   no feature at all. His words: *"its imperative that i get it setup properly."*

Holding the restriction as written would have meant shipping something he cannot
use. Quietly ignoring it would have meant the architecture rules stop meaning
anything. So it gets amended, in the open, with the authorisation model written
down.

## Decision

**Authorised devices may run commands remotely.** Authorisation is separate from
authentication and deliberately narrower:

| Gate | Controls | Default |
|---|---|---|
| `OPERATOR_TERMINAL=1` | Whether the feature exists at all | **off** |
| `OPERATOR_TERMINAL_DEVICES` | Which tailnet devices may execute | **empty — nobody** |
| `OPERATOR_TERMINAL_ALLOW` | Which executables may be launched | `claude,git,npm,npx,node,tsc,rg` |

Being a known tailnet device gets you the app. It does **not** get you a shell —
that needs naming in `OPERATOR_TERMINAL_DEVICES`. Loopback is exempt: the machine
itself can already open a real terminal, so gating it protects nothing.

Off by default at two independent levels, so no upgrade can quietly expose a
shell and no single mis-set variable is sufficient to open one.

## The security boundary is authentication, not the allowlist

This is the part most likely to be misread later, so it is stated plainly:

**Allowing `claude` is allowing arbitrary code execution.** Claude Code runs
commands — that is what it is for. The same is true of `node`, and of `npm` via
scripts. The executable allowlist is a **seatbelt against a fat-fingered paste,
not a wall against someone holding an authorised device.**

The real boundary is the one in ADR 0010: authentication, plus the device
allowlist above. Do not let a future session reason *"commands are restricted
anyway"* and relax the auth. If anything, the opposite holds — this feature is
why the auth had to be right first.

What the implementation does genuinely guarantee:

- **No shell.** `spawn` with `shell: false` and an argv array. `&&`, `|`, `;`,
  backticks and redirection are inert text. Verified: `git status && rm -rf x`
  reaches git as the literal arguments `&&`, `rm`, `-rf`, `x` and errors with
  ``unknown switch `r'`` (exit 129). Nothing ran, nothing was deleted.
- **Commands by name only.** The executable is resolved server-side from an
  allowlisted name; a path from the client is rejected, so a request cannot point
  at an arbitrary binary.
- **Every run audited** — device, user, argv, exit code, duration — to the
  server log and the Dev panel.
- **Timeout and output cap** (15 min, 2 MB), so a runaway can neither spin
  forever nor exhaust memory.

## Two implementation decisions worth keeping

**No PTY.** A real one means `node-pty`, a native module requiring build tools —
against the dependency rule in `CLAUDE.md`, and `server/` currently has *no*
dependencies. So this is `spawn` without a TTY: correct for anything that runs
and prints, wrong for interactive TUIs. That matches the use case — `claude -p
"…"` prints and exits, and a full-screen TUI on a phone would be miserable. A
PTY is a separate decision if it is ever actually needed.

**Windows shims, and why `shell: true` was rejected.** npm-installed CLIs on
Windows are `.cmd` shims, and Node refuses to spawn `.cmd`/`.bat` without a shell
(the CVE-2024-27980 mitigation):

```
spawn("claude",     …, {shell:false})  → ENOENT
spawn("claude.cmd", …, {shell:false})  → EINVAL
```

The easy fix would have been `shell: true`, which would hand back every
metacharacter and make the audit line a lie about what ran. Instead the resolver
reads the shim and extracts the real binary it calls — for Claude Code that is a
genuine `claude.exe`, verified spawning cleanly with `shell: false`. **If a
future session hits EINVAL here, the answer is not `shell: true`.**

## Consequences

**Good.** The owner can drive Claude Code from his phone, which is the whole
point of the Embedded Claude Workspace. Runs are attributable to a device.
Output is replayed from the server on reconnect, so a locked phone or a dropped
connection does not lose the log.

**Bad.** There is now a path from a phone to code execution on the owner's PC.
That is the feature, not a defect, but it means the phone's own lock screen is
part of the security model — **no auth scheme here protects a stolen unlocked
device.** It is why the terminal is off by default and why enabling it is a
deliberate act rather than a shipped default.

**Not addressed.** No per-command confirmation, and no working directory other
than the repo root. Both are easy to add if the owner wants them; neither is
pretended to exist.

## What would change this

- **A second person using Operator.** A device allowlist with no per-person
  revocation stops being adequate immediately.
- **Interactive tooling becoming necessary** — that is the PTY decision, and it
  brings a native dependency with it.
- **Evidence that the allowlist is being treated as containment** rather than a
  seatbelt. If that reading takes hold, either drop the allowlist entirely (so
  the boundary is unmistakable) or make it a real one with a wrapper that cannot
  shell out.

What would **not** change it: wanting to skip the device allowlist for
convenience. The point of naming devices is that a phone in a taxi is not the
same as a phone in your hand.
