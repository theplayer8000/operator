# 0012 — Adopt the Claude Agent SDK, and take the first dependency in `server/`

**Status:** Accepted
**Date:** 2026-08-03
**Amends:** the stack rule in `CLAUDE.md` — "React 18 + TypeScript + Vite +
Tailwind + React Router + Recharts + lucide-react. Nothing else."
**Depends on:** [ADR 0009](0009-permitted-abstraction-boundaries.md) (the
provider boundary), [ADR 0011](0011-remote-terminal-for-authorised-devices.md)
(the gate this inherits).
**Relates to:** [`docs/ai-workspace-design.md`](../ai-workspace-design.md),
[`docs/threat-model.md`](../threat-model.md).

## Context

`server/jobs.mjs` drives Claude by spawning the `claude` CLI and parsing its
NDJSON stdout. That works — design-doc step 1 is merged and in daily use — but
it cannot do the one thing that matters most, and the reason is structural.

**A denial ends the turn.** Print mode has no channel to ask a question on, so
when Claude wants a tool it is not allowed to use, the turn stops. The owner
taps Allow, and asks again from the beginning.

This is not a papercut. On 2026-08-02 he asked Claude to close Snapchat. It made
**six** attempts — `Get-Process`, `tasklist`, `Stop-Process` twice, `taskkill`
via two shells — every one refused, and reported honestly that it had achieved
nothing. An ordinary request, impossible to complete, for want of a way to say
yes mid-turn.

The design doc claimed step 2 (`--input-format stream-json`) would fix this.
**It does not.** Probed with `--permission-mode manual`: Claude requested the
tool, emitted "The command requires your approval to run", and the turn ended
with `result/success`. The full set of stdout event types was `system/init`,
`rate_limit_event`, `assistant`, `user`, `system/post_turn_summary`, `result` —
no control request, no request id, nothing to reply to. This CLI has no
`--permission-prompt-tool` either. The doc has been corrected (`af62fad`).

The `canUseTool` callback that answers permissions in-turn exists only in the
**Claude Agent SDK**. Reaching it means a dependency, which the stack rule
forbids — hence this ADR rather than a quiet `npm install`.

## Decision

Adopt `@anthropic-ai/claude-agent-sdk` as the job runner's provider
implementation, pinned to an exact version. The stack rule is amended: it now
governs the **frontend**, and `server/` may take dependencies only through an
ADR naming the specific package and what it buys.

## What was measured, not assumed

Both of the questions that could have killed this were tested before deciding.

**It runs on the Pro subscription.** With `ANTHROPIC_API_KEY`,
`ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` all unset, a trivial query
returned text and a `total_cost_usd` — it reused the `~/.claude` login. So jobs
keep costing plan usage rather than becoming metered spend against the credit
balance. Had this failed the recommendation would have flipped to "keep the
CLI", because silently moving from plan usage to money is the kind of regression
that is invisible until the bill.

**The dependency is not small.** `npm view` reports zero declared dependencies,
which is misleading: npm auto-installs the peer deps, and those bring trees.
Actually installed:

```
93 packages · 291 MB
express · hono · body-parser · cors · cookie · express-rate-limit
@babel · @stablelib · jose · pkce-challenge · standardwebhooks
@modelcontextprotocol · eventsource · zod · ajv · cross-spawn
```

Two complete HTTP server frameworks, OAuth PKCE, JWT and webhook verification.
That machinery is there for MCP transports and provider OAuth, not for Operator
— but it is present, and **a package set that can listen on a port belongs in
the threat model**, where the dev server already sits as "a separate door".

*This ADR originally stated the SDK had zero transitive dependencies, on the
strength of `npm view`. That was wrong, and it was wrong in the direction that
made adoption look cheaper. `npm view` shows what a package declares; only
installing shows what lands on disk.*

## Consequences

**What is gained.** In-turn permissions — the Snapchat failure becomes one tap
instead of six refusals. And a category of bug disappears with the spawn: no
`.cmd` shim resolution, no `shell: false` argv quoting, no ANSI stripping, no
UTF-16 decoding, no NDJSON line-buffering. Every one of those was a real defect
fixed this week, and every one exists only because we parse another program's
stdout.

**What is lost.** `server/` stops being readable end to end. That property was
worth something: eleven Node built-ins and nothing else, auditable in an
afternoon. It is now bounded rather than absent — `auth.mjs`, the storage layer,
backups and the terminal stay pure Node, so *what runs when Operator serves
data* is still readable. Only *what runs when a job talks to Claude* becomes
trust.

**Version churn is real.** 0.3.220 is pre-1.0 and iterating fast. Pinned
exactly, never `^`, and upgrades are deliberate.

**The security checks must be re-run on upgrade.** The deny-list finding
(threat model §3) already requires this; the SDK adds "does it open a port".

## Alternatives rejected

**Keep the CLI, accept the dead end.** Honest, and what was in place — but it
means ordinary requests cannot be completed, which is not a workspace.

**Widen the permission blacklist instead.** Tried and measured: `git push` was
refused, `git -C <path> push` ran with zero denials, and a file was deleted via
`node -e` with zero denials. The model was not evading — it reached for node
because that is a normal way to delete a file. A blacklist of spellings is not a
boundary, which is the same lesson that retired the executable allowlist.

**Wait for the CLI to grow a permission hook.** Unbounded, and the need is now.

## How this is done

In the `agent` worktree, on its own branch, served at `:9443` — so `main` never
carries a half-migrated runner. That constraint is not theoretical: the job model
reached `main` twice in an incomplete state, once from each direction, and both
times the app could not restart.

Per ADR 0009 this is one implementation of the provider boundary, not a second
speculative one. `jobs.mjs` keeps its event vocabulary; what changes is what
produces the events.
