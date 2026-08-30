import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { GitBranch, AlertTriangle, ArrowUpRight } from "lucide-react";
import { useMissionBoard } from "@/hooks/useMissionBoard";
import { layoutMissionGraph, NODE_R } from "./missionGraphLayout";
import type { MissionStatus } from "@/lib/types";

/**
 * The Mission Board as the graph it has always been.
 *
 * `dependsOn` has held directional edges since the board was built, and nothing
 * ever showed their shape — `DependencyChain.tsx` renders one mission's
 * immediate neighbours and cannot say "everything is blocked behind that one".
 * This is the first view of data the app already had.
 *
 * ## The register here is deliberately not Mission Board's
 *
 * `design-system.md` records that the board was explicitly asked to avoid game
 * UI. This is the owner's amendment of 2026-08-30 and it is narrow: **the map
 * is alive, the mission card stays calm.** A HUD is a good place to see shape
 * and a bad place to read a paragraph, so clicking a node goes to the ordinary
 * detail page.
 *
 * ## Reads only
 *
 * Calls `useMissionBoard` and mutates nothing; opening a mission is a link. A
 * second copy of a mission here is exactly the mistake ADR 0008 corrected once.
 *
 * ## Big screens only
 *
 * The caller must not MOUNT this below the breakpoint — `display: none` still
 * builds every node and runs every animation for a view nobody can see. See
 * `docs/dashboard-graph-design.md`.
 */

const STATUS: Record<MissionStatus, { core: string; glow: string; label: string }> = {
  not_started: { core: "#5A6272", glow: "#5A6272", label: "Not started" },
  in_progress: { core: "#8D7FE0", glow: "#8D7FE0", label: "In progress" },
  blocked: { core: "#E05A5A", glow: "#E05A5A", label: "Blocked" },
  complete: { core: "#4ED88A", glow: "#4ED88A", label: "Complete" },
};

/** A curve between two nodes, bowed perpendicular so parallel edges separate. */
function edgePath(x1: number, y1: number, x2: number, y2: number) {
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  // Bow by a fraction of the length, perpendicular to the line.
  const bow = Math.min(38, len * 0.18);
  const cxp = mx - (dy / len) * bow;
  const cyp = my + (dx / len) * bow;
  return `M ${x1} ${y1} Q ${cxp} ${cyp} ${x2} ${y2}`;
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
    What the hovered mission touches, both directions. Highlighting only direct
    neighbours is the point of the view: "what is waiting on this" is the
    question the list cannot answer.
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
    <section className="card-base p-4 sm:p-5 animate-fade-up overflow-hidden">
      <header className="flex items-center justify-between gap-3 mb-2">
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

      {layout.cycles.length > 0 && (
        <p className="flex items-start gap-2 text-[11px] text-vital-down mb-2">
          <AlertTriangle size={12} className="shrink-0 mt-0.5" />
          <span>
            {layout.cycles.length} missions depend on each other in a loop, so nothing in it can
            start. Those edges are dashed.
          </span>
        </p>
      )}

      <div className="flex justify-center">
        <svg
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          /*
            Capped height, not just full width. Without a ceiling a wide card
            scales the drawing until the map is taller than the rest of the
            Dashboard put together — it is a panel on a page, not the page.
          */
          className="w-full h-auto max-w-full max-h-[540px]"
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label={`Dependency map of ${layout.nodes.length} active missions`}
        >
          <defs>
            {/*
              One blur reused by every glow. A per-node filter would be a
              filter per mission, and SVG filters are the expensive part of a
              scene like this.
            */}
            <filter id="mg-glow" x="-60%" y="-60%" width="220%" height="220%">
              <feGaussianBlur stdDeviation="5" result="b" />
              <feMerge>
                <feMergeNode in="b" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
            <radialGradient id="mg-halo">
              <stop offset="0%" stopColor="currentColor" stopOpacity="0.30" />
              <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
            </radialGradient>
          </defs>

          {/* Edges under the nodes, so a line never crosses a label. */}
          <g fill="none">
            {layout.edges.map((e) => {
              const from = nodeById.get(e.from);
              const to = nodeById.get(e.to);
              if (!from || !to) return null;
              const lit = related !== null && related.has(e.from) && related.has(e.to);
              const dim = related !== null && !lit;
              return (
                <path
                  key={`${e.from}->${e.to}`}
                  d={edgePath(from.x, from.y, to.x, to.y)}
                  strokeWidth={lit ? 2 : 1.25}
                  strokeDasharray={e.isCycle ? "5 4" : undefined}
                  stroke={e.isCycle ? "#E05A5A" : lit ? "#E8B04D" : "#3A4152"}
                  className="transition-all duration-300"
                  opacity={dim ? 0.15 : 1}
                />
              );
            })}
          </g>

          {layout.nodes.map((n, i) => {
            const m = n.mission;
            const s = STATUS[m.status] ?? STATUS.not_started;
            const dim = related !== null && !related.has(m.id);
            const isHovered = hovered === m.id;
            // Hubs read as hubs: a mission several others wait on is bigger.
            const r = NODE_R + Math.min(10, n.degree * 2.5);
            const pct = Math.max(0, Math.min(100, m.progress));
            const circumference = 2 * Math.PI * (r + 7);

            return (
              <g
                key={m.id}
                transform={`translate(${n.x}, ${n.y})`}
                onMouseEnter={() => setHovered(m.id)}
                onMouseLeave={() => setHovered(null)}
                className="transition-opacity duration-300 cursor-pointer"
                opacity={dim ? 0.25 : 1}
                style={{ color: s.glow }}
              >
                <Link to={`/missions/${m.id}`} aria-label={`Open mission ${m.name}`}>
                  {/*
                    The float is the only thing still moving, and it is tiny —
                    a couple of pixels, out of phase per node. Enough to read as
                    alive, small enough that a click still lands where it was
                    aimed. That is the whole argument for settling the layout
                    and animating decoration instead.
                  */}
                  <g
                    style={{
                      animation: `mg-float ${5 + (i % 4) * 0.9}s ease-in-out ${i * 0.35}s infinite`,
                    }}
                  >
                    <circle r={r + 26} fill="url(#mg-halo)" />
                    {/* Progress ring — reads at a glance from across a desk. */}
                    <circle
                      r={r + 7}
                      fill="none"
                      stroke="#2A303C"
                      strokeWidth={3}
                    />
                    <circle
                      r={r + 7}
                      fill="none"
                      stroke={m.status === "blocked" ? "#E05A5A" : "#E8B04D"}
                      strokeWidth={3}
                      strokeLinecap="round"
                      strokeDasharray={`${(pct / 100) * circumference} ${circumference}`}
                      transform="rotate(-90)"
                      className="transition-all duration-500"
                    />
                    <circle
                      r={r}
                      fill="#151A23"
                      stroke={s.core}
                      strokeWidth={isHovered ? 2.5 : 1.5}
                      filter={isHovered ? "url(#mg-glow)" : undefined}
                      className="transition-all duration-200"
                    />
                    <text
                      textAnchor="middle"
                      y={-2}
                      className="fill-ink-100 font-body"
                      style={{ fontSize: 11, pointerEvents: "none" }}
                    >
                      {m.name.length > 13 ? `${m.name.slice(0, 12)}…` : m.name}
                    </text>
                    <text
                      textAnchor="middle"
                      y={12}
                      className="font-mono"
                      style={{ fontSize: 9, fill: s.core, pointerEvents: "none" }}
                    >
                      {pct}%
                    </text>
                  </g>
                </Link>
              </g>
            );
          })}
        </svg>
      </div>

      {layout.danglingEdges.length > 0 && (
        <p className="text-[11px] text-ink-700 mt-2">
          {layout.danglingEdges.length} dependenc
          {layout.danglingEdges.length === 1 ? "y points" : "ies point"} at a mission that no
          longer exists, and {layout.danglingEdges.length === 1 ? "is" : "are"} not drawn.
        </p>
      )}
    </section>
  );
}
