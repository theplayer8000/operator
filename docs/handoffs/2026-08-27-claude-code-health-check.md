# Claude Code health check — findings

**Run:** 2026-08-27, `/doctor`.
**Scan window:** 50 most recent transcripts across all projects, 2026-07-31 →
2026-08-27 (27 days, 20,608 lines, 3,647 tool calls, 11 startups).
**Status:** report only. **Nothing was changed.** Confirm before applying.

## The one that matters

**`.claude/settings.local.json` has 76 entries in `permissions.allow`, and
several are standing grants of arbitrary code execution.**

`CLAUDE.md` already argues this is bad, in its own words:

> the exact-rule list had grown to 69 entries of single-use rules that never
> expire — which is worse security than a considered standing profile

That was the reasoning for adopting the standing profile for *jobs*. The
desk session's own list was never cleaned up, and it has since grown to 76.

The ones worth reading:

| Rule | Why it matters |
|---|---|
| `Bash(python -)` | reads a program from **stdin** and runs it — unrestricted execution |
| `Bash(node -e ' *)` | arbitrary Node, wildcarded |
| `Bash(npm run *)` | task-runner wildcard — runs whatever any script is later changed to do |
| `Bash(git reset *)` | destructive, wildcarded |
| `Bash(git push --dry-run)` | the job profile denies push outright; the desk grants it |
| `WebFetch`, `WebSearch` | bare, so network egress never asks |
| `Skill` | bare |
| `Bash(rm src/hooks/useLocalStorage.ts)` | a delete rule for a file that no longer exists |
| 4 × `Bash(python "C:/Users/tosin/.claude/jobs/261d8de3/tmp/*.py")` | point at temp job files that are gone |
| `Bash(echo "tsc exit: $?" also uhm when ur done intergration with a discord bot…)` | a prompt that got captured as a permission rule |

Most of the rest are one-off commands from single sessions weeks ago — exactly
the "single-use rules that never expire" the ADR describes.

**Recommendation:** prune to nothing, or near it, and let auto mode's classifier
handle the routine cases (see below). Pruning *narrows* permissions, so the
risk of getting it wrong is a prompt, not an incident.

## Plugin enabled against this project's own decision

**`greptile` is enabled** in `~/.claude/settings.json`, and
[ADR 0014](../decisions/0014-development-tooling.md) **refuses it by name**, for
a reason that is a hard rule here:

> it **indexes the repository on their servers** — the entire source of a system
> holding the owner's calendar, gym history, missions and homelab shape, sent to
> a third party … Under `CLAUDE.md`'s external-application rule that requires a
> named approval; it does not earn one.

Zero uses in the window, so nothing is relying on it. **Disable.**

`42crunch-api-security-testing` is also enabled and ADR 0014 defers it ("not
now"). Zero uses. Disable — the ADR says the condition that revives it is a
second user, which has not happened.

`claude-md-management` and `agent-sdk-dev` are recorded as *used* by ADR 0014
but have **zero invocations in 27 days**. Judgment call rather than a defect —
they cost little and the ADR wants them; left enabled unless the owner says
otherwise.

`frontend-design` — used once in the window. Keep.

## CLAUDE.md trips the large-memory warning

**55,681 chars ≈ 13.9k est. tokens, in context every single session**, against a
warning threshold of ~40,000 chars. Largest sections:

| Section | Lines | Est. tokens |
|---|---|---|
| Folder map | 138 | 2,357 |
| Feature status | 24 | 1,536 |
| Open decisions waiting on the owner | 75 | 1,114 |
| External applications need approval | 64 | 1,010 |
| Documentation | 26 | 822 |

**Deliberately not proposing cuts yet.** Most of this file is the categories a
health check is supposed to *keep* — gotchas, rationale, prohibitions,
non-standard conventions. The folder map looks like a directory listing but
carries the reasoning ("NOT a generic write gateway", "the ONLY file in
`server/` that imports an npm package"), which `ls` cannot reconstruct.

The honest lever is **lazy loading, not deletion**: sections like the three-build
setup, the restart procedure and the resume phrase are task-specific and could
become skills that load on demand, leaving only a one-line description resident.
Safety-critical rules (`git add -A`, the approval rule) must stay in the root
file regardless. Worth doing deliberately, not at 3am.

## Healthy — no action

- **Version** 2.1.247, and 2.1.247 is the latest on the `latest` channel. Up to
  date. Auto-updates are not disabled.
- **Install** is a single npm global at `AppData\Roaming\npm`, `which claude`
  agrees with `installMethod`, no native launcher and no `~/.claude/local`
  leftovers.
- **Settings files** all parse. No project `.claude/settings.json`, no
  `.mcp.json`.
- **No agent definitions** anywhere, so nothing colliding.
- **Hooks**: two PostToolUse entries, both 0ms. Nothing slow.
- **No configured MCP servers.** The 92 `Claude_Browser` calls in the window are
  the Chrome integration, which ADR 0014 left as a separate decision and which
  is evidently now in use — worth reconciling with that ADR.

## Nothing qualifies for pre-approval

96 denials in the window (76 `user-rejected`, 14 `permission-rule`, 5
`automode-blocked`, 1 `automode-unavailable`), and **none meet the read-only
bar**. The top patterns are `PowerShell` (20), `Write` (16), `cd … && claude -p`
(11), `git push` (4), `curl` (3), `node -e` (3) — every one is write-capable or
arbitrary execution. Three quarters were the owner personally declining.

That is the correct outcome, not a gap: the denial list says the permission
system is refusing the right things.

## Auto mode is not the default

`permissions.defaultMode` is unset in every scope, and nothing disables auto
mode. Setting `"permissions": {"defaultMode": "auto"}` in
`~/.claude/settings.json` would let a safety classifier approve routine actions
instead of prompting each time — and would make pruning the 76 rules
comfortable rather than annoying. Applies to every project; cannot lock you out
(it falls back to default mode with a notice if unavailable).

## Suggested order

1. Prune `permissions.allow`.
2. Turn on auto mode — 1 and 2 belong together.
3. Disable `greptile` and `42crunch` per ADR 0014.
4. CLAUDE.md lazy-loading, as a separate considered pass.
