import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { GitBranch, AlertTriangle, ArrowUpRight } from "lucide-react";
import { useMissionBoard } from "@/hooks/useMissionBoard";
import { layoutMissionGraph, NODE_W, NODE_H } from "./missionGraphLayout";
import type { MissionRecord, MissionStatus } from "@/lib/types";

/**
 * The Mission Board as the graph it has always been.
 *
 * `dependsOn` has held directional edges since the board was built, and nothing
 * has ever shown their shape — `DependencyChain.tsx` renders one mission's
 * immediate neighbours and cannot say "everything is blocked behind that one".
 * This is the first view of data the app already had.
 *
 * ## Reads only
 *
 * It calls `useMissionBoard` and mutates nothing. Opening a mission is a link
 * to its detail page, where the owning feature does the editing — see
 * `CLAUDE.md`: *"Writing still goes through the owning feature's hook,
 * always."* A second copy of a mission is exactly the mistake ADR 0008 already
 * corrected once.
 *
 * ## Big screens only
 *
 * The owner's decision, 2026-08-30. This is for the desk and eventually a wall
 * display; the phone keeps the Dashboard it has. The caller is responsible for
 * not mounting it below the breakpoint — `display: none` would still cost
 * memory and animation frames for something nobody can see. See
 * `docs/dashboard-graph-design.md`.
 */

const STATUS_STYLE: Record<MissionStatus, { dot: string; stroke: string; label: string }> = {
  not_started: { dot: "fill-ink-700", stroke: "stroke-base-500", label: "Not started" },
  in_progress: { dot: "fill-rank", stroke: "stroke-rank/50", label: "In progress" },
  blocked: { dot: "fill-vital-down", stroke: "stroke-vital-down/50", label: "Blocked" },
  complete: { dot: "fill-vital-up", stroke: "stroke-vital-up/50", label: "Complete" },
};

/**
 * A curve from the right edge of one node to the left edge of the next.
 *
 * Horizontal control points rather than a straight line: with several edges
 * converging on one mission, straight lines overlap into a single wedge and
 * you cannot tell how many there are.
 */
function edgePath(x1: number, y1: number, x2: number, y2: number) {
  const dx = Math.max(40, (x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

export default function MissionGraph() {
  const { active } = useMissionBoard();
  const [hovered, setHovered] = useState<string | null>(null);

  const layout = useMemo(() => layoutMissionGraph(active), [active]);

  const nodeById = useMemo(
    () => new Map(layout.nodes.map((n) => [n.mission.id, n])),
    [layout.nodes],
  );

  /*
    What is connected to the mission under the pointer, in both directions.
    Highlighting only the direct neighbours is the point of the view: "what is
    waiting on this" is the question the list cannot answer.
  */
  const related = useMemo(() => {
    if (!hovered) return null;
    const ids = new Set<string>([hovered]);
    for (const e of layout.edges) {
      if (e.from === hovered) ids.add(e.to);
      if (e.to === hovered) ids.add(e.from);
    }
    return ids;
  }, [hovered, layout.edges]);

  if (active.length === 0) {
    return (
      <div className="card-base p-6 text-center">
        <GitBranch size={18} className="mx-auto text-ink-700 mb-2" />
        <p className="text-sm text-ink-500">No active missions to map.</p>
        <Link to="/missions" className="text-xs text-xp hover:underline mt-1 inline-block">
          Open the Mission Board
        </Link>
      </div>
    );
  }

  return (
    <section className="card-base p-4 sm:p-5 animate-fade-up">
      <header className="flex items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-2 min-w-0">
          <GitBranch size={15} className="text-ink-500 shrink-0" />
          <div className="min-w-0">
            <h2 className="font-display text-sm font-medium text-ink-300">Mission map</h2>
            <p className="text-xs text-ink-700">
              {layout.nodes.length} active · {layout.edges.length}{" "}
              {layout.edges.length === 1 ? "dependency" : "dependencies"}
            </p>
          </div>
        </div>
        <Link
          to="/missions"
          className="shrink-0 flex items-center gap-1 text-[11px] text-ink-500 hover:text-ink-100 transition-colors"
        >
          Board <ArrowUpRight size={12} />
        </Link>
      </header>

      {/*
        A dependency cycle is a planning bug, not a drawing problem. The layout
        survives one; the owner should still be told, because nothing else in
        the app will ever mention it.
      */}
      {layout.cycles.length > 0 && (
        <p className="flex items-start gap-2 text-[11px] text-vital-down mb-3">
          <AlertTriangle size={12} className="shrink-0 mt-0.5" />
          <span>
            {layout.cycles.length} mission{layout.cycles.length === 1 ? "" : "s"} depend on each
            other in a loop, so nothing in it can start. Those edges are dashed below.
          </span>
        </p>
      )}

      <div className="overflow-x-auto scrollbar-none">
        <svg
          width={layout.width}
          height={layout.height}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          className="max-w-none"
          role="img"
          aria-label={`Dependency map of ${layout.nodes.length} active missions`}
        >
          <defs>
            <marker
              id="mg-arrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="5"
              markerHeight="5"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" className="fill-base-500" />
            </marker>
          </defs>

          {layout.edges.map((e) => {
            const from = nodeById.get(e.from);
            const to = nodeById.get(e.to);
            if (!from || !to) return null;
            const dim = related !== null && !(related.has(e.from) && related.has(e.to));
            return (
              <path
                key={`${e.from}->${e.to}`}
                d={edgePath(
                  from.x + NODE_W,
                  from.y + NODE_H / 2,
                  to.x,
                  to.y + NODE_H / 2,
                )}
                fill="none"
                strokeWidth={1.5}
                markerEnd="url(#mg-arrow)"
                strokeDasharray={e.isCycle ? "4 3" : undefined}
                className={`transition-opacity duration-200 ${
                  e.isCycle ? "stroke-vital-down/70" : "stroke-base-500"
                } ${dim ? "opacity-20" : "opacity-100"}`}
              />
            );
          })}

          {layout.nodes.map((n) => {
            const m: MissionRecord = n.mission;
            const style = STATUS_STYLE[m.status] ?? STATUS_STYLE.not_started;
            const dim = related !== null && !related.has(m.id);
            return (
              <g
                key={m.id}
                transform={`translate(${n.x}, ${n.y})`}
                onMouseEnter={() => setHovered(m.id)}
                onMouseLeave={() => setHovered(null)}
                className={`transition-opacity duration-200 ${dim ? "opacity-30" : "opacity-100"}`}
              >
                <Link to={`/missions/${m.id}`} aria-label={`Open mission ${m.name}`}>
                  <rect
                    width={NODE_W}
                    height={NODE_H}
                    rx={12}
                    className={`fill-base-800 ${style.stroke} transition-colors cursor-pointer`}
                    strokeWidth={hovered === m.id ? 2 : 1}
                  />
                  <circle cx={16} cy={20} r={4} className={style.dot} />
                  <text
                    x={28}
                    y={24}
                    className="fill-ink-100 text-[12px] font-body"
                    style={{ pointerEvents: "none" }}
                  >
                    {m.name.length > 20 ? `${m.name.slice(0, 19)}…` : m.name}
                  </text>
                  <text
                    x={16}
                    y={40}
                    className="fill-ink-700 text-[10px] font-mono"
                    style={{ pointerEvents: "none" }}
                  >
                    {style.label} · {m.progress}%
                  </text>
                  {/* Progress as a rail along the bottom edge — readable at a
                      glance from across a desk, which a number is not. */}
                  <rect x={16} y={48} width={NODE_W - 32} height={3} rx={1.5} className="fill-base-600" />
                  <rect
                    x={16}
                    y={48}
                    width={Math.max(0, Math.min(100, m.progress)) * ((NODE_W - 32) / 100)}
                    height={3}
                    rx={1.5}
                    className={m.status === "blocked" ? "fill-vital-down" : "fill-xp"}
                  />
                </Link>
              </g>
            );
          })}
        </svg>
      </div>

      {layout.danglingEdges.length > 0 && (
        <p className="text-[11px] text-ink-700 mt-3">
          {layout.danglingEdges.length} dependenc
          {layout.danglingEdges.length === 1 ? "y points" : "ies point"} at a mission that no
          longer exists, and {layout.danglingEdges.length === 1 ? "is" : "are"} not drawn.
        </p>
      )}
    </section>
  );
}
