# Dev tooling for Operator — a request from the CRM side

**Written:** 2026-08-26
**By:** the session building Darams CRM, not an Operator session
**Status:** ideas, not a plan. Nothing here is agreed or started.

> Dropped here rather than into `CURRENT.md` because that file belongs to
> whichever session is actually working on Operator, and overwriting somebody
> else's live handoff is the thing `CLAUDE.md` warns about with `git add -A`.
> Fold what is worth keeping into a real plan; delete the rest.

## Status, annotated from the Operator side — 2026-08-26

**Item 1: BUILT** (`c5e9830`), but not as asked. PDFs and images needed nothing
— the Agent SDK's `Read` takes a `pages` range for PDFs and shows images
visually, and it is pre-allowed for every job. No `pypdfium2`, no Python. The
real gap was HTML and SVG, now `server/render.mjs` + `scripts/render.mjs` via
headless Edge, no dependency added. The model is also now *told* it can look at
its own output, which is the half that actually failed here.

**Item 3: ALREADY BUILT**, before this was written — `3f40249`, 2026-08-21,
"probe the service, not whoever holds the port". It was prompted by the same
green-tile-over-a-dead-CRM incident described below. Any tile with an http or
https protocol gets a real request and the status code decides; anything under
500 counts as up, so a 302 to a login page reads as healthy. Verified live on
2026-08-26: Darams CRM answered 302 in 185ms. The two signals still missing are
"is the process alive" and "when did it last restart" — which are also, by this
document's own account, the two that lied.

**Items 2, 4, 5: open.** Item 2 is the strongest of them and is genuinely
absent; it also carries a decision, since restarting another app is execution
and sits under ADR 0011 rather than being a free addition. Items 4 and 5 are
CRM-side scaffolding that Operator has no particular claim on.

## Why this exists

Darams CRM is the first app built *inside* Operator rather than being Operator.
Others are expected. This is a list of the things that cost real time in one
long CRM session, written down while the cost is still fresh — because the
pattern is the point, not the individual annoyances.

Each item below is followed by what it actually cost, not by an argument that
it would be nice.

---

## 1. Render a file and let the agent look at it

**The cost, measured.** A display board was generated from the client's own
artwork with a status flash covering the wrong corner. It was wrong in three
ways at once — the wrong angle, the wrong position, and painting over a white
window in the template. None of it was detectable from the code, and no test
would have caught any of it, because the output was a valid PDF every time.

Three round trips were spent sending sample PDFs to the owner and asking "does
this look right". The moment a renderer was installed the geometry was measured
off the artwork in one step, and two further bugs turned up within minutes —
including a board silently printing with **no description at all** because the
photograph was taking a fixed share of the page and pushing the text off the
bottom.

**What would have helped.** A capability that takes a path and returns the
thing as an image the agent can see: PDF page, SVG, HTML at a given viewport.
`pypdfium2` does PDFs with no system dependency and an Apache/BSD licence —
deliberately not PyMuPDF, which is AGPL and a genuine problem in commercial
work.

**Note the asymmetry.** The agent could already *send* a rendered file to the
owner. It could not look at one itself. That gap is the whole item.

## 2. Restart-and-wait as one thing

**The cost.** Hand-rolled roughly a dozen times in one session, always the same
five steps: stop the scheduled task, kill the orphaned process it leaves
behind, start it, poll a URL until it answers, tail the error log to see
whether it came up or died. Twice the app was left down for a few minutes
because a step was missed and nobody was watching.

**What would have helped.** One action — restart *this* app, wait for it to
answer, show me the last lines of its log if it does not. It is not Operator's
own restart (that already exists, `POST /api/restart`); it is the same shape
applied to a *child* app, which is what everything built inside Operator is
going to need.

## 3. "Is it actually up?"

**The cost.** This is the failure that started the CRM project. The Homelab
tile was green while the app was dead, because the probe was testing a port
that something else was holding open. Then it happened again from the other
direction: `Get-ScheduledTask` reported **Running** while nothing at all was
listening, and an earlier probe of the port returned nothing while the app was
in fact serving fine — the query needed elevation and failed silently.

**What would have helped.** One honest answer per app: is the process alive,
is the port bound, does an HTTP request come back, and when did it last
restart. All four, because in this session each of the first three lied at
least once. The HTTP check is the only one that never did.

## 4. Migration scaffolding

**The cost.** Five migrations were written in one session — v13 through v17.
Every one is the same file: back the database up, create or alter, add indexes,
commit, roll back and say so on failure, print what changed. Roughly forty
lines of identical structure each time, hand-copied, and one of them shipped
with a table-name parser that only worked because every statement happened to
be formatted the same way.

**What would have helped.** `new-migration <name>` producing the file with the
backup, the rollback and the reporting already right, leaving only the schema.

## 5. A test-suite runner that reports like one

**The cost.** Ten test files, each a standalone script printing its own
summary. Running them means a shell loop and reading ten separate tails; a file
that *crashes* rather than fails prints nothing recognisable and is easy to
miss entirely. That happened twice in one session — three suites were silently
erroring because four test files borrowed a live administrator account that
stopped existing when somebody was promoted.

**What would have helped.** One command, one table, and a non-zero exit when
anything fails *or* crashes. The CRM's suites are deliberately dependency-free
scripts rather than pytest, and that should stay — this is a runner over them,
not a rewrite of them.

---

## What this is not asking for

- **Not a framework.** Five small capabilities, each with one job.
- **Not a generic "app manager".** Every item above came from a specific
  half-hour that was lost; none is speculative.
- **Not anything that reaches an external host.** All five are local. That
  matters given the approval rule in `CLAUDE.md` — none of this needs one.

## The honest counter-argument

Four of the five are shell commands somebody could write in ten minutes each,
and Operator's terminal can already run them. The case for building them
properly is that they are wanted *per app* and there will be several apps —
and that a capability the agent can call is meaningfully different from a
command it has to remember to run, in exactly the way `server/actions.mjs`
already argues for capability actions over editing source.

Item 1 is the exception. It is not a shell command, it is a genuine gap: the
agent can hand a rendered file to a person and cannot look at one itself.

**If only one of these gets built, build that one.**
