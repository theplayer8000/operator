# The dashboard as a graph — design

**Status:** proposed, nothing built. Records the owner's brief of 2026-08-30
and the decisions it forces.
**Relates to:** [`design-system.md`](design-system.md) (the register this
changes), [ADR 0008](decisions/0008-dashboard-reads-the-real-board.md) (the
Dashboard already reads the real board),
[`control-plane-design.md`](control-plane-design.md) (what the live half needs),
[`presence-layer-design.md`](presence-layer-design.md).

## The brief

His words: the Dashboard stays as it is, and scrolling a page up or down loads
a **node graph**; missions move onto that graph; clicking one expands it into
its own card. Plus: make it lively, because a static dashboard is not what
Operator is meant to feel like.

## The insight that makes this worth building

**Mission Board already holds a graph nobody can see as one.**

`MissionRecord.dependsOn` is an array of mission ids — directional edges, and
they have been there since the board was built. `DependencyChain.tsx` renders
them as a predecessor → current → successor pill chain, which shows *one
mission's* neighbours and can never show the shape of the whole thing.

So this is not a decorative reskin of a list. It is the first view of data the
app has always had and has never displayed. That is the difference between a
graph that looks impressive in a screenshot and one that tells the owner
something — "everything is blocked behind that one mission" is a sentence the
current board cannot say.

## The problem in the brief, and how to resolve it

The brief mixes **two different graphs**:

| Graph | Nodes | What an edge means |
|---|---|---|
| Missions | missions | "this cannot start until that finishes" |
| Live work | jobs, workers | "this worker is running that task" |

Drawing both with the same visual language would say those edges mean the same
thing, and they do not. One is a plan; the other is what is happening now.

**Resolution: one canvas, two layers.** Missions are the persistent structure —
the map. Live jobs *attach* to the mission they are advancing and glow there,
then detach when they finish. A job with no mission floats at the edge.

That gives one screen that answers both "what is the shape of my work" and
"what is happening right now", without pretending they are the same relation.
It is also the version that degrades well: with no jobs running it is still a
useful mission map, rather than an empty canvas waiting for something to
happen.

## Decisions this forces

### 1. Mission Board's register changes, deliberately

[`design-system.md`](design-system.md) currently records that Mission Board was
**"explicitly asked to avoid game UI. No shields, no confetti, no XP language…
this page should read like Linear/Notion, not a game HUD."**

The brief reverses part of that. That is the owner's call to make and he has
made it — but it must be **recorded as a reversal, not left as drift**, or the
next session reads the old rule and quietly undoes the work.

The narrow version, which is what should be written down: the **graph view** is
lively — motion, glow, live state. The **mission card** stays calm. Opening a
mission from the graph should still read like Linear, because that is where the
actual work is read and edited, and a HUD is a bad place to read a paragraph.

So: a new register for the graph, not a rewrite of the board's.

### 2. DECIDED — the graph is big-screen only, and does not exist on a phone

The owner's decision, 2026-08-30, and it is the one that makes the rest simple:
**the graph is for the desk, and eventually for a TV or projector in the room.
It is not built for a phone at all.**

Not a degraded version. Not pan-and-zoom on 390px. Below the breakpoint the
graph pane **is not offered and not mounted**, and the Dashboard is exactly
what it is today. A graph you cannot read is worse than a list you can, and
Mission Board already is that list.

Three things fall out of it, and all three are simplifications:

- **No pan/zoom, no touch gestures, no small-screen layout.** The hardest part
  of the build disappears.
- **`CLAUDE.md`'s responsive rules stop being in tension with it.** Those rules
  exist so every surface works on a phone; the resolution is that this surface
  is not a phone surface, rather than a phone surface that works badly.
- **The scroll-snap risk goes away.** Since the second pane only exists on a
  large screen, the phone Dashboard keeps exactly the scrolling it has now, and
  cannot collide with the sidebar swipe — a gesture that has already had one
  fight with iOS's back-navigation band and took two reported symptoms to find.

**Don't mount rather than hide with CSS.** A canvas or SVG graph that is
`display: none` still costs memory, still runs its animation frames, and still
drains a phone battery for something nobody can see.

### 2b. The wall display — named now, built later

His stated direction: a TV or projector in the room showing it. That is a
**different surface to the desk view**, not the same one bigger, and naming it
now stops the desk view being built in a way that cannot become it:

- **Read from across a room**, so type scales up and detail drops out. The
  desk view can afford labels the wall view cannot.
- **Nobody interacts with it.** No hover states, no click targets, no controls
  — anything essential must be legible without them.
- **It is on all the time**, so it has to survive being stared at: no burn-in
  risk from a static bright element, and motion that is ambient rather than
  attention-grabbing.

That is the presence layer made physical — Operator having a place in the room
rather than a tab. It belongs with
[`presence-layer-design.md`](presence-layer-design.md) when it is built, and
nothing about it needs deciding today beyond not painting the desk view into a
corner.

### 2c. Scroll-snap, never scroll hijacking

Where the second pane does exist, "scroll a page up or down" must be **CSS
scroll-snap on a real scroll container**, not JavaScript intercepting the wheel.

Native scroll keeps momentum, keeps accessibility, and costs no JavaScript.
Hijacked scrolling is the kind of thing that feels clever for a week. If snap
feels wrong, the fallback is a toggle at the top of the Dashboard, not a
bespoke wheel handler.

### 3. Writes still go through the owning hook

The Dashboard may **read** `useMissionBoard` — ADR 0008 settled that and it is
how the current mission widgets work. Expanding a mission in the graph and
editing it is a **write**, and `CLAUDE.md`'s rule is unambiguous: *"Writing
still goes through the owning feature's hook, always."*

So the graph calls `useMissionBoard`'s mutators. It does not touch
`missions.records` and it does not grow its own copy of a mission — that is
exactly the parallel-state mistake ADR 0008 exists to have already corrected
once.

### 4. It stays one route

`/` remains the Dashboard. The graph is a second pane within it, not a new
route and not a new feature namespace. It owns no storage: every node is
derived from `missions.records` and the live job list.

## The honest sequencing problem

**The live layer is sparse until the control plane exists.** Operator runs one
job at a time today, so "live work" is at most one glowing node. The graph
would look like a feature waiting for its data.

Two ways to sequence, and the second is better:

- Build the whole thing, and it under-delivers until concurrency arrives.
- **Build the mission graph first** — it has full data *today*, it shows
  something the app has never shown, and the live layer drops onto it later
  without rework.

That also means the control plane and this can proceed independently, which is
worth having given both are large.

## What to build, in order

1. **The mission graph.** Nodes from `missions.records`, edges from
   `dependsOn`, click to expand into the existing mission card. Full data
   today, no dependency on anything unbuilt.
2. **The liveliness pass** on the Orchestrator — movement and live state where
   there is already something to show. Independent of the graph.
3. **The live layer**, once multiple workers can run at once
   ([`control-plane-design.md`](control-plane-design.md) §3).

## Open

- **Layout algorithm.** Force-directed looks alive but moves things under the
  cursor and is hard to make stable; a layered DAG layout suits `dependsOn`
  (which is directional and should be acyclic) and is calmer to read. Leaning
  layered, with motion reserved for *state changes* rather than constant drift.
- **Cycles.** Nothing currently stops mission A depending on B depending on A.
  A list view survives that; a layered graph does not. Worth detecting before
  drawing, and worth surfacing as a real warning — a dependency cycle is a
  planning bug the owner would want told about.
- ~~**Phone.**~~ **DECIDED** — see 2 above. Big screens only; the phone
  Dashboard is unchanged and the graph is not mounted there.
- **Which breakpoint.** `lg` (1024px) is the obvious candidate and is probably
  right, but it should be checked against the actual desk monitor and against a
  half-width window, which is a real way this gets used. A graph that vanishes
  when a window is dragged narrower is worse than one with a slightly lower
  threshold.
