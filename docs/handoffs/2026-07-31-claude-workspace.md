# v21–24 — The Claude workspace: chat, markdown, permissions, unrestricted terminal

**Date:** 2026-07-31
**Commits:** `afd389e` … `d29a391`
**Milestone:** M14
**Design doc:** [`docs/ai-workspace-design.md`](../ai-workspace-design.md) — **read
this before touching any of it.** It explains why the current shape has the limits
it does and what replaces it.

## Summary

The Embedded Claude Workspace, to the point where the owner can hold a real
conversation with Claude Code from his phone. Three of his six specified items
are done; the remaining three are one job, not three, and are specified in the
design doc.

| His spec | State |
|---|---|
| project-aware conversations | ✅ session id kept, `--resume` passed |
| embedded terminal | ✅ unrestricted, armed per device |
| markdown rendering | ✅ hand-rolled, no dependency |
| streaming responses | ❌ — needs the job model |
| file uploads | ❌ — needs the job model |
| image uploads | ❌ — needs the job model |

## What landed

| Commit | |
|---|---|
| `afd389e` | Chat that remembers across messages (`server/workspace.mjs`) |
| `91502f1` | Fixed triple-rendering; model picker; cost stopped reading as a bill |
| `323dee2` | Permission denials reported with the exact rule + one-tap grant |
| `3386f61` | Chat promoted to its own page `/chat`, armable from there |
| `9cfa681` | Markdown rendering (`components/ui/Markdown.tsx`) |
| `fab9555` | The design doc |
| `d29a391` | Terminal allowlist dropped |

## Findings that cost real time — do not re-derive

**Every `claude -p` is a fresh session, and `-c` does not fix it.** Verified:
`-p "remember 47"` → noted; `-p "what number?"` → "I don't know"; `-c -p` →
"Unknown." What works is `--output-format json` → keep `session_id` →
`--resume <id>`. That is the entire basis of the chat.

**StrictMode double-fires the mount effect.** Two polls read the same offset
before either advanced it, so each appended the whole transcript — and the
optimistic local copy added a third. Every message rendered 2–3 times. Fixed with
an in-flight guard, de-dup by id, and no optimistic copy. If messages ever
duplicate again, look here first.

**Windows `.cmd` shims come in two shapes.** `claude.cmd` names a real
`claude.exe`; `npm.cmd` names `node.exe` **and** `npm-cli.js`. Taking the exe
first ran `node run build` → `Cannot find module '…\run'`. In a script shim the
exe is the *interpreter*. npm also lists `npm-prefix.js` before `npm-cli.js`, so
"first .js" is wrong too.

**`shell: true` has been rejected four times** and is never the answer — not for
`EINVAL` on a `.cmd`, not for pipes. Pipes come from an explicit `bash -c "…"`,
which keeps the audit line honest about what ran.

**Spawned processes get no stdin** (`stdio: ["ignore","pipe","pipe"]`). With the
default pipe, anything reading stdin waits for the timeout.

**Streaming does not work on the owner's iPhone.** `response.body.getReader()`
delivered nothing while the run exited 0. Everything polls by offset now. Do not
"improve" this back to streaming without testing on the actual phone.

## The billing picture — corrected

An earlier claim in this session was wrong and is corrected here, because it
affects design decisions.

**What was said:** no `ANTHROPIC_API_KEY` is set, so the CLI runs on the
subscription and the reported cost is not a bill.

**What is actually true:** the first half holds — it is a **Pro** subscription
and on-plan usage is not billed per message. But the owner has **usage credits
switched on**, so once a plan limit is hit, overflow is charged against them.
As of this handoff: **£10.66 spent of a £40 monthly limit (27%), resets Aug 1,
balance £0, auto-reload off.**

So the cost figure is not decorative. Under plan limits it is plan usage; over
them it is money. That makes a usage counter worth building rather than a nicety.

**Current limits** (from the owner's app, 2026-07-31): 5-hour session 35% used;
weekly all-models 61%, resets Tue 2:59 PM. Limits are **temporarily boosted** —
Claude Code +50% through **19 Aug**, Cowork +100% through **5 Aug** — after which
they return to standard. Anything tuned to current headroom will be wrong in
three weeks.

**What a counter can and cannot do.** Each turn returns token counts and
`total_cost_usd`, so Operator can total *its own* consumption honestly. It cannot
read the plan percentages — there is no `claude usage` subcommand and `/usage` is
interactive-only. A number that looks like plan usage but only counts Operator is
worse than none, so label it "Operator has used X", never "you are at N%".

## Outstanding

1. **The remaining three spec items** — streaming, file uploads, image uploads.
   One job, not three: all need `--input-format stream-json`. Design doc, step 2.
2. **Four open questions for the owner**, still unanswered: job history
   persistence, which permission profiles are wanted, one job at a time or
   several, and whether jobs need a usage ceiling.
3. **Usage counter** — worth building now the credits picture is clear. Honest
   framing only.
4. **SSH to EPYC.** Commands work (`ssh` resolves to Git-for-Windows'
   `ssh.exe`). Key handling recommendation: a dedicated Ed25519 key with **no
   passphrase** — one you cannot type from a phone means an agent holds it
   unlocked anyway — locked down on the far side instead via
   `from="100.x.x.x"` in `authorized_keys`, plus `command=` if the use is
   narrow. The key never goes in `operator.json`.
5. **Wake-on-LAN — deferred by the owner, and the constraint is understood.** A
   magic packet is a LAN broadcast and will not route over Tailscale, so
   something on EPYC's network must send it. The owner intends a relay (a cloud
   box, his gaming PC, or a mini server on that network) and does not have one
   yet. Revisit when the hardware exists; `node:dgram` covers it with no
   dependency.
6. **Two renames still awaiting confirmation** since before this session:
   "Today's Focus" → "Primary Objective", "Current Missions" → "Active
   Missions". Single-string changes; do not do them unprompted.

## Recommended next milestone

**Step 1 of the design doc — the job model, still using `claude -p` underneath.**
It removes the 10-minute cap and gives live visibility without changing the
process model, so it is low-risk and immediately better. Step 2 (`stream-json`)
then closes the remaining three spec items and real in-turn permissions together.

Do **not** start by rewriting `workspace.mjs` in place. It is a good one-shot
implementation and the wrong shape; expect to replace it.

## Verification

- [x] `npx tsc -b` and `npx vite build` clean at every commit
- [x] Conversation memory across turns, verified through the API (told it 47,
      asked next turn, got 47)
- [x] Exactly two messages per exchange after the duplication fix
- [x] Permission loop end to end: `git push --dry-run` blocked with rule
      `Bash(git push --dry-run)`, granted, re-asked, ran, zero denials
- [x] Markdown verified against a real reply with heading, bold, inline code,
      bullets and a js fence
- [x] Terminal unrestricted: `curl`, `where`, `ssh -V`, `powershell` all exit 0,
      all previously refused
- [x] `npm run build` runs through the terminal and exits 0
- [x] Real use from the owner's iPhone throughout
- [ ] Nothing tested from outside the home network
- [ ] Terminal left **disarmed**
