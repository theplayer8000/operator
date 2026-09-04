# 0014 — Which Claude Code plugins Operator uses, and which it refuses

**Status:** Accepted
**Date:** 2026-08-22
**Relates to:** [ADR 0009](0009-permitted-abstraction-boundaries.md) (the
provider boundary these must not cross), [`threat-model.md`](../threat-model.md),
and `CLAUDE.md`'s external-application rule.

## Context

Five Claude Code plugins are installed —
`42crunch-api-security-testing`, `agent-sdk-dev`, `claude-md-management`,
`greptile`, and `frontend-design`. This records which are used, which are
refused, and why, so the question is not re-opened per session and a future
one does not adopt something on the grounds that it is already installed.

### The distinction that decides most of it

**A Claude Code plugin changes how the agent *building* Operator behaves. It
never becomes something Operator can do.**

This matters more than it first appears, because it interacts with the rule
that workers produce intents and the capability layer executes them. **A plugin
is on the wrong side of that boundary by construction** — it hands one specific
model a direct integration. Gemini cannot use a Claude Code plugin; neither can
a future GPT worker or a local Qwen. So anything Operator itself needs belongs
in `server/actions.mjs`, reachable by every worker, never in a plugin.

The test for each plugin is therefore *"does this help build Operator?"* and
never *"does this give Operator a feature?"*

## Decision

### Used

**`claude-md-management` — the audit only, never the auto-fix.**
`CLAUDE.md` is 54KB and is the entry point every agent reads. On 2026-08-21 a
hand audit of it found 23 stale line references, a feature table describing
shipped work as pending, and — in `roadmap.md` — the claim *"there is no
authentication; the tailnet is the boundary"*, which stopped being true at
[ADR 0010](0010-tailnet-identity-authentication.md) and is the sort of line
someone acts on. Automating that audit is worth having.

**It writes to `CLAUDE.md`, and that is where the caution is.** The file's
value is its hard-won specifics: the `git add -A` ban, the external-approval
rule, "never present it as plan usage". An automated tidy that generalises a
rule into ordinary advice costs more than the staleness it fixes. Read the
report; apply changes by hand.

**`security-review` (built-in).** Local, no account, no external service, reads
diffs. Given [`threat-model.md`](../threat-model.md) states outright that there
is no sandbox and the terminal runs as the owner, and that auth-adjacent code
has been moving quickly, this is the cheapest real safety net available.

**`agent-sdk-dev` — the verifier agents only.** `/new-sdk-app` scaffolds a new
project and is irrelevant to a working one. The verifiers check an SDK
application against official patterns, and `server/runner.mjs` was written by
hand against `sdk.d.ts`: three genuine deviations were already found by
accident (`thinkingConfig.thinkingBudget`, the three-argument `canUseTool`,
`allowDangerouslySkipPermissions`). Run as a review, not adopted as a
dependency.

**`frontend-design`** — already in use, unchanged by this ADR.

### Refused

**`greptile` — no.** Two independent reasons, either sufficient.

Operator has **no pull requests**: work goes worktree → `agent` branch → merge
→ push, and Greptile reviews PRs. There is nothing for it to review.

And it **indexes the repository on their servers** — the entire source of a
system holding the owner's calendar, gym history, missions and homelab shape,
sent to a third party, to support a workflow that does not exist here. Under
`CLAUDE.md`'s external-application rule that requires a named approval; it does
not earn one.

**`/review` (built-in)** — a GitHub PR reviewer, same absent workflow. Use
`/code-review` against the working diff instead.

**`run` (built-in)** — would fight the launch setup rather than help it.
Operator's arrangement (Task Scheduler, supervisor, three builds, a worktree)
is deliberate and documented across two ADRs; a generic "start the app" skill
knows none of it.

### Deferred, with the reasoning recorded

**`42crunch-api-security-testing` — not now, and the reason is about to
change.** Its flagship capability is BOLA/BFLA: broken *object-level*
authorization, where user A reads user B's records. Operator has one user and
no object-level scopes, so the headline feature has nothing to test. It also
needs an account, a downloaded binary, and an OpenAPI spec that does not exist
— and an OAS describing the whole API surface is itself an external disclosure.

Meanwhile the risks the threat model actually names — no sandbox, terminal runs
as the owner, tailnet as the boundary — are not findable by an OAS scanner.

**This verdict is conditional and the condition is now in sight.** See
[`control-plane-design.md`](../control-plane-design.md): a second person with
access makes object-level authorization real for the first time, and at that
point this moves from "unnecessary" to "the obvious tool". `generate-oas` also
becomes worth running then, because a second user means the API surface needs
documenting rather than remembering.

## What this suggests changing in Operator itself

Two ideas came out of the audit that are not about adopting anything.

**Verification should be a stage with a tool, not a field.** Every job records
`verification: { requested: true, status: "not-run" }` and it has never once
been anything else. 42Crunch's `audit → scan → remediate → validate` loop is a
reminder of the shape: the cheapest honest version here is that a job which
changed code is not "complete" until `npx tsc -b` and `npx vite build` have
run — already the rule in `CLAUDE.md`, currently enforced by convention rather
than by the job model.

**Structured output between stages, not prose.** Claude Code's own `Workflow`
tool passes schema-validated JSON between pipeline stages and defaults to
pipelining rather than barriers. `control-plane-design.md` §3 proposes
multi-worker jobs whose `handoff` currently carries prose and a status.
Schema-checking that is the difference between orchestration and hoping.

### Amended 2026-09-01 — Everything Claude Code (ECC), selectively

The owner asked for ECC (`github.com/affaan-m/ECC`, v2.2.1, MIT, 245K stars).
It is 286 skills, 68 agents and 94 commands across four harnesses. **Five
skills taken, project-scoped; the rest catalogued and not installed.** See
[`ecc-catalogue.md`](../ecc-catalogue.md).

**Taken:** `security-scan`, `security-review`, `react-patterns`,
`react-performance`, `frontend-a11y` — 84KB of markdown, no executables, copied
into `.claude/skills/` rather than run through their installer.

**Why not the full install, when the owner leaned that way.** Four reasons, and
the first is the one that is easy to miss:

1. **`~/.claude/` is shared with the Claude Code running INSIDE Operator.** A
   user-scope install changes the harness of the agent whose behaviour is
   currently the experiment — the intent layer went live the same day and its
   evidence comes from watching that agent work. An odd result would then have
   two candidate causes.
2. **286 skill descriptions sit in context every turn.** The listing is budgeted
   at about 1% of the window and truncates past it. `CLAUDE.md` is 54KB and its
   value is being read carefully; this competes directly.
3. **The Memory Vault is on the wrong side of the provider boundary** — the
   exact thing this ADR already forbids. It stores memories in `~/.ecc/memory/`,
   readable only by Claude Code, while `server/memory.mjs` already does it
   worker-agnostically in the store.
4. **The hook runtime is third-party Node scripts** on SessionStart, PostToolUse
   and Stop, in an environment [`threat-model.md`](../threat-model.md) states
   has no sandbox and runs as the owner. Refused; `--enable-hooks` is opt-in and
   was not passed.

**What was verified rather than assumed.** `mcp-configs/mcp-servers.json`
defines 35 servers, a dozen remote. `scripts/install-apply.js` contains **no MCP
handling at all** — installing contacts nothing and configures nothing. Each of
those 35 remains an external host needing its own named approval under
`CLAUDE.md`'s rule; being catalogued approves none of them.

**`security-scan` paid for itself in one run.** It found 76 accumulated allow
rules and no deny list in `.claude/settings.local.json` — the grant-per-command
pattern this project's own permission decision **rejected** for producing "69
single-use rules that never expire". It had silently returned. Now 9 allow / 17
deny, mirroring `server/jobs.mjs`'s `DENIED_TOOLS` so both agents refuse the
same things. Grade B (81) → A (96).

**Its blind spot, recorded so it is not mistaken for coverage.** It scans
`.claude/` — Claude Code's config — and never reads Operator's own
`ALLOWED_TOOLS`. It would not have caught the mangled-newline rules found in
`server/jobs.mjs` the same day.

### Amended 2026-09-04 — `~/.claude/settings.json` is Operator RUNTIME config

The connection this ADR did not make, and the one a future session would lose.

Everything above is written as though a plugin only affects the agent *building*
Operator. **It also affects the agent running INSIDE it.** `server/runner.mjs`
starts each job through the Agent SDK, and the SDK loads all three filesystem
setting sources unless told otherwise — which it was not, until 2026-09-04.
A probe of a session started exactly the way `runner.mjs` starts one reported
**60 visible commands**: the five project skills plus the command set of every
plugin enabled at user scope.

So `~/.claude/settings.json` is not only the desk machine's preferences. It is
an input to Operator's runtime, and three of its keys are security-relevant:

- **`enabledPlugins`.** This is how the refusal above stopped holding.
  `greptile` was found ENABLED on 2026-09-04 — refused here for indexing the
  whole repository on `api.greptile.com`, and its plugin payload is an HTTP MCP
  server pointed at exactly that host. No `GREPTILE_API_KEY` was set, so nothing
  had left the machine, and it is now `false`. But the refusal recorded in this
  ADR was being enforced by one word in a file outside this repository, which
  nothing checks and no reviewer sees.
- **`permissions.deny` and `hooks`.** A settings source supplies a whole
  `Settings` object. A deny rule short-circuits `canUseTool` before it is
  consulted, and a `PreToolUse` hook is a shell command that can deny a call
  the callback would have allowed. Neither is visible from `server/`.
- **`permissions.defaultMode`.** It carries `"auto"` today, which the SDK
  treats as an escalating mode and trust-filters only when it comes from the
  `project` tier — the `user` tier is unfiltered.

**Measured, so this is not left as a worry.** The explicit `permissionMode:
"default"` that `runner.mjs` passes DOES outrank the inherited `auto`: a
`Write` with `allowedTools: []` reached `canUseTool` and was refused, and the
file was never created. [ADR 0012](0012-claude-agent-sdk.md)'s option C holds.
The first probe used `Bash(hostname)` and saw no prompt, which looked like a
bypass and was not — the SDK auto-approves trivially safe calls whatever the
mode. **A read-only command proves nothing about permissions; probe with a
write.**

**The inheritance is kept deliberately.** The owner asked for it — he wants new
skills and scheduled work to reach the in-app worker without a code change —
and `project` cannot be dropped in any case, because that source is the only
reason `CLAUDE.md` is read at all. Dropping it to "tighten things up" would
remove the file every agent is instructed to read first, and the turn would
look entirely normal while doing it.

**What follows from it.** Enabling a plugin at the desk enables it inside
Operator, silently, with no Operator-side decision recorded anywhere. That is
now the rule to remember rather than a fact to rediscover: *a plugin decision is
an Operator decision.* The refusals in this ADR are only as real as
`enabledPlugins`, and that file is worth reading before wondering why a worker
did something surprising.

**One more copy than anyone expects.** `.claude/settings.local.json` resolves
against the session's `cwd`. Jobs run in the agent worktree, so the file the
in-app worker reads is a *different, gitignored* file from the one a desk
session edits. On 2026-09-04 main's copy held 9 allow / 17 deny while the
worktree's held 9 allow and **no deny block at all** — the `security-scan`
cleanup recorded above had landed on one copy of two. `deniedTools` is passed
programmatically by `jobs.mjs`, so the standing denials never depended on it;
what had drifted was unreviewed *widening*, not a missing floor. Mirrored.

## Consequences

**Good.** Three tools adopted at zero dependency cost — all read-only or
report-first, none reachable from Operator's runtime, none touching the
provider boundary. The refusals are recorded with reasons, so "it's already
installed" cannot become an argument later.

**The cost.** `claude-md-management` needs discipline: its value is the report,
and the temptation is to accept the diff. A rule softened by an automated pass
would be found much later than a stale line number.

**Unresolved.** Nothing here helps see the app on a phone, which is where the
last several UI defects were found and where no installed tool reaches.
`claude-in-chrome` could, and is deliberately left for a separate decision
because it drives the owner's real browser session.

## What would change this

**A second person with access** — already coming. It makes 42Crunch's
object-level testing meaningful and turns an OpenAPI spec from documentation
into a contract. Revisit both then.

**Adopting pull requests.** If review ever moves to PRs rather than a worktree
merge, `greptile`'s workflow objection disappears — though the
whole-repository-indexing objection does not, and that one is the stronger of
the two.

**Any plugin that claims to give Operator a capability.** That is the signal
something has been misread: capabilities belong in `server/actions.mjs` where
every worker can reach them. A plugin that appears to offer one is offering it
to Claude Code alone.
