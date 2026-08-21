# AGENTS.md — read [`CLAUDE.md`](CLAUDE.md)

**This file is a pointer, deliberately. Do not expand it into a copy.**

Operator's rules, architecture, conventions and open decisions live in one
place: **[`CLAUDE.md`](CLAUDE.md)**. Everything in it applies to you regardless
of which model or CLI you are — the file is named for the tool that happened to
arrive first, not for who the rules are for.

Start there. Then [`docs/README.md`](docs/README.md) for the long-form
reasoning behind them.

## Why this file exists at all

OpenAI's Codex looks for `AGENTS.md` the way Claude Code looks for `CLAUDE.md`.
Without one, a Codex session starts with no instructions and either works blind
or invents its own briefing.

## Why it is a pointer rather than a copy

It has twice been generated as a find-and-replace duplicate of `CLAUDE.md` with
"Claude" swapped for "Codex" throughout. That substitution does not know the
difference between a product name and a string, so it produced, among other
things:

- `status.Codex.com` — a host that does not exist, in a table of **approved
  outbound hosts**, where a wrong entry is a security-relevant error
- `docs/decisions/0012-Codex-agent-sdk.md` — an ADR filename that has never
  existed, cited as authority
- "Anthropic (Codex worker)" — describing the Claude worker, wrongly

The second copy was 53 KB and **97% line-identical** to `CLAUDE.md` once the
substitution was reversed. It was not adding anything; it was adding a second
version that would drift and a handful of fabricated facts an agent could act
on.

**A pointer cannot drift.** One file is edited, every agent reads the same
thing, and no substitution has an opportunity to invent a hostname.

## If you are an agent about to "improve" this file

You have been asked to make a briefing for your own tool, found `CLAUDE.md`,
and are about to adapt it. Don't. Adapting it is how the fabricated entries
above were produced, twice.

If something in `CLAUDE.md` is genuinely wrong for a non-Claude tool, fix it
**in `CLAUDE.md`** — the rules are about this project, not about which model is
reading them. If a rule genuinely needs to differ by tool, add a named section
there saying so.
