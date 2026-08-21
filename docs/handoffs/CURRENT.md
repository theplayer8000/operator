# CURRENT — work in progress

**Updated:** 2026-08-21
**`main`:** `e890324` plus **one uncommitted change**: `server/homelab.mjs`.
**Rule:** see *"Every piece of work keeps a live handoff"* in `CLAUDE.md`.

> The previous contents of this file described work that had shipped and been
> restarted live. It has been folded into
> [`2026-08-20-orchestrator-and-capability-reads.md`](2026-08-20-orchestrator-and-capability-reads.md)
> rather than deleted, per the rule in `CLAUDE.md`.

## What changed

**The Homelab probe now asks the service, not whoever holds the port.**

`server/homelab.mjs` did a TCP connect and nothing else. That reported the
Darams CRM tile as **online while the site had been down for days**: its tile
points at `tosin-pc.tail07eb22.ts.net:7443`, and port 7443 belongs to
`tailscaled`, which accepts the connection and proxies to a backend that had
exited. Every real request returned `502`; the probe saw a clean handshake and
drew a green dot. A tile that is green while the app is dead is worse than no
tile, because it gets consulted and believed.

Now: any service whose `protocol` is `http`/`https` gets a real GET on its
`path`, and the status code decides. Anything else — a database, a bare port —
still gets the TCP connect, which remains the honest test for something that
does not speak HTTP.

- **Up** is any status under 500. A `302` to a login page and a `401` both mean
  the app is there and answering; demanding `200` would report every
  authenticated service as down.
- **Down** is 5xx, or a connection / TLS / timeout failure. `502` — the exact
  case that started this — now reads red.
- `redirect: "manual"`, so a redirect counts as an answer rather than costing a
  second round trip. HTTP gets a 4s timeout against TCP's 1.5s.
- The result shape gains `status` (the HTTP code, or `null`). Additive; the
  frontend reads `online` and is unaffected.
- The cache key now includes protocol and path, so switching a tile from a TCP
  check to an HTTP one cannot keep serving the previous meaning of "online" for
  another five seconds.

## Verified

- `"C:\Program Files\nodejs\node.exe" --check server/homelab.mjs` — clean.
  (The `node` on PATH is the shadowed one that verifies nothing; see
  `CLAUDE.md`.)
- Live probe against the real tiles: CRM `302` → online, Operator API `200` →
  online, a dead port → offline.
- A throwaway server returning `502` → `{"online": false, "status": 502}`.
  That is the original bug reproduced and caught.

## Not done

- **Restart required and not yet performed** — `server/` is loaded into memory
  at boot, so the live tile is still doing the old TCP check until it is.
- Not committed. One file: `server/homelab.mjs`. Stage it by name.
- The frontend does not surface the new `status` field. It could — `502` under
  a red dot would say *why* — but that is a change to
  `src/components/homelab/ServiceTile.tsx` that nobody has asked for.

## Context, if this is picked up cold

This came out of a session working mainly in `D:/Projects/Operator/Darams-CRM`
— a separate application that Operator only links to. That CRM had been down
for days; the tile said otherwise. This is the Operator half of that fix. The
CRM half — a supervised service that restarts itself, and an hourly backup —
lives in that repository with its own handoff.
