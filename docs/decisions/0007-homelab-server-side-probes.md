# 0007 — Homelab status is probed server-side

**Status:** Accepted
**Date:** 2026-07-28

## Context

The Homelab page shows a tile per service running on the box, each with an
online/offline indicator. The obvious implementation is a `fetch` from the
browser to the service's URL. It does not work here, for two independent
reasons.

**The browser is usually not on the box.** Operator is used from a phone over
Tailscale (ADR 0006, and `vision.md`'s "no core workflow should require a
desktop"). A service is configured as `localhost:5000` because that is what it
is *from the machine running the storage server*. A client-side probe of
`localhost:5000` from the phone probes **the phone**, and reports every service
offline, forever. The failure is silent and looks like infrastructure trouble
rather than a bug.

**CORS blocks the answer anyway.** A cross-origin `fetch` to another port is a
different origin. The response is unreadable without the service opting in with
CORS headers — which would mean modifying every service Operator points at,
including ones we don't control. `mode: "no-cors"` returns an opaque response
that cannot distinguish "connection refused" from "200 OK".

## Decision

**The storage server performs the probe** and the client asks it for the
result: `GET /api/homelab/status`.

- **A TCP connect is the whole test** (`server/homelab.mjs`). It answers "is
  something listening on that port", which is the honest signal for a tile. It
  does not claim the app inside is healthy — the page says so in as many words.
- **The probe list comes from the store, never from the request.** The endpoint
  reads the `homelab.services` slice and probes exactly that. It deliberately
  accepts no host or port parameter, so it cannot be used as a general port
  scanner by anything that reaches the tailnet. A caller may ask "are my
  configured services up", not "is `<arbitrary host:port>` open".
- **Results are cached for 5s**, keyed on the exact set being probed, so tile
  polling and a manual refresh collapse — but editing a service re-probes
  immediately rather than serving the previous set's answer.
- **`localhost` is rewritten client-side.** `serviceUrl()` in `useHomelab.ts`
  swaps a stored `localhost`/`127.0.0.1` for `window.location.hostname`, so one
  stored config opens correctly from the desk *and* from the phone. A service
  on some other machine keeps its real host and is left alone.

## Consequences

**Good.** Status is correct from every device. No service needs CORS headers,
or any modification at all — Operator holds a pointer and nothing more. The
probe is fast (parallel, ~20ms when ports are closed, 1.5s ceiling).

**Costs and limits.**

- **Port-open is not health.** A hung process holding its port reads as online.
  Deliberate: the alternative is per-service health endpoints, which couples
  Operator to each service's internals — exactly what the CRM's own handoff
  asks us not to do.
- **The seed has to reach the server.** Feature seeds normally live only in the
  browser until first write, but the server probes *its* copy of the slice.
  `useHomelab` pushes the seed once, guarded on a successful online load, so a
  failed load can never overwrite real data with seed data. This is the only
  feature that needs `hasOnServer()` from `remoteStore.ts`.
- **The rewrite assumes services are co-located with the storage server.** True
  today and the reason the page exists. Anything elsewhere gets its real
  hostname stored, which works — it just won't follow you between networks.
- **Status is not persisted.** It is derived, like the Activity Log. Nothing
  about up/down goes in the store.

## What would change this

- **Services stop being co-located with the storage server.** If something runs
  on a different machine and is reached over the tailnet by hostname, the
  `localhost` rewrite stops being the right default and the config needs a real
  notion of "which host is this on".
- **"Is the port open" stops being enough.** The first time a service is up but
  broken and the tile says otherwise, this should become a per-service health
  check with an optional health path — a bigger feature than this one, and it
  should be built deliberately, not bolted on.
- **Operator is ever exposed beyond the tailnet.** The probe endpoint takes no
  parameters and so is not a scanner, but it does disclose which of the owner's
  services are up. That is only acceptable while ADR 0006's boundary holds.

## Alternatives rejected

**Client-side `fetch` per tile.** Wrong answer from the phone, blocked by CORS
from anywhere. This is the option that looks simplest and is simply broken.

**A `no-cors` probe with a timeout heuristic.** Guesses reachability from how
long an opaque response takes. Unreliable, and still wrong from the phone.

**HTTP `GET`/`HEAD` from the server instead of a TCP connect.** More
information, but needs a per-service health path, follows redirects, and
mistakes an app-level 500 for "down" or a login redirect for "up". TCP connect
answers one question honestly; anything richer is really per-service health
checking, and should be built as that if it's ever wanted.
