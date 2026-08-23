# CURRENT — work in progress

**Updated:** 2026-08-23
**`main`:** `aeab688`, clean and pushed. Nothing uncommitted.
**Workers:** all asleep — no job running, terminal disarmed.
**Rule:** see *"Every piece of work keeps a live handoff"* in `CLAUDE.md`.

> Nothing is in flight. The work of 20–22 August is folded into
> [`2026-08-22-gemini-routing-and-capability-writes.md`](2026-08-22-gemini-routing-and-capability-writes.md)
> — read that for what shipped, and for the silent defects worth not
> rediscovering. The gym-programme rebuild and the `job_events` gap that the
> previous version of this file described are both in there; the gap is now
> built.

## The one thing outstanding

**A restart is pending.** `server/` changed after the last one, for three
things: workers no longer inherit Operator's API keys (`aeab688`), the
`job_events` / `jobs_list` actions (`38e7646`), and the terminal explaining cmd
builtins rather than suggesting an environment variable that could never work
(`3a71125`). The frontend half is already built into `dist/`, so a reload
covers anything visual.

Restarting properly needs both steps. Ending the task alone leaves the old
process holding the port, and the relaunch then fails to bind while everything
looks restarted — `LastTaskResult` of `1` is the tell:

```powershell
schtasks /end /tn OperatorServe
Get-NetTCPConnection -LocalPort 5174 -State Listen |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
schtasks /run /tn OperatorServe
```

The terminal comes back **disarmed** on every start, by design (ADR 0011).

## Small, and the owner's to do

`.job4.json` is dead weight in the agent worktree. Deleting is denied to every
Claude session by the standing profile, so:

```
cmd /c del "D:\Projects\Operator-agent\.job4.json"
```

That form works from Operator's own terminal as of `3a71125` — `del` is a cmd
builtin rather than a program, and the old error suggested setting
`OPERATOR_TERMINAL_BIN_DEL`, which could never have worked.

## What is next, and it is a choice

Not started, and worth deciding rather than drifting into:

- **The control plane** — [`control-plane-design.md`](../control-plane-design.md),
  designed and approved. Local routing first, then the gateway seam. Needs
  Ollama, so it needs a homelab box.
- **The Knowledge Vault** — several queued items are quietly waiting on it: the
  routine restructure, streaks, and the owner's own organisation. He has said
  the vault is where that gets sorted, and that he has no patience for sorting
  it by hand first.

Both are large. Neither should start without the other being consciously
deferred.
