import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { GitBranch, AlertTriangle, ArrowUpRight, Maximize2 } from "lucide-react";
import { useMissionBoard } from "@/hooks/useMissionBoard";
import { useVoiceActivity } from "@/hooks/useVoiceActivity";
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

  /*
    The map IS the voice interface.

    The owner's brief, and it is a better idea than a meter in a corner: when
    Operator hears you the whole thing breathes, and when it answers it breathes
    differently. You look at one thing and know which of the two is happening,
    from across a room, without reading anything.

    Two distinct signals rather than one "audio" light — hearing and speaking
    need telling apart at exactly the moment they matter, and merging them into
    activity would make the map say something is happening while hiding which.
  */
  const voice = useVoiceActivity();

  /*
    Normalised loudness, 0–1, relative to the threshold a clap must beat.

    Raw level is unusable for this: a quiet microphone lives around 0.001 and
    speech might reach 0.02, so a bar drawn from it would never visibly move.
    Scaling against the detector's own threshold means the map reacts the same
    way on any microphone — which is the same reasoning that made the clap
    threshold a ratio rather than an absolute after it was guessed wrong twice.
  */
  const heard = voice.listening
    ? Math.min(1, voice.level / Math.max(0.004, voice.threshold))
    : 0;
  // Below this it is room noise, and a map that twitches at silence is worse
  // than one that stays still.
  const hearing = heard > 0.35;

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
        {/*
          Says which of the three states the map is in, because a still map is
          otherwise ambiguous between "quiet room" and "microphone is off" —
          and the second one is worth knowing before you talk to it.

          Nothing at all when the listener is off. An "idle" chip on a machine
          with no microphone would be permanent furniture advertising a feature
          that isn't running.
        */}
        {voice.listening && (
          <span
            className="shrink-0 flex items-center gap-1.5 text-[11px] font-mono text-ink-600"
            title={voice.speaking ? "Operator is speaking" : "Microphone is open"}
          >
            <span
              className="w-1.5 h-1.5 rounded-full transition-all duration-150"
              style={{
                background: voice.speaking ? "#8D7FE0" : "#E8B04D",
                opacity: voice.speaking ? 1 : 0.35 + heard * 0.65,
                transform: `scale(${voice.speaking ? 1.4 : 1 + heard * 0.6})`,
              }}
            />
            {voice.speaking ? "speaking" : hearing ? "hearing" : "listening"}
          </span>
        )}
        {/*
          The way to the wall display. This card is a summary; `/map` is the
          live one you can grab hold of, and without a link here nobody would
          ever find it.
        */}
        <Link
          to="/map"
          className="shrink-0 flex items-center gap-1 text-[11px] text-xp hover:text-ink-100 transition-colors min-h-[36px] px-1"
        >
          <Maximize2 size={12} /> Full map
        </Link>
        <Link
          to="/missions"
          className="shrink-0 flex items-center gap-1 text-[11px] text-ink-500 hover:text-ink-100 transition-colors min-h-[36px] px-1"
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

      {/*
        The map gets its own dark well, inset from the card.

        Without it the SVG's near-black ground met the card's lighter surface at
        a hard rectangular edge, which looked like a bug rather than a display.
        The border and radius make it read as a window into something.
      */}
      <div className="flex justify-center rounded-card overflow-hidden border border-base-600/70 bg-[#080B11]">
        <svg
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          /*
            Capped height, not just full width. Without a ceiling a wide card
            scales the drawing until the map is taller than the rest of the
            Dashboard put together — it is a panel on a page, not the page.
          */
          className="w-full h-auto max-w-full max-h-[560px]"
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label={`Dependency map of ${layout.nodes.length} active missions`}
        >
          <defs>
            {/*
              Glow is a BLUR OF THE STROKE, not a filled halo.

              The first version drew a soft filled disc behind every node at
              0.30 opacity. Nine of those overlap, they are additive, and the
              result was a milky lavender fog that erased the dark ground the
              whole design rests on — the map has to be dark for anything on it
              to look lit. Blurring the line itself glows without ever filling
              the space between nodes.
            */}
            <filter id="mg-glow" x="-120%" y="-120%" width="340%" height="340%">
              <feGaussianBlur stdDeviation="3.5" result="b" />
              <feMerge>
                <feMergeNode in="b" />
                <feMergeNode in="b" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
            <filter id="mg-web" x="-40%" y="-40%" width="180%" height="180%">
              <feGaussianBlur stdDeviation="1.6" result="b" />
              <feMerge>
                <feMergeNode in="b" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
            {/*
              The ground. Near-black, lit slightly from the middle, so the map
              reads as its own dark space rather than a diagram sitting on a
              card. Everything else is light drawn on top of this.
            */}
            <radialGradient id="mg-ground" cx="50%" cy="45%">
              <stop offset="0%" stopColor="#141A26" />
              <stop offset="100%" stopColor="#080B11" />
            </radialGradient>
          </defs>

          <rect
            x={0}
            y={0}
            width={layout.width}
            height={layout.height}
            fill="url(#mg-ground)"
          />

          {/*
            The voice lights the WEB, not the whole canvas.

            A full-canvas wash was the obvious way to do this and it was wrong:
            it flooded the dark ground and made everything pale. Brightening the
            strands instead means the structure itself responds — the thing that
            looks alive is the network, which is what makes it read as a nervous
            system rather than a screen flash.
          */}

          {/* Edges under the nodes, so a line never crosses a label. */}
          <g fill="none" filter="url(#mg-web)">
            {layout.edges.map((e) => {
              const from = nodeById.get(e.from);
              const to = nodeById.get(e.to);
              if (!from || !to) return null;
              const lit = related !== null && related.has(e.from) && related.has(e.to);
              const dim = related !== null && !lit;
              /*
                Voice brightens every strand at once. The map is one listener,
                not nine, so the web responding as a single surface is the
                honest reading — and it stays legible because a brighter line is
                still a line, where a wash was not.
              */
              const voiceLift = voice.speaking ? 0.55 : hearing ? heard * 0.5 : 0;
              const strand = e.isCycle
                ? "#E05A5A"
                : lit
                  ? "#E8B04D"
                  : voice.speaking
                    ? "#8D7FE0"
                    : voiceLift > 0
                      ? "#E8B04D"
                      : "#4A5468";
              return (
                <path
                  key={`${e.from}->${e.to}`}
                  d={edgePath(from.x, from.y, to.x, to.y)}
                  strokeWidth={lit ? 1.9 : 1 + voiceLift}
                  strokeDasharray={e.isCycle ? "5 4" : undefined}
                  stroke={strand}
                  strokeLinecap="round"
                  className="transition-all duration-200"
                  opacity={dim ? 0.12 : 0.42 + voiceLift * 0.58}
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
                    {/*
                      Each node swells with the voice, out of phase.

                      The delay is `i * 0.06`, so loudness travels ACROSS the
                      map rather than every node throbbing in unison — a
                      synchronised pulse reads as a loading spinner, a
                      travelling one reads as something alive hearing you.
                      Tiny, because this must not move a click target: the
                      halo grows, the node itself does not.
                    */}
                    {/*
                      A thin expanding RING, not a filled disc.

                      An outline can overlap its neighbours all day without
                      adding up to fog, which is exactly what the filled version
                      did. Out of phase per node so the response travels across
                      the web instead of every node throbbing together.
                    */}
                    {(hearing || voice.speaking) && (
                      <circle
                        r={r + 10 + (voice.speaking ? 12 : heard * 20)}
                        fill="none"
                        stroke={voice.speaking ? "#8D7FE0" : "#E8B04D"}
                        strokeWidth={1.25}
                        opacity={(voice.speaking ? 0.5 : 0.18 + heard * 0.5) * 0.9}
                        filter="url(#mg-glow)"
                        className="transition-all duration-150"
                        style={{ transitionDelay: `${(i % 6) * 55}ms` }}
                      />
                    )}
                    {/* Progress ring — reads at a glance from across a desk. */}
                    <circle r={r + 7} fill="none" stroke="#232A38" strokeWidth={2.5} />
                    <circle
                      r={r + 7}
                      fill="none"
                      stroke={m.status === "blocked" ? "#E05A5A" : "#E8B04D"}
                      strokeWidth={2.5}
                      strokeLinecap="round"
                      strokeDasharray={`${(pct / 100) * circumference} ${circumference}`}
                      transform="rotate(-90)"
                      className="transition-all duration-500"
                      filter={pct > 0 ? "url(#mg-web)" : undefined}
                    />
                    {/*
                      Dark core with a luminous rim. The fill has to be darker
                      than the ground or the node reads as a hole punched in the
                      map rather than an object sitting on it.
                    */}
                    <circle r={r} fill="#0B0F16" fillOpacity={0.96} />
                    <circle
                      r={r}
                      fill="none"
                      stroke={s.core}
                      strokeWidth={isHovered ? 2.2 : 1.4}
                      filter="url(#mg-glow)"
                      className="transition-all duration-200"
                      opacity={isHovered ? 1 : 0.85}
                    />
                    {/*
                      Only the number goes inside. A 30px circle cannot hold a
                      mission name at a readable size — the previous version cut
                      every one to twelve characters, which turned "Knowledge
                      Vault" into "Knowledge Va…" and told you nothing.
                    */}
                    <text
                      textAnchor="middle"
                      y={4}
                      className="font-mono"
                      style={{
                        fontSize: 12,
                        fill: s.core,
                        pointerEvents: "none",
                        fontWeight: 500,
                      }}
                    >
                      {pct}%
                    </text>
                    {/*
                      The name sits BELOW the node, where it has the full width
                      between neighbours instead of a circle's diameter.
                    */}
                    <text
                      textAnchor="middle"
                      y={r + 24}
                      className="fill-ink-200 font-body"
                      style={{ fontSize: 11.5, pointerEvents: "none" }}
                    >
                      {m.name.length > 22 ? `${m.name.slice(0, 21)}…` : m.name}
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
