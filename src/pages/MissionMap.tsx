import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMissionBoard } from "@/hooks/useMissionBoard";
import { useVoiceActivity } from "@/hooks/useVoiceActivity";
import { useMicLevel } from "@/hooks/useMicLevel";
import { usePhoneTranscript } from "@/hooks/usePhoneTranscript";
import MicSource, { type MicChoice } from "@/components/map/MicSource";
import type { MissionRecord, MissionStatus } from "@/lib/types";
import { drawCore, rgba, GOLD, VIOLET } from "@/components/map/operatorCore";
import OperatorChat from "@/components/map/OperatorChat";

/**
 * The mission map as a room-scale display.
 *
 * This is the wall screen the owner asked for twice — "i want its own screen",
 * "only have the massive huge live graph / node feedback model on my pc a
 * bigger screen or when i get a tv/ projector". The Dashboard card that existed
 * before was a summary widget wearing the name, and he was right that it was
 * not this.
 *
 * ## Why canvas, and why it never stops moving
 *
 * The Dashboard version settles its layout once and animates decoration, which
 * is correct for a widget sharing a page. Here the simulation runs every frame
 * and never freezes: you can grab a node and throw it, the web reorganises
 * around your hand, and it keeps breathing when you let go. That difference is
 * the whole point of a display you leave running.
 *
 * Canvas rather than SVG for one specific reason — `globalCompositeOperation =
 * "lighter"`. Additive blending is what makes overlapping light look like light
 * instead of like paint, and SVG has no equivalent that performs. The first
 * attempt at a glowing map used stacked translucent SVG discs and turned the
 * whole thing into pale fog.
 *
 * ## Reads only
 *
 * `useMissionBoard`, mutating nothing. Clicking a node opens the ordinary
 * mission page — a HUD is a good place to see shape and a bad place to edit a
 * paragraph.
 *
 * ## Deliberately outside AppLayout
 *
 * No sidebar, no topbar. Full bleed is not a style choice here; the sidebar is
 * what makes a wall display look like a web page.
 */

const STATUS_COLOR: Record<MissionStatus, [number, number, number]> = {
  not_started: [122, 134, 158],
  in_progress: [141, 127, 224],
  blocked: [224, 90, 90],
  complete: [78, 216, 138],
};


/** Operator's own node at the centre — the thing every mission hangs off. */
const CORE_R = 62;
/** Missions settle outside this, so nothing parks on top of the core. */
const MIN_ORBIT = 235;



interface Body {
  id: string;
  mission: MissionRecord;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  degree: number;
}

interface Edge {
  from: string;
  to: string;
}

export default function MissionMap() {
  const { active } = useMissionBoard();
  const navigate = useNavigate();
  const voice = useVoiceActivity();
  /*
    This machine's own microphone, and what it hears.

    Same hooks as the phone surface, deliberately: the owner asked for the
    transcript "on pc screen aswell", and two implementations of the same thing
    drift. It matters more here than it looks — the server-side listener is
    pointed at whichever device OPERATOR_LISTEN names, which has spent most of
    its life disconnected. A microphone the browser opens is one that is
    actually plugged into the machine someone is sitting at.
  */
  const mic = useMicLevel();
  const [micChoice, setMicChoice] = useState<MicChoice>("device");
  const transcript = usePhoneTranscript(mic, mic.active);
  const lastHeard = transcript.lines.length
    ? transcript.lines[transcript.lines.length - 1]
    : null;

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const bodiesRef = useRef<Body[]>([]);
  const edgesRef = useRef<Edge[]>([]);
  const [hovered, setHovered] = useState<MissionRecord | null>(null);

  /*
    Live inputs the render loop reads without restarting.

    The loop is started once and must not be torn down every time the mic level
    changes — that would rebuild the simulation four times a second and the
    layout would never settle. Refs are the standard way to feed a long-lived
    rAF loop from React state.
  */
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  const micRef = useRef(mic);
  micRef.current = mic;

  /*
    Is Operator actually working?

    The heart has to beat for something. Sound alone would make it a VU meter
    with ambitions — a thing that reacts to the room but not to itself. A turn
    running is the closest thing this system has to a thought in progress, so
    that is what quickens it.

    Polled here rather than through `useJobs`, which pulls full event logs
    every two seconds for a thread the map does not render. This needs one
    boolean.

    `/api/jobs` returns `authorised: false` when the terminal is disarmed. That
    is not an error and is not surfaced: the heart simply idles, which is
    honest — Operator is not running anything it will admit to.
  */
  const busyRef = useRef(false);
  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      if (typeof document !== "undefined" && document.hidden) return;
      try {
        const res = await fetch("/api/jobs", { headers: { accept: "application/json" } });
        const body = await res.json();
        if (stopped) return;
        const jobs: { status?: string }[] = Array.isArray(body?.jobs) ? body.jobs : [];
        busyRef.current =
          Boolean(body?.running) || jobs.some((j) => j.status === "running" || j.status === "queued");
      } catch {
        if (!stopped) busyRef.current = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 3000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, []);

  const view = useRef({ zoom: 1, panX: 0, panY: 0 });
  const pointer = useRef({
    x: 0,
    y: 0,
    down: false,
    dragging: null as Body | null,
    panning: false,
    lastX: 0,
    lastY: 0,
    moved: 0,
  });

  const edges = useMemo<Edge[]>(() => {
    const ids = new Set(active.map((m) => m.id));
    const out: Edge[] = [];
    for (const m of active) {
      for (const dep of m.dependsOn ?? []) {
        // A dependency on an archived or deleted mission is not drawn — the
        // Dashboard card reports those; a wall display should not show a line
        // going nowhere.
        if (ids.has(dep)) out.push({ from: dep, to: m.id });
      }
    }
    return out;
  }, [active]);

  /*
    Build bodies when the mission set changes, preserving the position of
    anything already on screen.

    Without the carry-over, ticking a mission's progress would teleport the
    whole web — every node reseeded to a new random spot for a change that
    should have moved nothing.
  */
  useEffect(() => {
    const previous = new Map(bodiesRef.current.map((b) => [b.id, b]));
    const degree = new Map<string, number>();
    for (const e of edges) {
      degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
      degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
    }
    bodiesRef.current = active.map((m, i) => {
      const kept = previous.get(m.id);
      const d = degree.get(m.id) ?? 0;
      // Seeded on a ring rather than at random: a random cloud can start with
      // two nodes on top of each other, and the repulsion needed to separate
      // them throws the whole web across the screen on the first frame.
      const angle = (i / Math.max(1, active.length)) * Math.PI * 2;
      return {
        id: m.id,
        mission: m,
        x: kept?.x ?? Math.cos(angle) * 240,
        y: kept?.y ?? Math.sin(angle) * 200,
        vx: kept?.vx ?? 0,
        vy: kept?.vy ?? 0,
        r: 26 + Math.min(14, d * 3),
        degree: d,
      };
    });
    edgesRef.current = edges;
  }, [active, edges]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let width = 0;
    let height = 0;
    /** Frames since mount — drives the core's rotation and heartbeat. */
    let tick = 0;

    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);

    // Particles travelling along the strands, from a mission to the ones that
    // wait on it. Direction is the information: it shows which way the board
    // actually flows, which a plain line cannot.
    const motes = Array.from({ length: 90 }, () => ({
      edge: Math.floor(Math.random() * Math.max(1, edgesRef.current.length)),
      t: Math.random(),
      speed: 0.0018 + Math.random() * 0.0032,
    }));

    const step = () => {
      const bodies = bodiesRef.current;
      const eds = edgesRef.current;
      const byId = new Map(bodies.map((b) => [b.id, b]));
      const v = voiceRef.current;
      const m = micRef.current;
      // The browser's own microphone wins when it is open: it is local, at
      // frame rate, and attached to the machine someone is actually at.
      const heard = m.active
        ? m.levelRef.current
        : v.listening
          ? Math.min(1, v.level / Math.max(0.004, v.threshold))
          : 0;
      const hearing = m.active ? heard > 0.12 : heard > 0.35;
      const lift = v.speaking ? 1 : hearing ? heard : 0;
      const accent = v.speaking ? VIOLET : GOLD;

      /* ---- physics ------------------------------------------------------ */
      for (let i = 0; i < bodies.length; i++) {
        const a = bodies[i];
        if (pointer.current.dragging === a) continue;
        for (let j = i + 1; j < bodies.length; j++) {
          const b = bodies[j];
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 1) {
            // Exactly coincident nodes produce a zero-length vector and the
            // force becomes NaN, which silently blanks the entire canvas.
            dx = Math.random() - 0.5;
            dy = Math.random() - 0.5;
            d2 = 1;
          }
          const d = Math.sqrt(d2);
          const min = a.r + b.r + 78;
          const force = (52000 / d2) * (d < min ? 2.4 : 1);
          const fx = (dx / d) * force;
          const fy = (dy / d) * force;
          a.vx -= fx;
          a.vy -= fy;
          if (pointer.current.dragging !== b) {
            b.vx += fx;
            b.vy += fy;
          }
        }
        // Gentle pull home so a disconnected mission cannot drift off screen
        // forever — with no edges nothing else would ever bring it back.
        a.vx -= a.x * 0.0016;
        a.vy -= a.y * 0.0016;

        /*
          Nothing sits on the core.

          The pull home and this push out settle every mission into a ring
          around the centre, which is the arrangement the whole idea depends
          on: the core is what they are all attached to, so it needs its own
          space rather than a node parked on top of it.
        */
        const fromCore = Math.hypot(a.x, a.y) || 1;
        if (fromCore < MIN_ORBIT) {
          const push = (MIN_ORBIT - fromCore) * 0.035;
          a.vx += (a.x / fromCore) * push;
          a.vy += (a.y / fromCore) * push;
        }
      }

      for (const e of eds) {
        const from = byId.get(e.from);
        const to = byId.get(e.to);
        if (!from || !to) continue;
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const d = Math.hypot(dx, dy) || 1;
        const rest = 210;
        const k = (d - rest) * 0.0042;
        const fx = (dx / d) * k;
        const fy = (dy / d) * k;
        if (pointer.current.dragging !== from) {
          from.vx += fx;
          from.vy += fy;
        }
        if (pointer.current.dragging !== to) {
          to.vx -= fx;
          to.vy -= fy;
        }
      }

      for (const b of bodies) {
        if (pointer.current.dragging === b) continue;
        b.vx *= 0.86;
        b.vy *= 0.86;
        const speed = Math.hypot(b.vx, b.vy);
        // Cap velocity. A dragged node flung hard can otherwise inject enough
        // energy to launch its neighbours off the canvas.
        if (speed > 14) {
          b.vx = (b.vx / speed) * 14;
          b.vy = (b.vy / speed) * 14;
        }
        b.x += b.vx;
        b.y += b.vy;
      }

      /* ---- paint -------------------------------------------------------- */
      ctx.globalCompositeOperation = "source-over";
      const bg = ctx.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, Math.max(width, height) * 0.75);
      bg.addColorStop(0, "#0D1119");
      bg.addColorStop(1, "#04060A");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, width, height);

      ctx.save();
      ctx.translate(width / 2 + view.current.panX, height / 2 + view.current.panY);
      ctx.scale(view.current.zoom, view.current.zoom);

      // Faint concentric rings — a horizon for the web to sit in, so the nodes
      // read as being somewhere rather than floating on nothing.
      ctx.globalCompositeOperation = "lighter";
      for (let i = 1; i <= 4; i++) {
        ctx.beginPath();
        ctx.arc(0, 0, i * 165, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(80,110,160,${0.035 + lift * 0.03})`;
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      const focus = hovered?.id ?? null;
      const near = new Set<string>();
      if (focus) {
        near.add(focus);
        for (const e of eds) {
          if (e.from === focus) near.add(e.to);
          if (e.to === focus) near.add(e.from);
        }
      }

      // Strands
      for (const e of eds) {
        const from = byId.get(e.from);
        const to = byId.get(e.to);
        if (!from || !to) continue;
        const lit = focus !== null && near.has(e.from) && near.has(e.to);
        const dim = focus !== null && !lit;
        const alpha = dim ? 0.06 : 0.16 + lift * 0.42 + (lit ? 0.4 : 0);
        const colour = lit ? GOLD : lift > 0 ? accent : ([90, 118, 158] as [number, number, number]);
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(to.x, to.y);
        ctx.strokeStyle = rgba(colour, alpha);
        ctx.lineWidth = (lit ? 2 : 1) + lift * 1.2;
        ctx.stroke();
      }

      // Motes riding the strands
      for (const mote of motes) {
        const e = eds[mote.edge % Math.max(1, eds.length)];
        if (!e) continue;
        const from = byId.get(e.from);
        const to = byId.get(e.to);
        if (!from || !to) continue;
        mote.t += mote.speed * (1 + lift * 2.5);
        if (mote.t > 1) {
          mote.t = 0;
          mote.edge = Math.floor(Math.random() * Math.max(1, eds.length));
        }
        const x = from.x + (to.x - from.x) * mote.t;
        const y = from.y + (to.y - from.y) * mote.t;
        ctx.beginPath();
        ctx.arc(x, y, 1.6 + lift, 0, Math.PI * 2);
        ctx.fillStyle = rgba(lift > 0 ? accent : GOLD, 0.5 + lift * 0.5);
        ctx.fill();
      }

      /* ---- the core ------------------------------------------------------
         Operator itself, at the centre of everything attached to it.

         Drawn by the shared `drawCore`, which the phone surface also uses, so
         the heartbeat cannot drift between the wall display and the thing in
         his pocket. The four states and the reasoning live there.
      */
      tick += 1;
      const busy = busyRef.current;
      drawCore(ctx, { tick, lift, speaking: v.speaking, busy, radius: CORE_R });

      // Nodes
      for (const b of bodies) {
        const m = b.mission;
        const colour = STATUS_COLOR[m.status] ?? STATUS_COLOR.not_started;
        const dim = focus !== null && !near.has(b.id);
        const isHover = hovered?.id === b.id;
        const a = dim ? 0.22 : 1;

        // Voice ring — an outline, never a filled disc. Filled haloes overlap
        // into fog; outlines cross each other and stay readable.
        if (lift > 0 && !dim) {
          ctx.beginPath();
          ctx.arc(b.x, b.y, b.r + 12 + lift * 22, 0, Math.PI * 2);
          ctx.strokeStyle = rgba(accent, 0.10 + lift * 0.34);
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }

        const glow = ctx.createRadialGradient(b.x, b.y, b.r * 0.5, b.x, b.y, b.r + 26);
        glow.addColorStop(0, rgba(colour, 0.30 * a));
        glow.addColorStop(1, rgba(colour, 0));
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r + 26, 0, Math.PI * 2);
        ctx.fill();

        ctx.globalCompositeOperation = "source-over";
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(6,9,14,${0.94 * a + 0.06})`;
        ctx.fill();

        ctx.globalCompositeOperation = "lighter";
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
        ctx.strokeStyle = rgba(colour, (isHover ? 1 : 0.8) * a);
        ctx.lineWidth = isHover ? 2.4 : 1.5;
        ctx.stroke();

        // Progress arc
        const pct = Math.max(0, Math.min(100, m.progress)) / 100;
        if (pct > 0) {
          ctx.beginPath();
          ctx.arc(b.x, b.y, b.r + 8, -Math.PI / 2, -Math.PI / 2 + pct * Math.PI * 2);
          ctx.strokeStyle = rgba(m.status === "blocked" ? STATUS_COLOR.blocked : GOLD, 0.95 * a);
          ctx.lineWidth = 3;
          ctx.lineCap = "round";
          ctx.stroke();
        }

        ctx.globalCompositeOperation = "source-over";
        ctx.textAlign = "center";
        ctx.fillStyle = `rgba(233,237,245,${a})`;
        ctx.font = "500 13px 'JetBrains Mono', ui-monospace, monospace";
        ctx.fillText(`${Math.round(pct * 100)}%`, b.x, b.y + 5);

        ctx.fillStyle = `rgba(196,205,222,${a})`;
        ctx.font = "13px Inter, system-ui, sans-serif";
        const label = m.name.length > 26 ? `${m.name.slice(0, 25)}…` : m.name;
        ctx.fillText(label, b.x, b.y + b.r + 24);
        ctx.globalCompositeOperation = "lighter";
      }

      ctx.restore();
      ctx.globalCompositeOperation = "source-over";
      raf = requestAnimationFrame(step);
    };

    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, [hovered]);

  /* ---- interaction ---------------------------------------------------- */

  const toWorld = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const { zoom, panX, panY } = view.current;
    return {
      x: (clientX - rect.left - rect.width / 2 - panX) / zoom,
      y: (clientY - rect.top - rect.height / 2 - panY) / zoom,
    };
  };

  const bodyAt = (clientX: number, clientY: number) => {
    const { x, y } = toWorld(clientX, clientY);
    return bodiesRef.current.find((b) => Math.hypot(b.x - x, b.y - y) <= b.r + 6) ?? null;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const hit = bodyAt(e.clientX, e.clientY);
    pointer.current.down = true;
    pointer.current.moved = 0;
    pointer.current.lastX = e.clientX;
    pointer.current.lastY = e.clientY;
    if (hit) pointer.current.dragging = hit;
    else pointer.current.panning = true;
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const dx = e.clientX - pointer.current.lastX;
    const dy = e.clientY - pointer.current.lastY;
    pointer.current.lastX = e.clientX;
    pointer.current.lastY = e.clientY;
    pointer.current.moved += Math.abs(dx) + Math.abs(dy);

    if (pointer.current.dragging) {
      const { x, y } = toWorld(e.clientX, e.clientY);
      const b = pointer.current.dragging;
      // Velocity carried from the pointer, so releasing mid-sweep throws the
      // node instead of dropping it dead.
      b.vx = x - b.x;
      b.vy = y - b.y;
      b.x = x;
      b.y = y;
      return;
    }
    if (pointer.current.panning) {
      view.current.panX += dx;
      view.current.panY += dy;
      return;
    }
    const hit = bodyAt(e.clientX, e.clientY);
    setHovered((prev) => (prev?.id === hit?.id ? prev : (hit?.mission ?? null)));
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const dragged = pointer.current.dragging;
    /*
      A click is a press that did not travel. Without the distance test,
      finishing a drag on top of a node opens that mission — which makes the
      map feel like it is fighting you.
    */
    if (dragged && pointer.current.moved < 6) navigate(`/missions/${dragged.id}`);
    pointer.current.down = false;
    pointer.current.dragging = null;
    pointer.current.panning = false;
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
  };

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    const next = view.current.zoom * (e.deltaY < 0 ? 1.12 : 0.89);
    view.current.zoom = Math.max(0.35, Math.min(3, next));
  };

  /*
    Fit everything on screen, rather than merely returning to 1:1.

    The first version reset zoom and pan to their defaults, which is not what
    "reset" means on a map you can throw nodes around: if you had flung one into
    the distance, the view snapped back to centre and the node was still off
    screen. Measuring the actual bounds and framing them does what the button
    says.
  */
  const fitView = () => {
    const canvas = canvasRef.current;
    const bodies = bodiesRef.current;
    if (!canvas || bodies.length === 0) {
      view.current = { zoom: 1, panX: 0, panY: 0 };
      return;
    }
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const b of bodies) {
      // Include the node's radius and its label, or the outermost one sits
      // half off the edge of a view that just told you it fitted.
      minX = Math.min(minX, b.x - b.r - 90);
      maxX = Math.max(maxX, b.x + b.r + 90);
      minY = Math.min(minY, b.y - b.r - 40);
      maxY = Math.max(maxY, b.y + b.r + 46);
    }
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const zoom = Math.max(0.35, Math.min(1.6, Math.min(w / (maxX - minX), h / (maxY - minY))));
    view.current = {
      zoom,
      panX: -((minX + maxX) / 2) * zoom,
      panY: -((minY + maxY) / 2) * zoom,
    };
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") navigate("/dashboard");
      // "r" as well as "0" — the hint was set in 10px mono and read as a "B".
      if (e.key === "0" || e.key === "r" || e.key === "R") fitView();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);

  const heard = voice.listening ? Math.min(1, voice.level / Math.max(0.004, voice.threshold)) : 0;
  const hearing = heard > 0.35;

  return (
    <div className="fixed inset-0 bg-[#04060A] overflow-hidden select-none">
      <canvas
        ref={canvasRef}
        className="w-full h-full touch-none"
        style={{ cursor: pointer.current.dragging ? "grabbing" : hovered ? "pointer" : "grab" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
        onWheel={onWheel}
      />

      {/* HUD */}
      <div className="absolute top-0 left-0 right-0 p-6 flex items-start justify-between pointer-events-none">
        <div>
          <h1 className="font-display text-lg text-ink-100 tracking-wide">MISSION MAP</h1>
          <p className="font-mono text-[11px] text-ink-600 mt-1">
            {active.length} active · {edges.length} {edges.length === 1 ? "link" : "links"}
          </p>
        </div>

        <div className="flex items-center gap-4">
          {voice.listening && (
            <span className="flex items-center gap-2 font-mono text-[11px] text-ink-500">
              <span
                className="w-1.5 h-1.5 rounded-full transition-all duration-150"
                style={{
                  background: voice.speaking ? "#8D7FE0" : "#E8B04D",
                  opacity: voice.speaking ? 1 : 0.3 + heard * 0.7,
                  transform: `scale(${voice.speaking ? 1.5 : 1 + heard * 0.8})`,
                }}
              />
              {voice.speaking ? "SPEAKING" : hearing ? "HEARING" : "LISTENING"}
            </span>
          )}
          {/*
            A real button, not a keyboard hint.

            "0 to reset" was set in 10px mono at the bottom of the screen and
            read as "B to reset" — which is a fair description of a control
            nobody can see.
          */}
          <MicSource mic={mic} voice={voice} choice={micChoice} onChoose={setMicChoice} className="pointer-events-auto" />
          <button
            onClick={fitView}
            className="pointer-events-auto font-mono text-[11px] text-ink-500 hover:text-ink-100 transition-colors border border-base-600 hover:border-base-500 rounded-badge px-3 py-1.5 min-h-[36px]"
          >
            RECENTRE
          </button>
          <button
            onClick={() => navigate("/dashboard")}
            className="pointer-events-auto font-mono text-[11px] text-ink-600 hover:text-ink-100 transition-colors border border-base-600 hover:border-base-500 rounded-badge px-3 py-1.5 min-h-[36px]"
          >
            ESC
          </button>
        </div>
      </div>

      {/*
        What it heard, under the core. Same component of the same feature as the
        phone, so the two cannot diverge — and placed above the chat rather than
        near it, because this is the map listening, not a message being composed.
      */}
      {mic.active && (
        <div className="absolute left-0 right-0 top-[58%] flex justify-center px-8 pointer-events-none select-none">
          <div className="max-w-xl text-center space-y-1">
            {transcript.lines.map((line, i) => {
              const age = transcript.lines.length - 1 - i;
              return (
                <p
                  key={`${i}-${line.slice(0, 12)}`}
                  className="text-sm leading-snug transition-opacity duration-500"
                  style={{ color: "rgba(196,205,222,1)", opacity: Math.max(0.12, 0.5 - age * 0.09) }}
                >
                  {line}
                </p>
              );
            })}
            <p className="font-mono text-[10px] text-ink-700/70">
              {transcript.working ? "transcribing…" : transcript.status}
            </p>
          </div>
        </div>
      )}

      {hovered && (
        <div className="absolute bottom-6 left-6 right-6 sm:right-auto sm:max-w-md card-base p-4 pointer-events-none animate-fade-up">
          <p className="font-display text-sm text-ink-100">{hovered.name}</p>
          {hovered.nextObjective && (
            <p className="text-xs text-ink-500 mt-1">Next: {hovered.nextObjective}</p>
          )}
          <p className="font-mono text-[11px] text-ink-600 mt-2">
            {hovered.status.replace("_", " ")} · {hovered.progress}% · click to open
          </p>
        </div>
      )}

      {/*
        The same chat as the phone, one component, so the two cannot drift.

        Centred and width-capped rather than edge-to-edge: a full-width input
        under a room-scale map reads as a footer, and this is meant to sit ON
        the map. `pointer-events-none` on the wrapper keeps the canvas
        draggable everywhere the chat is not.
      */}
      <div className="absolute bottom-6 left-0 right-0 flex justify-center px-6 pointer-events-none">
        <OperatorChat className="w-full max-w-2xl pointer-events-auto" heard={lastHeard} />
      </div>

      <p className="absolute bottom-6 right-6 font-mono text-[10px] text-ink-700 pointer-events-none hidden xl:block">
        drag a node · pan · scroll to zoom
      </p>
    </div>
  );
}
