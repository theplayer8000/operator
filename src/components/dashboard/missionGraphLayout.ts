import type { ID, MissionRecord } from "@/lib/types";

/**
 * Turning `dependsOn` into something drawable.
 *
 * Kept out of the component and free of React on purpose: this is the part
 * with the edge cases, and it is far easier to reason about — and to test —
 * as a function from missions to coordinates than as something tangled in a
 * render. `scratchpad/test-layout.mjs` exercises the cases the live store has
 * no data for, and found a real cycle bug before this ever ran on real data.
 *
 * ## Why a settled force layout rather than a layered one
 *
 * The first version placed nodes in columns by dependency depth. Correct,
 * readable, and — the owner's verdict — not what he asked for: he wanted the
 * organic floating web.
 *
 * The objection to force-directed layouts is real but specific: they never
 * stop, so nodes drift under the pointer and a click lands on whatever moved
 * into place. That is a property of running the simulation forever, not of the
 * layout. So this one **runs to completion here and returns final
 * coordinates.** The component draws a still graph and animates only its own
 * decoration. Organic positions, nothing moving when you reach for it.
 *
 * Deterministic on purpose too — the seed is the mission id, so the same board
 * lays out the same way every render. A graph that reshuffles on each poll
 * would be unreadable.
 */

export interface GraphNode {
  mission: MissionRecord;
  /** Steps from a mission with no prerequisites. Still used for colour and rank. */
  layer: number;
  x: number;
  y: number;
  /** True when this mission sits in a dependency cycle. */
  inCycle: boolean;
  /** How many edges touch it — drives node size, so hubs read as hubs. */
  degree: number;
}

export interface GraphEdge {
  from: ID;
  to: ID;
  /** An edge that closes a loop. Drawn differently, because it is a mistake. */
  isCycle: boolean;
}

export interface GraphLayout {
  nodes: GraphNode[];
  edges: GraphEdge[];
  width: number;
  height: number;
  /** Missions in a dependency cycle. Empty is the normal case. */
  cycles: ID[];
  /** `dependsOn` entries pointing at a mission that no longer exists. */
  danglingEdges: { from: ID; missingId: ID }[];
}

export const NODE_R = 30;
/*
  Room for a node AND its label.

  The name is drawn below the circle rather than inside it — a 30px radius
  cannot hold "Knowledge Vault" at a readable size — so the margin has to clear
  the widest label, not just the widest node. At 70 the outermost names were
  cut off by the viewBox edge mid-word.
*/
const PAD = 96;
/** Enough iterations to settle a board of this size; cheap, runs once per change. */
const ITERATIONS = 320;

/**
 * Depth of each mission, and which ones are in a cycle.
 *
 * **Cycles are detected rather than assumed away.** Nothing in the app stops
 * mission A depending on B depending on A — the Mission Board is a list and
 * survives it happily — but the naive recursion would not return, and a cycle
 * is a real planning bug worth telling the owner about.
 */
function computeLayers(missions: MissionRecord[]) {
  const byId = new Map(missions.map((m) => [m.id, m]));
  const layer = new Map<ID, number>();
  const inCycle = new Set<ID>();
  /*
    The DFS path as an ORDERED list, not a set.

    A set is enough to *detect* a cycle and not enough to describe one. The
    first version marked only the node the search arrived back at, so a loop of
    three reported one member: the warning undercounted, and because an edge is
    only drawn as a cycle when BOTH ends are marked, the dashed edges meant to
    show the loop never appeared. Found by test, not by use — there was one
    mission and no dependency in the store at the time.
  */
  const path: ID[] = [];
  const onPath = new Set<ID>();
  const resolved = new Set<ID>();

  const visit = (id: ID): number => {
    if (resolved.has(id)) return layer.get(id) ?? 0;
    if (onPath.has(id)) {
      for (const member of path.slice(path.indexOf(id))) inCycle.add(member);
      return 0;
    }
    const mission = byId.get(id);
    if (!mission) return 0;

    onPath.add(id);
    path.push(id);
    let deepest = -1;
    for (const dep of mission.dependsOn ?? []) {
      if (!byId.has(dep)) continue;
      deepest = Math.max(deepest, visit(dep));
    }
    path.pop();
    onPath.delete(id);

    const value = deepest + 1;
    layer.set(id, value);
    resolved.add(id);
    return value;
  };

  for (const m of missions) visit(m.id);
  return { layer, inCycle };
}

/** A stable pseudo-random from a string, so the same board always lays out the same. */
function seededUnit(seed: string, salt: number): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

/**
 * @param missions the missions to draw — callers pass the *active* set, since
 *   an archived mission is not part of the plan and would only add clutter
 */
export function layoutMissionGraph(missions: MissionRecord[]): GraphLayout {
  if (missions.length === 0) {
    return { nodes: [], edges: [], width: 0, height: 0, cycles: [], danglingEdges: [] };
  }

  const byId = new Map(missions.map((m) => [m.id, m]));
  const { layer, inCycle } = computeLayers(missions);

  const edges: GraphEdge[] = [];
  const danglingEdges: { from: ID; missingId: ID }[] = [];
  const degree = new Map<ID, number>();
  const bump = (id: ID) => degree.set(id, (degree.get(id) ?? 0) + 1);

  for (const m of missions) {
    for (const dep of m.dependsOn ?? []) {
      if (!byId.has(dep)) {
        danglingEdges.push({ from: m.id, missingId: dep });
        continue;
      }
      edges.push({ from: dep, to: m.id, isCycle: inCycle.has(dep) && inCycle.has(m.id) });
      bump(dep);
      bump(m.id);
    }
  }

  /*
    The space the simulation runs IN, which is not the canvas it is drawn on.
    Only the starting ring and the centring force use it; the drawn box is
    computed from where the nodes actually end up (see the bottom of this
    function). Keeping the two separate is what stopped the graph being a small
    cluster in the corner of a large empty card.
  */
  const size = Math.max(420, Math.min(900, 260 + missions.length * 62));
  const fieldW = size + PAD * 2;
  const fieldH = Math.max(340, size * 0.62) + PAD * 2;
  const cx = fieldW / 2;
  const cy = fieldH / 2;

  /*
    Start on a ring rather than at random. A random start sometimes settles
    into a knot it cannot escape; a ring is already untangled, and the
    simulation only has to pull related things together.

    Depth biases the starting angle, so the result still reads left-to-right
    along dependency order without being forced into columns.
  */
  const pos = missions.map((m, i) => {
    const depth = layer.get(m.id) ?? 0;
    const jitter = seededUnit(m.id, 7) * 0.6 - 0.3;
    const angle = (i / missions.length) * Math.PI * 2 + depth * 0.55 + jitter;
    const radius = size * 0.34 * (0.75 + seededUnit(m.id, 13) * 0.5);
    return { id: m.id, x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius };
  });
  const index = new Map(pos.map((p, i) => [p.id, i]));

  const linked = edges.map((e) => [index.get(e.from) ?? 0, index.get(e.to) ?? 0] as const);
  const IDEAL = 132;

  for (let step = 0; step < ITERATIONS; step++) {
    // Cooling: big moves early, fine adjustment late, then still.
    const cool = 1 - step / ITERATIONS;

    // Everything pushes everything else apart, so nodes do not overlap.
    for (let a = 0; a < pos.length; a++) {
      for (let b = a + 1; b < pos.length; b++) {
        let dx = pos[a].x - pos[b].x;
        let dy = pos[a].y - pos[b].y;
        let dist = Math.hypot(dx, dy) || 0.01;
        // Nudge coincident nodes apart deterministically rather than randomly,
        // or the layout would differ between renders.
        if (dist < 0.05) {
          dx = (a - b) * 0.1;
          dy = 0.1;
          dist = Math.hypot(dx, dy);
        }
        const push = (5200 / (dist * dist)) * cool;
        const ux = (dx / dist) * push;
        const uy = (dy / dist) * push;
        pos[a].x += ux;
        pos[a].y += uy;
        pos[b].x -= ux;
        pos[b].y -= uy;
      }
    }

    // A dependency pulls two missions together.
    for (const [a, b] of linked) {
      if (a === b) continue;
      const dx = pos[b].x - pos[a].x;
      const dy = pos[b].y - pos[a].y;
      const dist = Math.hypot(dx, dy) || 0.01;
      const pull = ((dist - IDEAL) / dist) * 0.045 * cool;
      pos[a].x += dx * pull;
      pos[a].y += dy * pull;
      pos[b].x -= dx * pull;
      pos[b].y -= dy * pull;
    }

    // Gentle pull to centre, so an unconnected mission does not drift off.
    for (const p of pos) {
      p.x += (cx - p.x) * 0.012 * cool;
      p.y += (cy - p.y) * 0.012 * cool;
    }
  }

  /*
    Fit the canvas to where the nodes actually ENDED UP, rather than clamping
    them into a box guessed beforehand.

    The first version sized the canvas from the mission count and then clamped
    positions into it. A settled simulation does not fill a predicted rectangle
    — it makes a compact blob wherever the forces balanced — so the graph drew
    as a small cluster in one corner of a large empty card. Measured with nine
    missions: the cluster used roughly a third of the width.

    Taking the bounding box afterwards means the drawing always fills its
    space, at any mission count, without the layout having to predict its own
    shape. Padding leaves room for the glow and the progress ring, which extend
    well past the node's centre.
  */
  const margin = PAD;
  const minX = Math.min(...pos.map((p) => p.x));
  const maxX = Math.max(...pos.map((p) => p.x));
  const minY = Math.min(...pos.map((p) => p.y));
  const maxY = Math.max(...pos.map((p) => p.y));

  /*
    ...but never let the box hug the cluster so tightly that the nodes render
    enormous.

    Fitting to content alone overcorrected: a settled simulation makes a
    compact blob, so a viewBox drawn tight around it scales to the card width
    and every node balloons until the labels overflow their circles. The
    viewBox is a *scale* control as much as a framing one.

    So the box is at least this wide, with the content centred in it. The floor
    grows with sqrt(count) rather than count — nodes spread in two dimensions,
    so a linear floor would leave a big board mostly empty.
  */
  const contentW = Math.max(1, maxX - minX);
  const contentH = Math.max(1, maxY - minY);
  const floorW = Math.max(560, Math.sqrt(missions.length) * 250);
  const floorH = floorW * 0.58;

  const width = Math.max(contentW + margin * 2, floorW);
  const height = Math.max(contentH + margin * 2, floorH);

  // Centre the content in whichever box won.
  const offsetX = (width - contentW) / 2 - minX;
  const offsetY = (height - contentH) / 2 - minY;

  const nodes: GraphNode[] = missions.map((mission) => {
    const p = pos[index.get(mission.id) ?? 0];
    return {
      mission,
      layer: layer.get(mission.id) ?? 0,
      x: p.x + offsetX,
      y: p.y + offsetY,
      inCycle: inCycle.has(mission.id),
      degree: degree.get(mission.id) ?? 0,
    };
  });

  return { nodes, edges, width, height, cycles: [...inCycle], danglingEdges };
}
