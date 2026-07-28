# 0001 — Local-first storage, no backend

**Status:** Superseded by [0006](0006-json-file-storage-server.md) (2026-07-28)
**Date:** 2026-07-26

> **Superseded.** The trigger named in *What would change this* below — genuine
> multi-device use — arrived, and the resolution was the one predicted: a
> self-hosted store on the owner's own hardware, not a SaaS backend. The
> self-hosting principle survives intact; only the mechanism changed, from
> `localStorage` to a JSON file behind a local Node process. Kept unedited as
> the record of why `localStorage` was right for v1–v4.

## Context

Operator is one person's daily operating system. It holds work notes, health and
training data, financial study, career plans, and a long-term life roadmap —
about as personal as a dataset gets. It runs on machines the owner controls, and
is reached over a private Tailscale network rather than the public internet.

A backend would bring accounts, a database, hosting, a deployment story, and a
sync protocol. Every one of those is a place personal data can leak, and a
running cost for a single-user app.

## Decision

`localStorage` is the entire persistence layer. **No backend, no authentication,
no database, no cloud sync, and no network calls** other than the Google Fonts
link in `index.html`.

All keys are namespaced `os.*` through `lib/storage.ts` so the whole dataset can
be exported, imported, or reset as one unit without knowing which features
exist.

If a future request appears to need any of the above, **raise it rather than
adding it silently** (`CLAUDE.md:14-17`). Offline-first is a requirement, not a
default that can be traded away for convenience.

## Consequences

**Makes easy:** zero infrastructure, zero cost, instant reads and writes, no
auth code, no privacy surface, works on a plane.

**Makes hard:**

- **Data lives in one browser profile.** Clearing site data wipes it. There is
  no backup path until Settings is built — currently the single largest product
  risk.
- **No multi-device.** The app is per-browser by construction.
- **No binary storage.** Attachments cannot be held at any real size, which is
  why Mission Board's Files section is a reserved placeholder
  (`CLAUDE.md:181-185`).
- **Storage quota is finite and writes fail silently** (**OPS-006**).
- **Schema changes have no migration path** because the data is already sitting
  in users' browsers with no server to migrate it (**OPS-003**).
- **Secure-context APIs are unavailable** over a bare Tailscale IP, which is the
  direct cause of **OPS-001**.

## What would change this

Genuine multi-device use, or a dataset that outgrows localStorage quota. Neither
is true today. Note that even then the first move is probably file-based
export/import or a self-hosted sync target on the owner's own homelab — not a
SaaS backend, which would contradict the reason this decision exists.
