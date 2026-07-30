# 0010 — The API authenticates: Tailscale identity, with a token fallback

**Status:** Accepted
**Date:** 2026-07-30
**Corrects:** [OPS-018](../known-issues.md#ops-018), whose accepted-risk rationale
was based on a premise that was not true.
**Precondition for:** the embedded terminal restriction in
[ADR 0009](0009-permitted-abstraction-boundaries.md).

## Context

Until now the storage API had no authentication of any kind. **OPS-018** accepted
that for the Dev file browser on the stated grounds that *"the tailnet is the
security boundary"*.

That premise was false, and measurably so. The server binds `0.0.0.0`, Windows
Firewall carries an inbound Allow rule for Node on the **Private** profile, and
from the machine itself:

```
$ curl -s -o /dev/null -w '%{http_code}' http://192.168.1.100:5174/api/health
200
```

The tailnet was never the boundary — every interface was. On any network Windows
classifies as Private, anything on that LAN could read the whole store (shifts,
notes, missions) and browse the repo through `/api/dev/*`. Public-profile
networks block inbound by default, so the exposure was not universal; it was one
"trust this network" tap away from applying anywhere.

Two things then made it urgent rather than theoretical:

1. **The owner moved to phone-only access.** He is travelling and will not be at
   the machine "for a while", so the tailnet is no longer a convenience — it is
   the only path in, from arbitrary networks.
2. **An embedded terminal is planned** (ADR 0009). Raising the blast radius from
   *read my data* to *run code on my PC* is not something to layer onto an
   unauthenticated API.

## Decision

**Everything under `/api/` requires an identified caller.** Three ways to be
one, checked in order:

| # | Method | How |
|---|---|---|
| 1 | `local` | The request came from this machine and not through a proxy |
| 2 | `tailscale` | The caller is a device on the owner's tailnet, confirmed by asking the **local** `tailscale` daemon who owns that address |
| 3 | `token` | A bearer token matching `OPERATOR_TOKEN` |

Anything else gets a 401 and a logged warning. There is deliberately **no
"allow any source" flag** — a caller from outside the tailnet is welcome, but it
has to bring the token.

**Static assets are not gated.** The browser has to load the app before it can
present a token, and the bundle carries no data.

### Why Tailscale identity, and why it isn't an external dependency

`tailscale whois --json <ip>` against the local daemon returns the device and the
owning user:

```
Machine:  tosins-iphone
User:     theplayer8000@github
```

This is a **local** call — no network egress — so it does not fall under the
external-applications rule in `CLAUDE.md`. Tailscale is already the transport;
this asks the component we already trust who it just authenticated.

It was chosen over a password because the primary client is a phone. Nothing to
type, nothing to store in a password manager, nothing to re-enter. It also gives
*authorisation* for free: the terminal can be restricted to named devices, and
every action can be attributed to one.

### Why a token as well

The owner intends to run Operator on a real domain (`operator.com` or similar).
At that point there is no tailnet, `whois` resolves nothing, and identity has to
come from something the client carries. Building the fallback now means that move
is configuration rather than a rewrite.

## Two traps this design exists around

Both were found by testing a running server, and both would have silently
defeated the whole thing.

**1. The Vite proxy launders the client address into loopback.**
In dev, the phone loads the app from Vite on `:5173`, and Vite proxies `/api` to
`http://localhost:5174`. The API therefore sees *the proxy*, not the phone — so a
plain "trust loopback" rule would authenticate anything that can reach the dev
server as if it were sat at the keyboard, LAN peers included.

Fixed by `xfwd: true` on the proxy (so the real address is forwarded) plus
splitting loopback in two: loopback **without** a forwarded address is this
machine; loopback **with** one is the proxy, and the forwarded address is judged
by the same rules as any peer. Forwarded addresses are trusted **only** from
loopback.

**2. `xfwd` appends, so the leftmost forwarded address is attacker-controlled.**

```
client sends:  X-Forwarded-For: 100.64.25.75          (a lie)
Vite appends:  X-Forwarded-For: 100.64.25.75, 192.168.1.100
                                ^ attacker's           ^ what Vite saw
```

Reading the leftmost entry authenticated a LAN peer as the owner's iPhone —
confirmed against a live server before the fix. The rule is therefore **read the
rightmost entry**: the one the trusted proxy observed.

**This assumes exactly one trusted hop.** Putting nginx or Caddy in front to
terminate TLS for a real domain makes the rightmost entry *that proxy's* view of
its upstream, and this needs revisiting with an explicit trusted-hop count.

## Consequences

**Good.** The tailnet is now genuinely the boundary, so OPS-018's rationale is
true for the first time. The phone and the desk both work with **no client
change at all** — Tailscale identity is resolved server-side — so the login UI is
only owed when the domain move happens. Actions become attributable to a device,
which is what makes a per-device terminal restriction possible.

**Bad.** Auth now depends on the `tailscale` binary being present and its daemon
answering. A broken install degrades to "token required" rather than locking the
owner out, but if no token is configured either, he is locked out of everything
except loopback. The mitigation is that loopback always works — he can always
reach it from the machine.

**No auth scheme fixes a stolen unlocked phone.** Whoever holds it has whatever
it has, under identity or token alike. That is phone-level security, and it is
the reason the terminal should stay behind an extra deliberate step rather than
being always-live.

## What would change this

- **A second proxy hop** (TLS termination for a real domain) — the
  rightmost-address rule stops being correct and needs a trusted-hop count.
- **More than one human** ever using Operator — a single shared token stops being
  adequate the moment it cannot be revoked per person, and Tailscale identity
  would become the only real mechanism.
- **Tailscale being dropped** as the transport — then the token is the whole
  scheme and TLS becomes mandatory, not optional.

What would **not** change it: finding the 401s inconvenient while developing.
Loopback is always trusted, which is the escape hatch.
