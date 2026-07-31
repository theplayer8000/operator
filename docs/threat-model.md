# Threat model

**Status:** current as of 2026-07-31.
**Read with:** [ADR 0010](decisions/0010-tailnet-identity-authentication.md)
(who is calling) and [ADR 0011](decisions/0011-remote-terminal-for-authorised-devices.md)
(who may run things).

This exists because the owner asked the right question — "how would someone
break out of the sandbox?" — and the answer needed correcting rather than
answering.

## There is no sandbox

Operator's terminal and chat spawn processes as the owner's own Windows user.
No container, no separate account, no filesystem jail, no syscall filtering.
A command started from Operator can do anything the owner could do at the
keyboard: read any file on any drive, reach any host, install anything.

`shell: false` is not containment. It stops one input box from chaining
commands and keeps the audit line equal to what actually ran — worth having,
and routinely mistaken for a wall. It is not one.

The executable allowlist is not containment either, which is why it was
dropped: permitting `claude` permits arbitrary execution, because Claude Code
runs commands. A list that blocked `curl` while allowing `claude` was friction
wearing the costume of security.

**So there is nothing to escape from.** The security of this system is entirely
*who can reach it*. Everything below follows from that.

## What actually holds the line

| Layer | What it stops | What it doesn't |
|---|---|---|
| **Tailnet identity / token / loopback** (`server/auth.mjs`) | Anyone not on the tailnet reaching `/api/*` | Anyone who *is* on it, or holds the token |
| **`OPERATOR_TERMINAL_DEVICES`** | A known tailnet device getting a shell | The named devices themselves |
| **Armed state** | A forgotten session running commands later | Anything, once armed |
| **`shell: false`** | Metacharacter injection through one field | The command that was legitimately asked for |
| **`fs.deny` (Vite), DENY set (`server/dev.mjs`)** | Reading `data/`, `.env`, databases over the read-only paths | Anything the terminal can read, which is everything |

## Where the real risk sits

In rough order of how much it should worry someone.

### 1. `OPERATOR_TOKEN` is a password to everything

A bearer token with no expiry, no scope, and no revocation beyond changing it.
Whoever holds it gets the full store and the same rights as a named device from
anywhere the server is reachable. It is one string in an environment variable.

*If it leaks:* change it and restart. There is no session list to revoke and no
way to tell whether it was used, beyond the connected-clients panel while the
process has been up.

### 2. An unlocked authorised device is a shell

`tosins-iphone` is in `OPERATOR_TERMINAL_DEVICES`. Someone holding that phone,
unlocked, taps Arm and has command execution on the owner's PC.

This is the design working as specified — the device list *is* the boundary —
and it is why arming resets to off on every server start rather than persisting.
The phone's own lock screen is a real part of this system's security.

### 3. The permission allow list only ever grows

`.claude/settings.local.json` accumulates every rule ever granted, permanently.
It currently includes `Bash(python -)` — "run arbitrary Python from stdin" —
approved once for one task and standing ever since.

Nothing expires, nothing is scoped to a session, and the file is not reviewed on
any schedule. **Worth reading occasionally and pruning.** A rule granted in
March is still live in December.

### 4. Elevation multiplies everything above

If the server is started from an elevated shell, every command it runs inherits
administrator rights. Starting it from an ordinary terminal costs nothing and
removes a whole tier of possible damage. Check the window title.

### 5. The dev server is a separate door

Vite on 5173 does not share the API's authentication. It once served the entire
repository to anything on the LAN, including a different project's client
database — see **OPS-022**. It now has an `fs.deny` list and `allowedHosts`
scoped to the tailnet, but it remains a second listener with its own rules, and
it should not be running when nobody is developing.

`xfwd: true` on its `/api` proxy is load-bearing for the same reason: without
it, every proxied request looks like loopback and is trusted. See ADR 0010.

## What real containment would look like

Not needed today, and stated so the option is understood rather than reinvented:

- **A dedicated low-privilege Windows account** for the server, with write
  access to `data/` and read access to the repo. Cheapest meaningful step.
- **A container** with only `data/` mounted writable. Turns "no sandbox" into a
  sandbox, and makes the EPYC move easier rather than harder.
- **Splitting the agent runner into its own container**, so a compromised
  agent session cannot reach the store directly — only through the same
  authenticated API as any other client.

Each is real work. None is justified while this is one person on a private
tailnet. All become justified the moment Operator is reachable from the public
internet, which is the change to watch for: **a domain pointing at this is not a
cosmetic change**, it removes the network boundary that everything above leans
on.

## The rule to keep

Do not relax authentication on the grounds that commands are restricted. They
are not restricted, they were never meaningfully restricted, and the day someone
convinces themselves otherwise is the day this stops being safe.
