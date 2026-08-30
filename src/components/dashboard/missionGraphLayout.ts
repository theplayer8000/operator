import type { ID, MissionRecord } from "@/lib/types";

/**
 * Turning `dependsOn` into something drawable.
 *
 * Kept out of the component and free of React on purpose: this is the part
 * with the edge cases, and it is far easier to reason about — and to fix —
 * when it is a function from missions to coordinates rather than something
 * tangled in a render.
 *
 * See `docs/dashboard-graph-design.md` for why a layered layout rather than a
 * force-directed one: `dependsOn` is directional and reads as a sequence, and
 * a layout that drifts under the pointer is hard to click and harder to trust.
 */

export interface GraphNode {
  mission: MissionRecord;
  /** How many steps from a mission with no prerequisites. */
  layer: number;
  x: number;
  y: number;
  /** True when this mission sits in a dependency cycle. */
  inCycle: boolean;
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

export const NODE_W = 190;
export const NODE_H = 62;
const GAP_X = 96;
const GAP_Y = 26;
const PAD = 28;

/**
 * Depth of each mission, and which ones are in a cycle.
 *
 * **Cycles are detected rather than assumed away.** Nothing in the app stops
 * mission A depending on B depending on A — the Mission Board is a list and
 * survives it happily — but a layered graph cannot place either one, and the
 * naive recursion would not return. A cycle is also a real planning bug worth
 * telling the owner about, so it is reported rather than silently broken.
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
    only drawn as a cycle when BOTH its ends are marked, the dashed edges that
    are supposed to show the loop never appeared. Found by test rather than by
    use — there is one mission in the store today and no dependency anywhere,
    so nothing would have exercised this for months.

    With the order kept, everything from the revisited id to the end of the
    path is the loop, and all of it gets marked.
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
      // A dependency on a mission that no longer exists contributes nothing.
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

/**
 * @param missions the missions to draw — callers pass the *active* set, since
 *   an archived mission is not part of the plan and would only add width
 */
export function layoutMissionGraph(missions: MissionRecord[]): GraphLayout {
  if (missions.length === 0) {
    return { nodes: [], edges: [], width: 0, height: 0, cycles: [], danglingEdges: [] };
  }

  const byId = new Map(missions.map((m) => [m.id, m]));
  const { layer, inCycle } = computeLayers(missions);

  // Group by layer, so each column can be centred against the tallest one.
  const columns = new Map<number, MissionRecord[]>();
  for (const m of missions) {
    const l = layer.get(m.id) ?? 0;
    const bucket = columns.get(l);
    if (bucket) bucket.push(m);
    else columns.set(l, [m]);
  }

  const layerIndexes = [...columns.keys()].sort((a, b) => a - b);
  const tallest = Math.max(...[...columns.values()].map((c) => c.length));
  const height = PAD * 2 + tallest * NODE_H + (tallest - 1) * GAP_Y;

  const nodes: GraphNode[] = [];
  layerIndexes.forEach((l, columnIndex) => {
    const column = columns.get(l) ?? [];
    // Stable order within a column so the graph does not reshuffle between
    // renders — createdAt rather than array order, which mutations change.
    const sorted = [...column].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const colHeight = sorted.length * NODE_H + (sorted.length - 1) * GAP_Y;
    const top = (height - colHeight) / 2;
    sorted.forEach((mission, rowIndex) => {
      nodes.push({
        mission,
        layer: l,
        x: PAD + columnIndex * (NODE_W + GAP_X),
        y: top + rowIndex * (NODE_H + GAP_Y),
        inCycle: inCycle.has(mission.id),
      });
    });
  });

  const edges: GraphEdge[] = [];
  const danglingEdges: { from: ID; missingId: ID }[] = [];
  for (const m of missions) {
    for (const dep of m.dependsOn ?? []) {
      if (!byId.has(dep)) {
        danglingEdges.push({ from: m.id, missingId: dep });
        continue;
      }
      edges.push({
        from: dep,
        to: m.id,
        isCycle: inCycle.has(dep) && inCycle.has(m.id),
      });
    }
  }

  const width = PAD * 2 + layerIndexes.length * NODE_W + (layerIndexes.length - 1) * GAP_X;

  return {
    nodes,
    edges,
    width,
    height,
    cycles: [...inCycle],
    danglingEdges,
  };
}
