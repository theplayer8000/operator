import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  exitFullscreen,
  onSummoned,
  reportMicState,
  summonWindow,
} from "@/lib/desktop";
import { useMissionBoard } from "@/hooks/useMissionBoard";
import { useKnowledge } from "@/hooks/useKnowledge";
import { useSpeech } from "@/hooks/useSpeech";
import { useVoiceActivity } from "@/hooks/useVoiceActivity";
import { readStorage, writeStorage } from "@/lib/storage";
import { useMicLevel } from "@/hooks/useMicLevel";
import { registerMic } from "@/lib/micBridge";
import { usePhoneTranscript } from "@/hooks/usePhoneTranscript";
import MicSource from "@/components/map/MicSource";
import type { KnowledgeNote, MissionRecord, MissionStatus } from "@/lib/types";
import { drawCore, rgba, GOLD, VIOLET, type Rgb } from "@/components/map/operatorCore";
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

/**
 * How much the layout OPENS UP as you zoom in, over and above the plain
 * magnification.
 *
 * A canvas zoom is an affine scale: every node grows and every gap grows by
 * exactly the same factor, so the composition is frozen and the picture reads
 * as an object being magnified rather than as a space you are moving into. The
 * owner: *"when u zoom in the nodes should spread out further and like expand
 * off screen... and the lines should stretch out too"*.
 *
 * So node POSITIONS get a multiplier that grows with the zoom while node RADII
 * stay exactly on the curve they were already on. Separation outruns size, the
 * strands between nodes stretch because they are drawn between those positions,
 * and the outermost nodes leave the viewport — which is what moving into a
 * space looks like rather than what enlarging a picture of one looks like.
 *
 * Logarithmic in the zoom RATIO rather than linear in the zoom, and both halves
 * of that matter because the range here is enormous — the vault fits at about a
 * tenth and the wheel goes to 3:
 *
 *   - a linear term would be imperceptible across the vault's useful range and
 *     violent across the mission map's,
 *   - a ratio is what the eye actually reads. One wheel notch multiplies the
 *     zoom by 1.12 whatever it started from, so a term in ln(z) opens the
 *     layout by the same amount per notch everywhere. Linear in z would make
 *     the notches near 3 six times the size of the notches near 0.5.
 *
 * Anchored on the FITTED zoom rather than on 1, because "zoomed in" only means
 * anything relative to the view that shows you everything, and that view is
 * ~0.1 for the vault and 1:1 for twelve missions. Below the anchor the
 * multiplier is pinned at 1, so zooming out converges back onto exactly the
 * compact layout `fitView` measured — and the fit stays honest, because at the
 * zoom it picks the spread is 1 by construction.
 *
 * The physics never sees this. It is applied where the projection is written
 * (`sx`/`sy`), which is the one place the whole file already agrees is the
 * position — so the drawn node, the strand endpoint and the hit test all move
 * together and cannot drift apart.
 */
const SPREAD_GAIN = 0.6;
/**
 * Finite by construction, like every other divide on this canvas.
 *
 * Only the vault comes near it (fitted 0.06 against a wheel that reaches 3 is a
 * ratio of 50, which is 3.35) and nothing misbehaves at the cap — it is here so
 * that a future change to either end of the zoom range cannot quietly turn a
 * node position into a five-figure coordinate.
 */
const SPREAD_MAX = 3.2;



/** Which graph is on screen. Three, and they share one renderer. */
type GraphSource = "missions" | "vault" | "agents";

interface Body {
  id: string;
  /*
    What this node IS, kept source-agnostic on purpose.

    The map draws two graphs now — missions, and the Knowledge Vault — and the
    renderer must not know which. Everything it needs to paint a node is on
    these four fields; `mission` and `note` are carried only so a click knows
    where to navigate. Branching on the source inside the draw loop is how one
    graph quietly ends up better-looking than the other.
  */
  label: string;
  /** Node colour: mission status, or note confidence. */
  tint: Rgb;
  /** 0-1 arc around the node. Mission progress; unused by notes. */
  ring: number;
  /** The small text in the middle. A percentage, or a link count. */
  badge: string;
  mission: MissionRecord | null;
  note: KnowledgeNote | null;
  x: number;
  y: number;
  /**
   * Depth. Zero in 2D, simulated in 3D.
   *
   * The physics treats it exactly like x and y — same repulsion, same springs
   * — because a graph laid out in three dimensions and then flattened is a
   * different picture from a flat graph with a z bolted on. In 2D it is eased
   * back to zero rather than ignored, so switching modes settles rather than
   * snapping.
   */
  z: number;
  vx: number;
  vy: number;
  vz: number;
  r: number;
  degree: number;
  /*
    Where this body actually lands on screen after projection, written once per
    frame before painting.

    Everything downstream — every arc, every strand, the hit test — reads these
    rather than x/y/r. In 2D they are copies; in 3D they carry the perspective.
    One place doing the projection is what stops the drawn position and the
    clickable position drifting apart, which is the classic way a 3D graph
    becomes unusable while looking fine.
  */
  sx: number;
  sy: number;
  sr: number;
  /** 0 far, 1 near. Drives brightness and draw order. */
  depth: number;
  /**
   * Worth labelling on a crowded graph.
   *
   * Decided against the DISTRIBUTION rather than a fixed number. The first
   * attempt was `degree > 3`, which is a sensible-looking threshold and
   * labelled all 315 notes, because the average degree turned out to be 10.5 —
   * an absolute cutoff cannot know that. A rank does.
   */
  landmark: boolean;
  /**
   * How many links from the core this node sits.
   *
   * 0 is a hub — one of the most connected notes, which is what the core
   * attaches to. 1 is anything linked to a hub, 2 anything linked to those.
   * A breadth-first distance over the real link graph, not a guess: the shells
   * you see are the actual shape of what is connected to what.
   */
  tier: number;
}

/**
 * One job, as `/api/jobs` reports it.
 *
 * Only the fields the graph draws. The endpoint returns more — session ids,
 * costs, resources — and pulling them in here would make this a second,
 * competing model of a job alongside `useJobs`, which the Orchestrator owns.
 * This is a VIEW of work in flight, not a place jobs live.
 */
interface JobSummary {
  id: string;
  title?: string;
  provider?: string;
  model?: string;
  status?: string;
  turns?: number;
  asking?: number;
  queued?: number;
  error?: string | null;
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
    The page speaks too, not only the chat.

    A confirmation of something the SERVER did never passes through the chat —
    no job, no reply, nothing for the chat to read out. `useSpeech` is a hook
    over module-level state, so a second caller shares the same element, the
    same enabled flag and the same one-at-a-time rule as the chat's.
  */
  const speech = useSpeech();
  /** An answer Operator had ready but could not say aloud, because it is muted. */
  const [mutedReply, setMutedReply] = useState<string | null>(null);
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

  /*
    A clap opens the microphone here too.

    The clap already summons the window and records through the SERVER's
    microphone. But the page listens through its own, and he had to reach over
    and press MIC — "make the clap activate the mic fgs". The clap count from
    `/api/listen` rises on every gesture, so watching it is enough.

    One honest limit: browsers require a user gesture to open a microphone the
    FIRST time. Once permission has been granted for this origin it can be
    reopened without one, which is the case that matters — but on a fresh
    browser profile the first clap will still need a tap.
  */
  /*
    `null`, NOT 0 — and that distinction is the whole bug this had.

    `state.claps` on the server is a running total that RESETS TO ZERO when the
    server restarts. Using 0 as "I have not read a count yet" therefore made the
    two states indistinguishable: after every restart the first real clap
    arrived as `claps: 2`, was read as the initial sync, and was swallowed. It
    then worked on the second clap, which is exactly the sort of intermittency
    that reads as "the clap detector is flaky" when the detector was fine.
  */
  const lastClaps = useRef<number | null>(null);
  useEffect(() => {
    if (voice.claps === lastClaps.current) return;
    const firstReading = lastClaps.current === null;
    lastClaps.current = voice.claps;
    /*
      Skip only the genuine first reading — learning where the counter already
      is, rather than reacting to claps that happened before this page loaded.
    */
    if (firstReading) return;

    /*
      A clap summons the WINDOW when Operator is behind something else, and does
      nothing at all when it is already in front.

      His refinement, and it is better than what was here: clapping while
      looking at Operator should do nothing, because there is nothing to
      summon — and a window raising itself when it is already focused is a
      flicker rather than a feature.

      Note this no longer opens the microphone. A clap can only be HEARD if
      something is already listening, so "clap to turn the mic on" was
      circular except in the one case where the server's own microphone heard
      it. Arming is a deliberate act: the tray, or the picker.
    */
    if (typeof document !== "undefined" && document.hasFocus()) return;
    console.log(`[operator] clap heard (${voice.claps}) — summoning`);
    void summonWindow();
  }, [voice.claps, mic]);
  /*
    Remembered across reloads.

    It was deliberately not persisted at first, on the grounds that a
    preference which spends money should be a fresh decision each session. In
    use that was just annoying — he turned it on, navigated away, came back and
    it was off, which reads as the toggle being broken rather than cautious.
    His call, and he has lived with it: "set it so that it remembers".
  */
  /*
    Flat or solid, remembered per device.

    A MODE, not a replacement — the owner's own call and the right one. Three
    dimensions look better in a screenshot and read worse when you are trying
    to find something: nodes occlude each other and an edge running away from
    you is indistinguishable from one running towards you. Obsidian ships both
    and most people use the flat one.

    Per device rather than in the store, like the speech preference: the wall
    display and a laptop are different arguments about the same graph.
  */
  /*
    WHICH graph, remembered per device.

    Two axes, and they are genuinely independent: this one is the SOURCE and
    `solid` is the projection. The owner expected them to be one control and
    they are not — a flat vault graph and a solid mission graph are both
    sensible things to want, and folding them together would remove two of the
    four views to make one button.

    Missions is the default because it is what this page was, and a landing
    page should not change under someone.
  */
  const [source, setSourceState] = useState<GraphSource>(() => {
    const wanted = new URLSearchParams(window.location.search).get("graph");
    if (wanted === "vault" || wanted === "missions" || wanted === "agents") return wanted;
    const saved = readStorage<string>("map.source", "missions");
    return saved === "vault" || saved === "agents" ? saved : "missions";
  });
  /** Which graph the view was last fitted to, so a resync does not re-fit. */
  const fittedFor = useRef<string | null>(null);
  /*
    Where the camera is HEADING, as distinct from where it is.

    The view used to be set directly, which is right for RECENTRE — you asked
    for it, you get it now. It is wrong for switching to the vault: 315 notes
    arrive on top of each other and blow outwards over a couple of seconds, and
    a single fit either happens too early (framing the seed ring) or snaps the
    camera after the fact.

    The owner's ask: "a live view of it zooming out, more dynamicness". So the
    camera has a target it eases towards, and while the layout is still
    expanding the target is recomputed every frame — you watch it pull back.
  */
  const viewTarget = useRef({ zoom: 1, panX: 0, panY: 0 });
  /**
   * The zoom `fitView` last chose — the anchor the layout spread is measured
   * from.
   *
   * 1 rather than 0 as the default, because the mission map deliberately opens
   * at 1:1 and is never fitted on first load: for that view, 1 IS the fitted
   * zoom, and anchoring anywhere else would make the map he looks at most open
   * already spread.
   */
  const fitZoom = useRef(1);
  /*
    Has the app framed this graph itself yet?

    Auto scaling is only allowed once it has. Without this guard the passive
    rule below fires on frame 0 of the mission map — `follow` is 0 by design on
    first load, nothing has been framed, and a layout slightly larger than the
    window is the normal case — which zooms the landing page out and undoes
    `00b1125`, the fix for "its js frozen lol on mission flat". It was not
    frozen; it had been fitted small.

    The vault sets this immediately (it always fits). Missions sets it when you
    come back from another graph, or on RECENTRE. So the 1:1 opening survives
    exactly as long as nobody has asked for anything else.
  */
  const hasFitted = useRef(false);
  /**
   * Has he framed the view HIMSELF since the last automatic fit?
   *
   * Auto scaling and "leave it where he put it" are the same question asked
   * twice, and this is the answer to both. Nothing reframes a view he aimed;
   * everything is free to reframe one he never touched. Dragging a node is
   * deliberately not framing — moving a body around the graph is not a
   * statement about where the camera should be.
   */
  const userFramed = useRef(false);
  /** Frames of automatic following left. Any manual gesture zeroes it. */
  const follow = useRef(0);
  /*
    How hard the layout is still allowed to move. 1 when a graph is new,
    decaying to a floor.

    This is annealing, and without it a force-directed layout of this size never
    settles: repulsion pushes outward, the pull home is deliberately weak so the
    graph does not collapse into a hairball, and the balance between them sits
    tens of thousands of units out. So it expands for as long as you watch it —
    the owner's "the chart spangles / spazzes" after the camera stopped
    following, which was the layout still growing under a camera that had
    stopped keeping up.

    Cooling is how every force-directed layout converges. The floor is not zero
    on purpose: a graph frozen solid stops responding to a dragged node, and
    being able to grab one and have the web reorganise is the point of the map.
  */
  const heat = useRef(1);
  /** Read by the pointer handlers, which are registered once. */
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const setSource = (next: GraphSource) => {
    setSourceState(next);
    writeStorage("map.source", next);
  };
  const vault = useKnowledge();

  const [solid, setSolidState] = useState(() => {
    /*
      `?solid=1` wins over the stored preference, once, on load.

      Two reasons, and the second is why it is worth the four lines: a view
      mode you can link to is a view mode you can put in a message or a
      bookmark, and it is the only way `scripts/render.mjs` can screenshot this
      mode at all — the renderer drives a fresh browser profile with no
      localStorage to have set.
    */
    const wanted = new URLSearchParams(window.location.search).get("solid");
    if (wanted !== null) return wanted !== "0" && wanted !== "false";
    return readStorage("map.solid", false);
  });
  const setSolid = (next: boolean) => {
    setSolidState(next);
    writeStorage("map.solid", next);
  };
  /*
    Read inside the animation loop, which is registered once and must not be
    torn down to learn about a toggle — restarting it would reset the
    simulation, and the whole point of easing between the two modes is that it
    is visibly the same graph settling.
  */
  const solidRef = useRef(solid);
  solidRef.current = solid;
  /** Yaw, carried across frames so the rotation survives a re-render. */
  const spin = useRef(0);
  /**
   * Camera pitch, and whether the owner has taken hold of it.
   *
   * Right-drag orbits in solid mode. Once he has aimed it, the automatic yaw
   * stops: a view that keeps turning after you pointed it somewhere is a view
   * you cannot aim.
   */
  const tilt = useRef(0.34);
  const steered = useRef(false);

  const [autoSend, setAutoSendState] = useState(() => readStorage("voice.autoSend", false));
  const setAutoSend = (next: boolean) => {
    setAutoSendState(next);
    writeStorage("voice.autoSend", next);
  };
  // `voice.speaking` is read from speechSynthesis and the audio element, so it
  // covers Kokoro and the fallback voice alike.
  const transcript = usePhoneTranscript(mic, mic.active, voice.speaking);
  /*
    A sentence the server already acted on must not also go to the chat.

    `server/intent.mjs` handles "tick off bench press" in microseconds with no
    model involved. Passing it to the chat as well would send it to a worker,
    which would do the same write a second time — at Claude's price, and
    possibly UNDOING it, since every tick action is a toggle.

    The confirmation is spoken instead, so he hears WHICH thing changed and can
    catch a wrong match while it is one tap to reverse.
  */
  /*
    The desktop shell, when there is one.

    Two things only, both from ADR 0015's list of what a browser refused:

    - **Summoned.** Ctrl+Alt+O or the tray brings the window back, and the shell
      emits an event rather than doing anything to the microphone itself. The
      mic belongs to `useMicLevel`, and a second owner in Rust would be two
      things fighting over one device — exactly how the desktop clap detector
      broke.
    - **Mic state to the tray.** The ADR made "off by default and visibly so" a
      condition of having a desktop client at all, and only the page knows
      whether a stream is actually open.

    Both no-op in a browser, so the phone never learns this exists.
  */
  useEffect(() => {
    let stop = () => {};
    void onSummoned(() => {
      /*
        Summoning does NOT open the microphone. Being on screen and being
        listened to are different things, and conflating them is how a machine
        ends up recording because a window was raised.

        It puts the cursor in the chat instead, so the hotkey lands you ready to
        type or to press the mic yourself. Found by role rather than by a ref
        because the input belongs to OperatorChat, and threading a ref up through
        two pages to focus one field would be more coupling than the feature is
        worth.
      */
      const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
        'input[placeholder^="Ask Operator"], textarea[placeholder^="Ask Operator"]',
      );
      input?.focus();
    }).then((off) => {
      stop = off;
    });
    return () => stop();
  }, []);

  useEffect(() => {
    void reportMicState(mic.active, voice.listening);
  }, [mic.active, voice.listening]);

  /*
    The tray's microphone line, which is the control that makes the rest usable.

    His words: *"i cant toggle microphone on or off and if i could that would
    make it all work"* — with the mic on and the window behind something else, a
    clap or the hotkey brings Operator back. Without a way to arm it from
    outside the window, the whole out-of-focus story needs the window first.

    The tray asks and the page acts, so there is still exactly one owner of the
    device.
  */
  /*
    Registered ONCE, and reading the current mic through a ref.

    The first version depended on `[mic]`, and `useMicLevel` returns a fresh
    object every render — so the effect tore the listener down and rebuilt it
    constantly. `listen()` is async, so during each gap there was no listener at
    all, and clicking the tray did nothing most of the time. That is why the
    toggle "didn't seem to work".
  */
  /*
    Both read inside listeners that register once, so the values are current
    without the effect depending on them. A ref for `mic` already exists further
    down for the render loop; this one is declared here because the tray
    listener is set up above it, and two refs holding the same object is
    cheaper than reordering a file around a subscription.
  */

  /*
    The listeners themselves moved to `AppLayout` on 2026-09-02, because a
    global hotkey that only fires on two routes is not a global hotkey — see
    `lib/micBridge.ts`. This page keeps what only it can have: the stream.

    Registered on every render rather than in an effect. `mic` is a fresh object
    each time, and a subscription keyed on that identity is precisely the churn
    that made the tray look broken the first time round; an assignment has no
    teardown to get wrong.
  */
  registerMic(mic);
  useEffect(() => () => registerMic(null), []);

  const spokenFor = useRef<string | null>(null);
  useEffect(() => {
    const heard = transcript.last;
    if (!heard || heard.text === spokenFor.current) return;
    spokenFor.current = heard.text;
    /*
      Stop means stop talking, too.

      He says it while Operator is mid-sentence — that is the whole reason the
      overlapped audio is uploaded at all. Cancelling the jobs and then
      finishing the paragraph he interrupted would read as ignoring him.
    */
    if (heard.stopped) {
      speech.stop();
      return;
    }
    if (!heard.handled || !heard.say) return;

    /*
      Muted is not the same as broken, and the difference has to be visible.

      Operator answered a spoken question correctly and said nothing, because
      `speech.enabled` defaults to OFF and is stored per device — and the
      desktop shell is a different storage profile from the browser, so turning
      it on in Edge does nothing for the Tauri window. From the owner's side
      that reads as the feature failing: *"why didnt it speak out loud"*.

      So when there is something to say and it cannot be said, the reason goes
      on screen next to the answer rather than being swallowed.
    */
    if (!speech.enabled) {
      setMutedReply(heard.say);
      return;
    }
    setMutedReply(null);
    speech.speak(heard.say);
  }, [transcript.last, speech]);

  const lastHeard = transcript.lines.length
    ? transcript.lines[transcript.lines.length - 1]
    : null;

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const bodiesRef = useRef<Body[]>([]);
  /*
    Ring radii sized to their populations, and the repulsion cutoff that follows
    from them. Computed once when the layout is built rather than per frame —
    it depends only on the tier histogram, which does not change between
    rebuilds, and the physics loop runs sixty times a second.

    The defaults are the old fixed ladder, so a graph that has not been built
    yet behaves exactly as before rather than collapsing to zero.
  */
  const spreadRef = useRef<{ ringRadius: number[]; cutoff: number }>({
    ringRadius: Array.from({ length: 13 }, (_, t) => MIN_ORBIT * 0.7 + t * 190),
    cutoff: 620,
  });
  const edgesRef = useRef<Edge[]>([]);
  const [hovered, setHovered] = useState<MissionRecord | null>(null);
  /*
    The render loop reads hover through a ref, not the dependency array.

    It used to be `useEffect(..., [hovered])`, so moving the mouse over a
    mission tore the whole animation loop down and rebuilt it — re-running
    resize and re-seeding ninety particles, sixty times a second while the
    cursor moved. That is what made dragging feel like it "does f all": the
    loop was restarting underneath the drag.
  */
  const hoveredRef = useRef<MissionRecord | null>(null);
  hoveredRef.current = hovered;

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
  /*
    How many turns are running, not merely whether any are.

    A boolean was honest while one ran at a time. With OPERATOR_MAX_CONCURRENT
    above 1 it stops being: three turns and one look identical, and a display
    whose whole job is telling him what Operator is doing should not flatten
    "thinking" and "thinking about three things at once" into the same picture.
  */
  const busyRef = useRef(0);
  const [busyCount, setBusyCount] = useState(0);
  /*
    The jobs themselves, not merely how many.

    The same poll already ran for the heartbeat; keeping its result costs
    nothing and is what the AGENTS graph draws. State rather than a ref,
    because unlike the heartbeat this has to rebuild the node list — and the
    rebuild preserves positions by id, so a job appearing does not move
    everything else.
  */
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      if (typeof document !== "undefined" && document.hidden) return;
      try {
        const res = await fetch("/api/jobs", { headers: { accept: "application/json" } });
        const body = await res.json();
        if (stopped) return;
        const jobs: JobSummary[] = Array.isArray(body?.jobs) ? body.jobs : [];
        /*
          Replaced only when something actually differs.

          A three-second poll that sets state unconditionally re-renders the
          page twenty times a minute forever, and every one of those rebuilds
          the node list. Comparing the shape that is drawn — id, status, turns,
          questions waiting — means an idle Operator costs nothing.
        */
        const shape = (list: JobSummary[]) =>
          list.map((j) => `${j.id}:${j.status}:${j.turns}:${j.asking}`).join("|");
        setJobs((prev) => (shape(prev) === shape(jobs) ? prev : jobs));
        /*
          `runningIds` where the server offers it, falling back to counting
          statuses. Queued jobs count too: from here "Operator has work" is the
          honest reading, and a queued turn is work he asked for that has not
          finished.
        */
        const ids: string[] = Array.isArray(body?.runningIds) ? body.runningIds : [];
        const next = ids.length
          ? ids.length + jobs.filter((j) => j.status === "queued").length
          : jobs.filter((j) => j.status === "running" || j.status === "queued").length;
        busyRef.current = next;
        setBusyCount((prev) => (prev === next ? prev : next));
      } catch {
        if (!stopped) {
          busyRef.current = 0;
          setBusyCount(0);
          // Unreachable or unauthorised is not "no jobs" — but an empty graph
          // is the honest picture of what this page can currently see.
          setJobs((prev) => (prev.length ? [] : prev));
        }
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

  /**
   * The layout multiplier at a given zoom. See `SPREAD_GAIN`.
   *
   * A pure function of two refs, so it can be called from the animation loop
   * and from a pointer handler and give the same answer in the same frame —
   * which is the whole requirement, because one of those draws the node and
   * the other decides which node you grabbed.
   */
  const spreadAt = (zoom: number) =>
    Math.min(
      SPREAD_MAX,
      1 + SPREAD_GAIN * Math.log(Math.max(1, zoom / Math.max(0.01, fitZoom.current))),
    );

  /**
   * How far out the view may go — and it has to be ONE number.
   *
   * It was two, and they disagreed: the wheel floor moved to 0.06 on a big
   * graph (the comment on `onWheel` records why) while `fitView` kept clamping
   * at 0.3, so RECENTRE on the vault framed a web three times too large for the
   * window and the button could not reach a view the wheel could. A floor is
   * the point past which zooming out stops being useful, and that has to mean
   * the same thing to every caller.
   */
  const zoomFloor = () => (bodiesRef.current.length > 40 ? 0.06 : 0.35);

  const pointer = useRef({
    x: 0,
    y: 0,
    down: false,
    /*
      The dragged node's ID, not the object.

      `bodiesRef.current` is rebuilt whole whenever the mission array changes
      identity, which `useRemoteStorage` causes on every sync — a second or two
      apart. Holding the object meant the drag silently became an orphan at the
      next sync: moving it updated something nothing rendered, and every
      `dragging === b` check stopped matching so the real node went back under
      physics. Exactly "click, wait a second or two, then drag, nothing
      happens". An id survives the rebuild because positions are carried over.
    */
    dragging: null as string | null,
    panning: false,
    /** A right-drag in solid mode turns the camera rather than sliding it. */
    orbiting: false,
    lastX: 0,
    lastY: 0,
    moved: 0,
  });

  /*
    The nodes, from whichever source is showing, reduced to what the graph
    needs and nothing else.

    Both shapes are already directional edge lists over a set of records with
    ids, which is why one renderer serves both: a mission's `dependsOn` and a
    note's `links` are the same structure with different names.
  */
  const nodes = useMemo(() => {
    if (source === "agents") {
      /*
        What Operator is doing right now.

        Two kinds of node, and the WORKER nodes are what make this a graph
        rather than a list. A job on its own says "something is running"; a job
        attached to claude-code, next to three attached to airouter, says where
        the work actually is — which is the question a control plane exists to
        answer and the reason the owner asked for a graph rather than a table.

        The workers are hardcoded rather than fetched. `providers.mjs` decides
        which are registered and there is no endpoint that lists them; a worker
        with no jobs simply draws no node, which is the honest picture anyway.
      */
      const workers = new Map<string, { id: string; label: string; count: number }>();
      const jobNodes = jobs.map((j) => {
        const provider = j.provider || "unknown";
        const wid = `worker:${provider}`;
        const w = workers.get(wid) || { id: wid, label: provider, count: 0 };
        w.count += 1;
        workers.set(wid, w);
        return {
          id: `job:${j.id}`,
          label: j.title || j.id,
          // The job hangs off its worker; the worker hangs off the core.
          links: [wid],
          mission: null,
          note: null,
          job: j,
          worker: null,
          // One ring out from the worker running it.
          tier: 1,
        };
      });

      return [
        ...Array.from(workers.values()).map((w) => ({
          id: w.id,
          label: `${w.label} · ${w.count}`,
          links: [] as string[],
          mission: null,
          note: null,
          job: null,
          worker: w,
          /*
            Agents state their ring rather than having it inferred.

            The tier maths derives rings from degree, which is right for the
            vault — the hubs genuinely are the most connected notes. It is
            wrong here: with one worker and one job both have degree 1, so both
            landed in ring 0 and the edge between them cut straight through the
            core. The structure is known in advance, so it should be declared.
          */
          tier: 0,
        })),
        ...jobNodes,
      ];
    }

    if (source === "vault") {
      /*
        A ceiling on how many notes the graph draws.

        Not a rendering trick — a legibility one. Past a few hundred nodes a
        force-directed graph stops being a picture of structure and becomes a
        picture of density, and every additional node makes the ones that
        matter harder to find rather than easier.

        The ones kept are the most connected, which are the ones you navigate
        by. `?limit=` overrides it, so the ceiling can be tested and raised
        deliberately rather than guessed at.
      */
      const override = Number(new URLSearchParams(window.location.search).get("limit"));
      const cap = Number.isFinite(override) && override > 0 ? override : 220;
      const degree = new Map<string, number>();
      const ids = new Set(vault.active.map((n) => n.id));
      for (const n of vault.active) {
        for (const l of n.links ?? []) {
          if (!ids.has(l)) continue;
          degree.set(n.id, (degree.get(n.id) ?? 0) + 1);
          degree.set(l, (degree.get(l) ?? 0) + 1);
        }
      }
      const kept =
        vault.active.length <= cap
          ? vault.active
          : [...vault.active]
              .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0))
              .slice(0, cap);
      return kept.map((n) => ({
        id: n.id,
        label: n.title,
        links: n.links ?? [],
        mission: null,
        note: n,
        job: null,
        worker: null,
        tier: undefined as number | undefined,
      }));
    }
    return active.map((m) => ({
      id: m.id,
      label: m.name,
      links: m.dependsOn ?? [],
      mission: m,
      note: null,
      job: null,
      worker: null,
      tier: undefined as number | undefined,
    }));
  }, [source, active, vault.active, jobs]);

  const edges = useMemo<Edge[]>(() => {
    const ids = new Set(nodes.map((n) => n.id));
    const out: Edge[] = [];
    for (const n of nodes) {
      for (const dep of n.links) {
        // An edge to something archived or deleted is not drawn — a wall
        // display should not show a line going nowhere.
        if (ids.has(dep)) out.push({ from: dep, to: n.id });
      }
    }
    return out;
  }, [nodes]);

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
    /*
      The label budget, by rank.

      Roughly two dozen names is what a screen this size can show without them
      colliding, and which two dozen should follow how connected they are — the
      hubs are what you navigate by. Everything else keeps its node and gets its
      name on hover.

      A rank rather than a threshold, because a threshold has to guess the
      distribution and will be wrong for any vault but the one it was tuned on.
    */
    /*
      Which notes the core is attached to, and how far everything else is from
      those.

      The owner's read of the vault graph: "i thought it would be more circler
      and constraintive of the core it kinda wraps around it but doesnt
      represent properly ... maybe im looking for all origin points to come
      from the core".

      He is right, and the mission map is why: there, missions ORBIT — a push
      out of the middle and a pull home put them in a ring, so they read as
      attached to the thing at the centre. The vault had neither, so the core
      sat in a cloud it was not part of.

      The core attaches to the HUBS — the most connected notes — and everything
      else is placed by its breadth-first distance from one. That is not a
      decorative choice: distance-from-a-hub is a real property of the link
      graph, so the rings mean something rather than merely looking tidy.
    */
    const HUBS = 8;
    const hubs = [...degree.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, HUBS)
      .map(([id]) => id);

    const tier = new Map<string, number>();
    const neighbours = new Map<string, string[]>();
    for (const e of edges) {
      (neighbours.get(e.from) ?? neighbours.set(e.from, []).get(e.from))!.push(e.to);
      (neighbours.get(e.to) ?? neighbours.set(e.to, []).get(e.to))!.push(e.from);
    }
    let frontier = hubs;
    for (const id of hubs) tier.set(id, 0);
    let depth = 0;
    while (frontier.length > 0 && depth < 12) {
      depth += 1;
      const next: string[] = [];
      for (const id of frontier) {
        for (const other of neighbours.get(id) ?? []) {
          if (tier.has(other)) continue;
          tier.set(other, depth);
          next.push(other);
        }
      }
      frontier = next;
    }

    /*
      How big each ring has to be to actually hold what lands on it.

      ## The bug this replaces

      The ring was `MIN_ORBIT * 0.7 + tier * 190` — a fixed ladder that took no
      account of how many nodes ended up on each rung. Measured against the real
      vault on 2026-09-05:

        tier 1: 154 nodes, ring r=354, circumference 2227, needs ~15400  (6.9x)
        tier 2: 229 nodes, ring r=544, circumference 3421, needs ~22900  (6.7x)
        tier 3: 190 nodes, ring r=734, circumference 4615, needs ~19000  (4.1x)

      Nearly seven times more nodes than the circle has room for, held there by a
      two-sided radial pull that is firmer than the repulsion trying to separate
      them. That is the hairball — not a missing force, an impossible instruction.
      It never showed up on the mission map because twelve nodes fit anywhere.

      BFS from the eight biggest hubs over a graph averaging eight links a note
      reaches nearly everything within three hops, so the middle tiers are always
      where the crowd is. The ladder had to be a function of the crowd.

      ## What it does instead

      Each ring is pushed out until its circumference can hold its own
      population, and never closer than MIN_GAP to the ring inside it. So a tier
      with six notes sits just outside its parent, and a tier with two hundred
      gets the radius two hundred notes need — the shells stay meaningful and
      stop being a promise the geometry cannot keep.
    */
    const ARC_PER_NODE = 118;
    const MIN_RING_GAP = 190;
    const tierCounts: number[] = [];
    for (const t of tier.values()) tierCounts[t] = (tierCounts[t] ?? 0) + 1;
    const ringRadius: number[] = [];
    for (let t = 0; t < Math.max(tierCounts.length, 13); t += 1) {
      const count = tierCounts[t] ?? 0;
      const needed = (count * ARC_PER_NODE) / (2 * Math.PI);
      const floor = t === 0 ? MIN_ORBIT * 0.7 : ringRadius[t - 1] + MIN_RING_GAP;
      ringRadius[t] = Math.max(floor, needed);
    }
    /*
      The repulsion cutoff has to reach across a ring, or nodes on opposite sides
      of one never learn about each other and the ring cannot inflate. The old
      constant was 620 — smaller than tier 3's radius, so the force meant to
      spread the crowd was switched off exactly where the crowd was.
    */
    spreadRef.current = {
      ringRadius,
      cutoff: Math.max(620, (ringRadius[Math.min(2, ringRadius.length - 1)] ?? 620) * 1.6),
    };

    const LABEL_BUDGET = 24;
    const labelled = new Set(
      [...degree.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, LABEL_BUDGET)
        .map(([id]) => id),
    );

    bodiesRef.current = nodes.map((n, i) => {
      const m = n.mission;
      const kept = previous.get(n.id);
      const d = degree.get(n.id) ?? 0;
      // Seeded on a ring rather than at random: a random cloud can start with
      // two nodes on top of each other, and the repulsion needed to separate
      // them throws the whole web across the screen on the first frame.
      const angle = (i / Math.max(1, nodes.length)) * Math.PI * 2;
      /*
        A note's colour is its CONFIDENCE, which is the field the vault lives
        or dies on — a graph where you can see at a glance how much of what you
        wrote down you have actually checked is worth far more than one where
        every node is the same gold. Reusing the mission palette on purpose:
        `vital-down` for unverified, gold for worked, `vital-up` for verified,
        which is the same red-amber-green the rest of the app already means.
      */
      /*
        A job's colour is its STATUS, and the one that matters most is amber.

        `asking` means a turn is suspended on a permission question and will
        die after thirty minutes if nobody answers (ADR 0012). On a display
        whose whole job is telling him what Operator is doing, that is the one
        state worth interrupting for — so it takes the accent, and running
        takes violet like the speaking core does.
      */
      const jobTint: Rgb = n.job
        ? (n.job.asking ?? 0) > 0
          ? [232, 176, 77]
          : n.job.status === "running"
            ? [141, 127, 224]
            : n.job.status === "queued"
              ? [122, 134, 158]
              : n.job.error || n.job.status === "failed"
                ? [224, 90, 90]
                : [78, 216, 138]
        : STATUS_COLOR.not_started;

      const noteTint: Rgb = n.note
        ? n.note.confidence === "verified"
          ? [78, 216, 138]
          : n.note.confidence === "works"
            ? [232, 176, 77]
            : [224, 90, 90]
        : STATUS_COLOR.not_started;

      return {
        id: n.id,
        label: n.label,
        tint: m
          ? (STATUS_COLOR[m.status] ?? STATUS_COLOR.not_started)
          : n.job
            ? jobTint
            : n.worker
              // A worker is scaffolding, not a result. Neutral, so the jobs
              // hanging off it are what the eye goes to.
              ? ([122, 134, 158] as Rgb)
              : noteTint,
        // Notes have no progress, so no arc. Their badge is how connected they
        // are, which is the equivalent question for a vault: a note nothing
        // links to is one you will never arrive at by accident.
        /*
          A job has no percentage — nothing knows how far through a turn is —
          so the arc is used for something it CAN say: a full ring while
          running, nothing otherwise. Motion in the strands carries the rest.
        */
        ring: m
          ? Math.max(0, Math.min(100, m.progress)) / 100
          : n.job && n.job.status === "running"
            ? 1
            : 0,
        badge: m
          ? `${Math.round(Math.max(0, Math.min(100, m.progress)))}%`
          : n.job
            ? String(n.job.turns ?? 0)
            : n.worker
              ? String(n.worker.count)
              : String(d),
        mission: m,
        note: n.note,
        x: kept?.x ?? Math.cos(angle) * 240,
        y: kept?.y ?? Math.sin(angle) * 200,
        /*
          Seeded off-plane, and not randomly — spread around the same ring the
          x/y seed uses, so the starting shape is a tilted disc rather than a
          cloud. Starting everything at z = 0 would give the repulsion nothing
          to push apart in depth, and the layout would stay flat for the first
          few hundred frames before slowly inflating, which reads as the 3D
          toggle not working.
        */
        z: kept?.z ?? Math.sin(angle * 2.3) * 120,
        vx: kept?.vx ?? 0,
        vy: kept?.vy ?? 0,
        vz: kept?.vz ?? 0,
        /*
          Smaller in the vault, and it has to be.

          Twelve missions at r=26 fills a wall display; 313 notes at the same
          size is a solid sheet with no gaps to see structure through. Size
          still follows degree — the well-connected notes are the landmarks you
          navigate by — but the floor and the ceiling both come down.
        */
        /*
          Notes are small, and the numbers matter.

          The first attempt was `9 + min(11, d * 1.4)`. With 1,651 links over
          313 notes the average degree is 10.5, so d * 1.4 clears the cap for
          almost every node and they ALL came out at exactly 20 — no size
          variation at all, and a minimum separation of 20 + 20 + 78 that the
          repulsion could never satisfy in the space available.

          Scaled to the real distribution instead, and capped low enough that
          the well-connected notes read as landmarks rather than as everything
          being the same.
        */
        /*
          Workers are big because they are landmarks; jobs are mid-sized
          because there are rarely many and each one is worth reading. Only the
          vault needs the small end — see the note on its density.
        */
        r: m
          ? 26 + Math.min(14, d * 3)
          : n.worker
            ? 30
            : n.job
              ? 18
              : 6 + Math.min(9, Math.sqrt(d) * 2.4),
        degree: d,
        // Agents are never crowded — a handful of nodes, every one of which
        // you want named. Only the vault has to ration labels.
        landmark: n.note ? labelled.has(n.id) : true,
        /*
          Unreachable notes get the outer shell rather than tier 0.

          A note with no links at all has no distance from a hub, and defaulting
          that to zero would park every orphan in the innermost ring — the one
          place reserved for the most connected things in the vault, which is
          exactly backwards.
        */
        tier: n.tier ?? (m ? 0 : (tier.get(n.id) ?? 6)),
        sx: kept?.sx ?? 0,
        sy: kept?.sy ?? 0,
        sr: kept?.sr ?? 26,
        depth: 1,
      };
    });
    edgesRef.current = edges;

    /*
      Fit the view when the GRAPH changes, not when its contents do.

      Switching from twelve missions to 315 notes lands you inside a web far
      larger than the viewport, which is what the owner saw: "its loading so
      many at a time it takes up my screen". Zooming out by hand then finds the
      outermost nodes, which is how he hit the projection crash above.

      Keyed on the source rather than on the node list, so ticking a mission's
      progress or adding one note does NOT yank the view back — that would undo
      wherever you had panned to, on every sync.

      Deferred, because the layout needs a moment of physics before there is a
      sensible extent to fit: fitting on frame zero fits the seed ring.
    */
    if (fittedFor.current !== source) {
      const firstEver = fittedFor.current === null;
      fittedFor.current = source;
      /*
        About four seconds of the camera keeping up, which is roughly how long
        315 mutually repelling nodes take to stop growing. It ends on its own
        and any manual gesture ends it sooner.
      */
      /*
        Follow until the layout is cool rather than for a fixed count. The old
        240 frames was a guess at how long 315 nodes take to spread, and being
        wrong in either direction is visible: too short and the camera stops
        over a graph still growing, too long and it hovers over a settled one.
      */
      heat.current = 1;
      /*
        Only the big graph needs the camera to chase it.

        Twelve missions settle inside a second, so 900 frames of re-fitting is
        fifteen seconds of the view being pulled back to centre every time you
        try to move — which reads as the map being locked rather than as it
        being helpful. A short fit is all it wants.
      */
      /*
        The mission map has always OPENED AT 1:1 and never fitted itself.
        Adding a fit on mount changed the one view he uses most: it came up
        small and far away, which is what he read as it being frozen. The nodes
        were moving; they were just tiny.

        So the vault always gets the long follow — 315 notes do not fit at 1:1
        and there is nothing to preserve. Missions gets a short fit only when
        SWITCHING BACK from the vault, where you would otherwise arrive at
        whatever zoom the vault left behind. On first load it gets nothing at
        all, which is what it did before any of this.
      */
      /*
        And the follow only ever half-worked, because `fitView` clamped the
        zoom at 0.3 while the vault needs a tenth of that — so switching to it
        DID chase the layout, and stopped short of a frame that held it. The
        floor is one number now (`zoomFloor`), so this fit can reach the view
        the wheel could always reach.
      */
      // A new graph has not been framed yet, whatever the last one did.
      hasFitted.current = false;
      if (source === "vault") follow.current = 900;
      // Agents and missions settle in under a second; a short fit frames them
      // without the camera hovering over a picture that has stopped moving.
      else if (!firstEver) follow.current = 60;
    }
  }, [nodes, edges, source]);

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
    /*
      A resized window is a new frame to fill, not the old one stretched.

      Deliberately NOT part of `resize` itself: that runs once at mount, when
      the graph is empty and the mission map is supposed to open at 1:1 without
      ever being fitted. Only a real resize EVENT asks for a re-frame, and only
      when he has not framed it himself.

      Routed through `follow` rather than fitting on the spot so it glides
      rather than snapping, and so a drag-resize keeps up instead of firing a
      hard fit per pixel.
    */
    const onResize = () => {
      resize();
      if (!userFramed.current) follow.current = Math.max(follow.current, 45);
    };
    window.addEventListener("resize", onResize);

    // Particles travelling along the strands, from a mission to the ones that
    // wait on it. Direction is the information: it shows which way the board
    // actually flows, which a plain line cannot.
    /*
      A starfield, generated once and never regenerated.

      The owner asked for "starry black space so it has the density feel on
      solid", and it earns its place rather than being decoration: a rotating
      3D layout has no fixed reference, so the eye has nothing to measure the
      motion against and the whole graph reads as drifting rather than turning.
      Stars are that reference.

      They carry their own depth and PARALLAX with the yaw — near ones sweep
      further than far ones, which is the cue that makes the rotation legible.
      Generated at mount because a field that changed every frame would twinkle
      like static, and a field regenerated on re-render would jump.

      220 was too few — "bit dark out there" — and they were laid out in WORLD
      units over a fixed 3600x2600 patch, which has a worse problem than being
      sparse: inside `ctx.scale(zoom)` that patch is 216 pixels across at the
      zoom that fits the vault, so the sky collapsed into a stamp in the middle
      of the screen exactly when there was most black to fill. The wrap that was
      supposed to stop that was a no-op, because it re-wrapped coordinates that
      were already inside the range it wrapped to.

      So the field is now in SCREEN space, outside the camera transform, as a
      repeating tile. Three things fall out of that and all three are the point:
      it covers any viewport at any zoom, its density is constant instead of
      collapsing as you zoom out, and it can carry real PARALLAX — panning moves
      the near band nine times as far as the far one, which is the depth cue a
      field glued to the graph could never give.

      It also stays put while the layout spreads (see `SPREAD_GAIN`), which is
      the correct physics and the better picture: the sky is the fixed reference
      the moving graph is measured against, which is the reason this file has
      stars at all.
    */
    /** The repeat the sky is wrapped over, in screen pixels. */
    const STAR_TILE = 1100;
    /*
      Four bands, not 510 individual stars, and the difference is what makes
      this affordable.

      A band is one depth: one size, one brightness, one parallax factor — so
      every star in it can go into a single path and be painted by a single
      `fill`. That is the same trick the strands use, and for the same reason
      (1,653 stroke calls a frame is what froze the tab once already). The old
      field issued 220 fills for 220 stars; this issues FOUR for the ~870 that
      land on a 1080p screen, at a measured density of one per 2,380 square
      pixels whatever the window size or how far it has been panned.

      The counts are deliberately top-heavy toward the far, dim end. A field
      where every star is legible reads as noise; layers are what read as
      distance, and most of a real sky is nearly invisible.
    */
    const sky = [
      { count: 250, r: 0.55, alpha: 0.15, parallax: 0.05, square: true },
      { count: 150, r: 0.8, alpha: 0.26, parallax: 0.13, square: true },
      { count: 78, r: 1.15, alpha: 0.42, parallax: 0.26, square: false },
      { count: 32, r: 1.7, alpha: 0.66, parallax: 0.46, square: false },
    ].map((band) => ({
      ...band,
      stars: Array.from({ length: band.count }, () => ({
        x: Math.random() * STAR_TILE,
        y: Math.random() * STAR_TILE,
      })),
    }));
    /*
      A dozen bright ones that breathe, drawn individually because each needs
      its own alpha and a batch cannot vary that.

      The original note here — "a field that changed every frame would twinkle
      like static" — is right about a field. It is not right about a dozen: what
      makes static is EVERYTHING moving at once, and what makes a sky look alive
      is a few of the brightest doing something slow. Periods run from six
      seconds to seventeen.

      They cost about twenty fills a frame (a dozen stars, each drawn at every
      tile position on screen), which is affordable only because the four
      batched bands replaced two hundred and twenty.
    */
    const beacons = Array.from({ length: 12 }, () => ({
      x: Math.random() * STAR_TILE,
      y: Math.random() * STAR_TILE,
      r: 1.5 + Math.random() * 0.9,
      phase: Math.random() * Math.PI * 2,
      speed: 0.006 + Math.random() * 0.011,
    }));

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
      const solid = solidRef.current;

      /* ---- physics ------------------------------------------------------ */
      /*
        Beyond this, two nodes stop pushing each other.

        The repulsion is all-pairs, which is 66 comparisons for twelve missions
        and about 49,000 for 313 notes — and every one of those far pairs
        contributes a force of 52000/d², which at d = 2000 is 0.013. Summing
        fifty thousand numbers that small to move nothing is the entire cost.

        A cutoff makes the layout O(n²) in the loop but O(neighbours) in the
        work, and changes the result almost not at all: what actually shapes a
        force-directed graph is local separation plus the springs.

        Uncapped when the graph is small, because there the sum is free and the
        long-range term does help a dozen nodes spread evenly.
      */
      /*
        Sized to the layout rather than fixed at 620.

        620 was smaller than the radius of the tier holding the most nodes, so
        two notes on opposite sides of that ring contributed nothing to each
        other and the ring had no way to inflate. The cutoff now reaches across
        the crowded rings — see the note where spreadRef is filled in.
      */
      const cutoff = spreadRef.current.cutoff;
      const CUTOFF2 = bodies.length > 40 ? cutoff * cutoff : Infinity;

      /*
        Cool by about half a percent a frame, so a graph is most of the way
        settled inside ten seconds and completely settled shortly after.

        Dragging reheats it — you are asking the layout to reorganise, which is
        exactly what heat is for — but only to a third, so grabbing a node in a
        settled graph nudges its neighbourhood rather than relaunching the whole
        web across the screen.
      */
      /*
        Annealing is for the BIG graph only.

        This file's own docstring says the mission map never freezes — "you can
        grab a node and throw it, the web reorganises around your hand, and it
        keeps breathing when you let go. That difference is the whole point of a
        display you leave running." Cooling it to a stop broke exactly that, and
        the owner felt it immediately as the flat mission view being
        constrained.

        Twelve nodes never needed cooling anyway: they settle on their own in a
        second because the pull home is strong at that size. The problem
        annealing solves — a layout whose equilibrium sits tens of thousands of
        units out — only exists once the centring has been weakened to keep
        hundreds of nodes from collapsing into a hairball.
      */
      /*
        Density rules are for the VAULT, and gating them on node count was
        always a proxy for that. Naming it directly stops a busy day — twenty
        jobs across four workers — accidentally crossing a threshold meant for
        three hundred notes and freezing the layout the owner is watching for
        movement.
      */
      const anneals = sourceRef.current === "vault" && bodies.length > 40;
      /*
        Two different questions, and they were sharing one flag.

        ANNEALS is "does this layout need cooling to converge" — only the vault,
        because only the vault weakened its centring enough to need it.

        RADIAL is "are these nodes arranged in rings around the core" — the
        vault AND agents, because for agents it is the whole point: workers are
        the highest-degree nodes so they land in ring 0 attached to the core,
        and each job lands one ring out from the worker running it. That is
        exactly the picture asked for, and it falls out of the tier maths that
        already exists rather than needing its own layout.

        Missions keep their original push-out-of-the-middle, which is what that
        view has always done.
      */
      const radial = sourceRef.current !== "missions";
      if (anneals) {
        if (pointer.current.dragging) heat.current = Math.max(heat.current, 0.34);
        heat.current = Math.max(0.06, heat.current * 0.994);
      } else {
        heat.current = 1;
      }
      const hot = anneals ? heat.current : 1;

      for (let i = 0; i < bodies.length; i++) {
        const a = bodies[i];
        if (pointer.current.dragging === a.id) continue;
        for (let j = i + 1; j < bodies.length; j++) {
          const b = bodies[j];
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          // Depth participates in the repulsion, so nodes separate in three
          // dimensions rather than in two and then getting a z afterwards.
          let dz = solid ? b.z - a.z : 0;
          let d2 = dx * dx + dy * dy + dz * dz;
          if (d2 < 1) {
            // Exactly coincident nodes produce a zero-length vector and the
            // force becomes NaN, which silently blanks the entire canvas.
            dx = Math.random() - 0.5;
            dy = Math.random() - 0.5;
            dz = solid ? Math.random() - 0.5 : 0;
            d2 = 1;
          }
          if (d2 > CUTOFF2) continue;
          const d = Math.sqrt(d2);
          const min = a.r + b.r + 78;
          // Scaled by heat, so the thing pushing the graph outward is also the
          // thing that stops. Damping alone cannot settle a system that keeps
          // having energy added to it every frame.
          const force = (52000 / d2) * (d < min ? 2.4 : 1) * hot;
          const fx = (dx / d) * force;
          const fy = (dy / d) * force;
          const fz = (dz / d) * force;
          a.vx -= fx;
          a.vy -= fy;
          a.vz -= fz;
          if (pointer.current.dragging !== b.id) {
            b.vx += fx;
            b.vy += fy;
            b.vz += fz;
          }
        }
        // Gentle pull home so a disconnected mission cannot drift off screen
        // forever — with no edges nothing else would ever bring it back.
        /*
          Weaker centring on a big graph, or it packs into a ball.

          The pull home exists so a disconnected node cannot drift off screen
          forever. With twelve missions that is all it does. With 315 nodes it
          fights every repulsion at once and wins, because it grows with
          distance while repulsion falls off with the square of it — so the
          whole graph collapses into a hairball with no room between clusters
          to see that they ARE clusters.
        */
        const homeward = bodies.length > 40 ? 0.0004 : 0.0016;
        a.vx -= a.x * homeward;
        a.vy -= a.y * homeward;
        /*
          In 3D the same gentle pull home; in 2D a much firmer one, which is
          what flattens the graph when the toggle goes back.

          Eased rather than zeroed, so switching modes settles over a second or
          so instead of the whole web snapping onto a plane — the motion is
          what tells you the two views are the same graph.
        */
        a.vz -= a.z * (solid ? 0.0016 : 0.06);

        /*
          Nothing sits on the core.

          The pull home and this push out settle every mission into a ring
          around the centre, which is the arrangement the whole idea depends
          on: the core is what they are all attached to, so it needs its own
          space rather than a node parked on top of it.
        */
        const fromCore = Math.hypot(a.x, a.y) || 1;
        if (radial) {
          /*
            Every note is pulled onto the ring its tier belongs to.

            This is what makes the vault read as attached to the core instead
            of merely surrounding it: hubs settle just outside the core, their
            neighbours in the next shell, and so on outward. Combined with the
            core-to-hub strands drawn below, the origin points he was looking
            for are literally there.

            Two-sided, unlike the mission map's push — a node too far OUT is
            pulled back as firmly as one too far in, which is what turns a
            cloud into rings. Gentle, so the ordinary repulsion still decides
            where a node sits along its ring; this only decides which ring.
          */
          const rings = spreadRef.current.ringRadius;
          const ring = rings[Math.min(a.tier, rings.length - 1)] ?? MIN_ORBIT * 0.7 + a.tier * 190;
          /*
            In solid mode a tier is a SPHERICAL SHELL, not a flat ring.

            The owner: "the render doesnt feel 3d just feels like an object
            turning" — and he was right. The radial force was measured in x and
            y only, so every tier was a flat circle and the whole graph was a
            disc with a little thickness from the repulsion. A disc rotated is
            an object turning; it is not a volume.

            Using the 3D distance puts each tier on a sphere around the core, so
            there is as much structure behind and in front as there is left and
            right. That is the difference between seeing a rotation and seeing
            depth.
          */
          const radius = solid ? Math.hypot(a.x, a.y, a.z) || 1 : fromCore;
          /*
            Cooled with everything else — see the note on the spring constant.

            Annealing scaled the repulsion and nothing else, so as the graph
            cooled the only outward force fell to 6% while this one stayed at
            full strength. Two renders ten seconds apart showed the result
            exactly: a graph that fills the frame at 1s and has collapsed into a
            lopsided clump by 10s.
          */
          const pull = (radius - ring) * 0.012 * hot;
          a.vx -= (a.x / radius) * pull;
          a.vy -= (a.y / radius) * pull;
          if (solid) a.vz -= (a.z / radius) * pull;
        } else if (fromCore < MIN_ORBIT) {
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
        /*
          Cooled by the same heat as the repulsion, and this is the fix for the
          vault collapsing as it settled.

          The comment above the repulsion says "the thing pushing the graph
          outward is also the thing that stops" — true, and it was the ONLY
          thing that stopped. Springs and the radial ring pull were never
          scaled, so annealing did not slow the system down, it changed the
          balance of forces: outward decayed to 6% while inward stayed at 100%,
          and the equilibrium the layout was converging to moved inward the
          whole time it was converging.

          Cooling every shaping force together makes heat mean what it should —
          how FAST the graph is still rearranging — instead of which forces are
          allowed to win. The settled shape is now the same shape you see it
          heading towards, rather than a collapsed version of it.

          Found by rendering the same page at 1s and at 10s. One render at one
          arbitrary moment showed a graph that looked fine.
        */
        const k = (d - rest) * 0.0042 * hot;
        const fx = (dx / d) * k;
        const fy = (dy / d) * k;
        if (pointer.current.dragging !== from.id) {
          from.vx += fx;
          from.vy += fy;
        }
        if (pointer.current.dragging !== to.id) {
          to.vx -= fx;
          to.vy -= fy;
        }
      }

      for (const b of bodies) {
        if (pointer.current.dragging === b.id) continue;
        b.vx *= 0.86;
        b.vy *= 0.86;
        b.vz *= 0.86;
        const speed = Math.hypot(b.vx, b.vy, b.vz);
        /*
          Cap velocity, and let the cap cool too. A dragged node flung hard can
          otherwise inject enough energy to launch its neighbours off the
          canvas — and a settled graph should not be able to move fast at all,
          which is what stops the drift the owner watched.
        */
        const maxSpeed = 14 * Math.max(0.12, hot);
        if (speed > maxSpeed) {
          b.vx = (b.vx / speed) * maxSpeed;
          b.vy = (b.vy / speed) * maxSpeed;
          b.vz = (b.vz / speed) * maxSpeed;
        }
        b.x += b.vx;
        b.y += b.vy;
        b.z += b.vz;
      }

      /* ---- project -------------------------------------------------------
         Screen positions, computed ONCE per frame and written onto each body.

         Everything after this reads sx/sy/sr and never x/y/r again — the
         strands, the motes, the node bodies, the labels and the hit test. That
         is the whole discipline of this step: the moment two of those compute
         a position separately, the thing you click stops being the thing you
         see, and a 3D graph fails that way while still looking correct.
      */
      /*
        Nothing is allowed to shrink below this many SCREEN pixels.

        The whole canvas is drawn inside `ctx.scale(zoom)`, so a radius is in
        world units and the zoom shrinks it again afterwards. Fitting 315 notes
        into a viewport means a zoom around 0.15, at which a 10-unit node is a
        pixel and a half — the owner's photo is a field of specks with a gold
        dot in the middle where the core should be.

        Dividing by the zoom converts a screen minimum back into world units,
        so a node stays visible however far out you go. It stops LOOKING like a
        scale model and starts looking like a map, which is what it is.
      */
      const zoom = view.current.zoom;
      /*
        A screen minimum converted to world units — and CAPPED, which the first
        version was not.

        `screenPx / zoom` is unbounded as the zoom goes to zero. Fitting 315
        notes reaches about 0.15; zooming out by hand goes far below it, and at
        0.02 a 46-pixel core becomes a 2,300-unit radial gradient with a fill to
        match. That is not slow, it is a dead tab — the same crash as before
        wearing a different cause, introduced by the fix for the previous one.

        The cap is generous enough that the floor still does its job at any zoom
        anyone actually uses, and finite at every zoom that exists.
      */
      const floor = (screenPx: number, cap = screenPx * 12) =>
        Math.min(cap, screenPx / Math.max(0.05, zoom));

      /*
        How far apart the layout is holding itself THIS frame, as against how
        big the nodes are. See `SPREAD_GAIN` for the curve and why.

        Computed once here and applied only where the projection is written, a
        few lines down, so there is exactly one expression in the file that
        turns a simulated position into a drawn one. Radii deliberately do not
        get it: separation outrunning size is the entire effect, and a spread
        radius would just be the zoom again.
      */
      const spread = spreadAt(zoom);

      if (solid) {
        // A slow yaw so depth is legible. A static projection of a 3D layout
        // is just a strange 2D one — the rotation is what reveals the shape.
        // Drifts until he takes the wheel, then holds where he left it.
        if (!steered.current) spin.current += 0.0022;
        const yaw = spin.current;
        const cy = Math.cos(yaw);
        const sy = Math.sin(yaw);
        const ct = Math.cos(tilt.current);
        const st = Math.sin(tilt.current);
        /*
          Deep enough to read as depth, shallow enough that a node at the back
          is still a node rather than a speck. Measured by looking: below about
          900 the near nodes balloon and the far ones vanish.
        */
        /*
          The lens is sized to the OBJECT, not fixed.

          A constant field of view cannot be right for both graphs: 1400 against
          a small layout is nearly orthographic and reads as a flat thing
          turning, which is what the owner saw — and 780 against a layout that
          has since expanded past it puts nodes almost on the camera plane,
          where the divide blows them up to four times size. Both were the same
          mistake with different numbers.

          Measuring the layout each frame fixes the RATIO instead: the nearest
          point is always about the same amount larger than the farthest,
          whatever size the graph has grown to. 1.9 is a real lens — clearly
          three-dimensional, well short of a fisheye.
        */
        let extent = 1;
        for (const b of bodies) {
          const r = Math.hypot(b.x, b.y, b.z);
          if (r > extent) extent = r;
        }
        const FOV = Math.max(700, extent * 1.9);
        for (const b of bodies) {
          const x1 = b.x * cy - b.z * sy;
          const z1 = b.x * sy + b.z * cy;
          const y1 = b.y * ct - z1 * st;
          const z2 = b.y * st + z1 * ct;
          /*
            The divide is CLAMPED, and this is a crash rather than a wobble.

            `FOV + z2` is the distance from the camera. Nothing stopped z2
            reaching -FOV, and a graph of 315 mutually repelling nodes with a
            deliberately weak pull home absolutely can push a node that far
            back: at z2 = -1400 the divisor is zero, the projection returns
            Infinity, and every path built from it is NaN. Canvas does not
            ignore that — the compositor falls over and takes the tab with it.

            The owner found it by zooming out, which is exactly when the
            outermost nodes come into view.

            A floor at a quarter of the field of view keeps the far side
            behaving like a far side instead of turning inside out.
          */
          const p = FOV / Math.max(FOV * 0.25, FOV + z2);
          /*
            Spread applied AFTER the perspective divide, on the flat result.

            Deliberate: the depth pipeline — the FOV measured from the layout's
            own extent, the clamp above that stops the divisor reaching zero,
            the depth normalisation below — is all reasoning about the graph as
            it actually is. Feeding a zoom-dependent multiplier into it would
            make the lens change shape as you scrolled, and would put nodes
            through the clamp the crash notes above are about. Spreading the
            projected image instead opens the picture without touching the
            camera model at all.
          */
          b.sx = x1 * p * spread;
          b.sy = y1 * p * spread;
          b.sr = Math.max(b.r * p, floor(3.2));
          // Normalised against the layout's own extent rather than a constant,
          // so a tight cluster still separates front from back.
          b.depth = Math.max(0, Math.min(1, (z2 + 420) / 840));
        }
        // Far first, so near nodes paint over far ones. Sorting the array in
        // place is safe: the physics above is order-independent.
        /*
          Belt and braces. The clamp above is the fix; this is the guard that
          means a future arithmetic slip degrades to one missing node rather
          than to a dead tab. Canvas is unforgiving about NaN in a path and
          gives no error to find it by.
        */
        for (const b of bodies) {
          if (!Number.isFinite(b.sx) || !Number.isFinite(b.sy) || !Number.isFinite(b.sr)) {
            b.sx = 0;
            b.sy = 0;
            b.sr = b.r;
            b.depth = 0;
          }
        }
        bodies.sort((a, b) => a.depth - b.depth);
      } else {
        for (const b of bodies) {
          b.sx = b.x * spread;
          b.sy = b.y * spread;
          b.sr = Math.max(b.r, floor(3.2));
          b.depth = 1;
        }
      }

      /* ---- paint -------------------------------------------------------- */
      ctx.globalCompositeOperation = "source-over";
      const bg = ctx.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, Math.max(width, height) * 0.75);
      /*
        Absolute black, asked for.

        It is the right ground for this specifically: the map is additive light
        on a dark field, and any lift in the background is a floor the faintest
        strands cannot get under — a #04060A background makes a 6%-alpha edge
        almost invisible while a true black lets it read. The starfield needs it
        for the same reason.

        The subtle radial lift is kept, at a fraction of its old strength, so
        the centre still reads as having something behind it rather than being
        a hole.
      */
      bg.addColorStop(0, "#05070B");
      bg.addColorStop(1, "#000000");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, width, height);

      /*
        The camera, eased toward its target.

        Recomputed while `follow` is counting down so the frame keeps up with a
        layout that is still spreading; after that it just glides the last of
        the distance and stops. 0.06 is slow enough to read as a movement and
        fast enough not to feel like lag.

        Exponential rather than linear, so it decelerates into place — a linear
        approach arrives at full speed and stops dead, which reads as a jump at
        the end of a smooth move.
      */
      if (follow.current > 0) {
        follow.current -= 1;
        /*
          Stop early once the layout has stopped moving; there is nothing left
          to keep up with, and a camera that keeps adjusting a still picture
          reads as drift.

          Long follows only. The 900-frame chase exists to keep up with a graph
          that is still expanding, and cutting it short once the graph is cool
          is the whole point. A short fit — the 45 frames auto scaling asks for
          when the content has outgrown the window — is asked for precisely
          BECAUSE the layout has settled somewhere that no longer fits, so
          cancelling it on a cold layout would cancel every one of them.
        */
        /*
          `>= 60`, not `> 60`. This runs after the decrement above, so the
          60-frame source-change follow is already 59 on its first frame and a
          strict `>` could never cancel it — it would always run the full
          second even on a layout that had gone cold immediately.
        */
        if (heat.current < 0.12 && follow.current >= 60) follow.current = 0;
        // Every fourth frame: fitting is a pass over every body, and the target
        // does not move fast enough to need it more often than that.
        if (follow.current % 4 === 0) fitView(false);
      } else if (
        !userFramed.current &&
        !pointer.current.down &&
        hasFitted.current &&
        tick % 30 === 0
      ) {
        /*
          Auto scaling. If he has not framed the view himself, the graph is not
          allowed to grow out of the window.

          One rule covering four things that used to have none: a node added, a
          layout still spreading after the follow ended, a window resized
          smaller, and a graph swapped for a much larger one. All four are the
          same event — the content no longer fits what it is being shown in —
          and answering it in the frame loop means nothing has to remember to
          call anything.

          Three guards, and each is a bug that would otherwise be here:

          - `userFramed` is the deliberate half. A view he zoomed or panned to
            is his, and a camera that keeps overruling that is the map fighting
            him.
          - `pointer.down` because a drag WRITES positions from the pointer. Let
            the camera zoom out mid-drag and the dragged node has to move
            outward to stay under the cursor, which grows the bounds, which
            zooms out further: a runaway, in the one gesture that can feed it.
          - `hasFitted`, which is what protects the mission map's 1:1
            opening. That view is never framed by the app, so this rule must
            not be the thing that frames it. See the ref's own comment.

          BOTH DIRECTIONS, with an asymmetric dead band. An earlier version
          acted on overflow only, on the reasoning that zooming in to fill
          space would disturb the 1:1 opening — but `hasFitted` handles that
          properly, and overflow-only turns out to be a slow one-way ratchet:
          the simulation never settles by design, every outward breath past the
          threshold lowers the camera and raises `fitZoom`, and no inward
          breath ever raises it again. Over a long session the graph drifts out
          to the widest it has ever been and cannot come back without
          RECENTRE.

          0.85 out and 1.6 in are the two numbers to move if this ever feels
          wrong. They are deliberately far apart: a single threshold would let
          a layout that breathes across it re-fit twice a second. Past about a
          fifth out of frame there are nodes he cannot see; past 1.6 the graph
          is a small island in a large window.
        */
        const wanted = measureFit();
        // What is on screen is `zoom * spread` of the measured layout, and
        // `wanted.zoom` is the zoom at which the layout exactly fills the
        // window. Comparing the two is comparing like with like.
        const shown = zoom * spread;
        if (wanted && (wanted.zoom < shown * 0.85 || wanted.zoom > shown * 1.6)) {
          follow.current = 45;
        }
      }
      const target = viewTarget.current;
      const ease = follow.current > 0 ? 0.06 : 0.12;
      view.current.zoom += (target.zoom - view.current.zoom) * ease;
      view.current.panX += (target.panX - view.current.panX) * ease;
      view.current.panY += (target.panY - view.current.panY) * ease;

      /* ---- the sky -------------------------------------------------------
         Drawn first, furthest, and OUTSIDE the camera transform.

         Everything else on this canvas is in world units and scales with the
         zoom. The stars must not: they are the fixed thing the motion is read
         against, and a sky that zooms with the graph is a texture painted on
         the graph. See the generation note above for what that cost.

         Parallax instead. Each band is offset by the pan and by the yaw in
         proportion to its own depth, so the near band sweeps and the far band
         barely moves — which is the cue that turns a scatter of dots into
         distance. In flat mode there is no yaw to follow, so the field only
         answers the pan, which is correct: a diagram does not need a sky
         turning behind it.
      */
      ctx.globalCompositeOperation = "lighter";
      const panX = view.current.panX;
      const panY = view.current.panY;
      // Named apart from the projection's own `yaw` above, which lives in a
      // block of its own — two things called yaw in one function is how the
      // wrong one ends up being read.
      const skyYaw = solid ? spin.current : 0;
      const wrapTile = (v: number) => ((v % STAR_TILE) + STAR_TILE) % STAR_TILE;
      /*
        One star, drawn at every tile position that lands on screen.

        Wrapping into [0, TILE) and then stepping by TILE is what makes the
        field infinite: pan as far as you like and there is always sky. It also
        does the culling for free — a star whose wrapped position is past the
        edge of a viewport smaller than the tile simply draws nothing, so the
        cost follows the size of the WINDOW rather than the size of the field.
      */
      const tiled = (bx: number, by: number, dot: (x: number, y: number) => void) => {
        for (let x = wrapTile(bx); x <= width; x += STAR_TILE) {
          for (let y = wrapTile(by); y <= height; y += STAR_TILE) dot(x, y);
        }
      };
      for (const band of sky) {
        const r = band.r;
        /*
          A square for the two faint bands. At a diameter of one pixel there is
          no difference anyone can see between a square and a circle, and `rect`
          is one path op where an arc is a curve to flatten — worth having when
          it is four hundred of them a frame.
        */
        const dot = band.square
          ? (x: number, y: number) => ctx.rect(x - r, y - r, r * 2, r * 2)
          : (x: number, y: number) => {
              // The moveTo is not optional: without it each arc is joined to
              // the last one by a straight line through the batch.
              ctx.moveTo(x + r, y);
              ctx.arc(x, y, r, 0, Math.PI * 2);
            };
        const ox = panX * band.parallax + skyYaw * band.parallax * 260;
        const oy = panY * band.parallax;
        ctx.beginPath();
        for (const star of band.stars) tiled(star.x + ox, star.y + oy, dot);
        ctx.fillStyle = `rgba(184,204,236,${band.alpha * (solid ? 1 : 0.78)})`;
        ctx.fill();
      }
      // The bright few, each on its own slow cycle. Same parallax as the
      // nearest band, because that is the layer they belong to.
      const beaconOx = panX * 0.46 + skyYaw * 0.46 * 260;
      const beaconOy = panY * 0.46;
      for (const beacon of beacons) {
        const shimmer = 0.58 + 0.42 * Math.sin(tick * beacon.speed + beacon.phase);
        ctx.fillStyle = `rgba(214,228,255,${(0.5 + lift * 0.28) * shimmer})`;
        tiled(beacon.x + beaconOx, beacon.y + beaconOy, (x, y) => {
          ctx.beginPath();
          ctx.arc(x, y, beacon.r, 0, Math.PI * 2);
          ctx.fill();
        });
      }

      ctx.save();
      ctx.translate(width / 2 + view.current.panX, height / 2 + view.current.panY);
      ctx.scale(view.current.zoom, view.current.zoom);

      ctx.globalCompositeOperation = "lighter";

      /*
        Faint concentric rings — a horizon for the web to sit in, so the nodes
        read as being somewhere rather than floating on nothing.

        Spread with the layout, because they are the GROUND the layout stands
        on: left at a fixed radius while the nodes opened outwards they would
        shrink into a badge around the core and stop being a horizon at all.

        One path, four subpaths, one stroke — same reason as the strands below,
        and the `moveTo` before each arc is what stops the four being joined by
        a line through the middle.
      */
      ctx.beginPath();
      for (let i = 1; i <= 4; i++) {
        const ringR = i * 165 * spread;
        ctx.moveTo(ringR, 0);
        ctx.arc(0, 0, ringR, 0, Math.PI * 2);
      }
      ctx.strokeStyle = `rgba(80,110,160,${0.035 + lift * 0.03})`;
      ctx.lineWidth = 1;
      ctx.stroke();

      const focus = hoveredRef.current?.id ?? null;
      const near = new Set<string>();
      if (focus) {
        near.add(focus);
        for (const e of eds) {
          if (e.from === focus) near.add(e.to);
          if (e.to === focus) near.add(e.from);
        }
      }

      /* ---- strands -------------------------------------------------------
         THREE stroke calls, not one per edge.

         This is what made the vault graph crash the tab. Twelve missions have
         twelve links, so a stroke each was free and obviously fine. The vault
         has 1,653 — and a `beginPath`/`stroke` pair per edge is 1,653
         rasterisation calls a frame, which is 99,180 a second at 60fps. The
         browser does not gently slow down under that; it falls over.

         Canvas has no batching of its own, but a path can hold as many
         subpaths as you like: moveTo/lineTo for every edge in a group, then
         ONE stroke for the group. Three groups is all the styling needs —
         dimmed, ordinary, highlighted — because within a group the colour and
         width were already identical.

         The cost is that lineWidth and colour cannot vary per edge inside a
         group, which they never did.
      */
      const strand = (edges: Edge[], colour: Rgb, alpha: number, width: number) => {
        if (edges.length === 0) return;
        ctx.beginPath();
        for (const e of edges) {
          const from = byId.get(e.from);
          const to = byId.get(e.to);
          if (!from || !to) continue;
          ctx.moveTo(from.sx, from.sy);
          ctx.lineTo(to.sx, to.sy);
        }
        ctx.strokeStyle = rgba(colour, alpha);
        // Hairlines vanish entirely at a fitted zoom, and a graph with no
        // visible edges is a scatter plot.
        ctx.lineWidth = Math.max(width, floor(0.9));
        ctx.stroke();
      };

      /*
        The core's own strands, out to the hubs.

        "Maybe im looking for all origin points to come from the core." This is
        that, and it is honest rather than cosmetic: the lines go to the notes
        the tier layout is actually built around, so what radiates is the same
        structure the layout used.
      */
      if (radial) {
        ctx.beginPath();
        for (const b of bodies) {
          if (b.tier !== 0) continue;
          ctx.moveTo(0, 0);
          ctx.lineTo(b.sx, b.sy);
        }
        ctx.strokeStyle = rgba(GOLD, 0.13 + lift * 0.25);
        ctx.lineWidth = Math.max(1, floor(1.1));
        ctx.stroke();
      }

      if (focus === null) {
        /*
          In solid mode the web is drawn in two depth passes.

          Perspective sizes the NODES, but the strands between them are the
          bulk of what you look at, and drawn at one alpha they form a flat
          sheet of light with the nodes floating on it — which is most of why
          the depth was not reading.

          Splitting at the midpoint costs one extra stroke call and gives the
          single strongest depth cue there is: things further away are dimmer.
          Flat mode keeps its single pass, since every edge is at the same
          depth there by definition.
        */
        const base = lift > 0 ? accent : ([90, 118, 158] as Rgb);
        if (solid) {
          const far: Edge[] = [];
          const nearEdges: Edge[] = [];
          for (const e of eds) {
            const a = byId.get(e.from);
            const b = byId.get(e.to);
            if (!a || !b) continue;
            ((a.depth + b.depth) / 2 < 0.5 ? far : nearEdges).push(e);
          }
          strand(far, base, (0.16 + lift * 0.42) * 0.35, 0.7 + lift * 0.6);
          strand(nearEdges, base, (0.16 + lift * 0.42) * 1.25, 1.2 + lift * 1.2);
        } else {
          /*
            Split by LENGTH, for the same reason solid mode splits by depth.

            Once the rings were sized to their populations the layout stopped
            clumping — and the edges became the thing you were actually looking
            at. 1,660 chords drawn at one alpha across a wide disc is a mesh:
            every long link crosses the middle, they all pile up there, and the
            local structure that makes a vault readable is buried under them.

            A short strand is real adjacency — two notes that belong together
            and were placed together. A long one is a link between distant
            parts of the graph: true, worth being able to see, and not worth
            the same ink as everything else, because there are hundreds of them
            and they all overlap in the centre.

            Costs one extra stroke call, exactly like the depth split, so the
            batching that stops 1,653 individual strokes from crashing the tab
            is untouched.

            Measured in WORLD units, not screen ones, and against the graph's
            own outermost ring. Whether a link reaches across the vault is a
            fact about the vault; using `sx`/`sy` would have made it a fact
            about the current zoom, so the same edge would change group as you
            scrolled and the picture would shimmer while you looked at it.
          */
          const reach = spreadRef.current.ringRadius;
          const outer = reach[reach.length - 1] || 1;
          const longAt = outer * 0.42;
          const shortEdges: Edge[] = [];
          const longEdges: Edge[] = [];
          for (const e of eds) {
            const a = byId.get(e.from);
            const b = byId.get(e.to);
            if (!a || !b) continue;
            (Math.hypot(b.x - a.x, b.y - a.y) > longAt ? longEdges : shortEdges).push(e);
          }
          /*
            Long edges fade; short ones are left exactly as they were.

            The first attempt lifted the short group to 1.15x on the theory that
            local structure deserved more ink. Rendered, it was worse: short
            edges are precisely what fills the crowded middle, so brightening
            them thickened the mat this split exists to thin. Only subtract.
          */
          strand(longEdges, base, (0.16 + lift * 0.42) * 0.3, 0.8 + lift * 0.9);
          strand(shortEdges, base, 0.16 + lift * 0.42, 1 + lift * 1.2);
        }
      } else {
        /*
          Split once rather than tested twice. With a focus there are exactly
          two kinds of edge and the partition is cheaper than filtering the
          whole list per group.
        */
        const litEdges: Edge[] = [];
        const dimEdges: Edge[] = [];
        for (const e of eds) {
          (near.has(e.from) && near.has(e.to) ? litEdges : dimEdges).push(e);
        }
        strand(dimEdges, lift > 0 ? accent : ([90, 118, 158] as Rgb), 0.06, 1 + lift * 1.2);
        strand(litEdges, GOLD, 0.56 + lift * 0.42, 2 + lift * 1.2);
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
        const x = from.sx + (to.sx - from.sx) * mote.t;
        const y = from.sy + (to.sy - from.sy) * mote.t;
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
      /*
        Scaled by how many, so three turns look busier than one. Capped at
        three: past that the core would be a strobe, and "very busy" and
        "extremely busy" are not a distinction worth blinding him over.
      */
      const load = Math.min(3, busyRef.current);
      const busy = load > 0;
      /*
        The core scales with the graph it sits in.

        A fixed 62-unit core is right at the centre of twelve missions and
        vanishes at the centre of 315 notes — the view fits the whole web, so
        everything else shrinks around a core that does not, and the thing the
        graph is supposed to be attached to becomes a speck.

        Square root rather than linear: the layout grows roughly with the
        square root of the node count (nodes tile an area), so this keeps the
        core the same PROPORTION of the picture rather than overtaking it.
        Clamped at both ends — a core larger than its orbit would sit on top of
        the nodes, which MIN_ORBIT exists to prevent.
      */
      /*
        The core scales with the graph AND never shrinks below a readable size
        on screen.

        Two separate corrections, and it needed both. Square root of the node
        count keeps it the same proportion of a layout that grows as nodes tile
        an area — but that is a world-unit size, and the zoom that fits 315
        notes then shrinks it back to the gold speck in the photo. The screen
        floor is what actually fixes what he saw.
      */
      /*
        Both corrections, and BOTH only on the big graph.

        Square root of the node count keeps the core the same proportion of a
        layout that grows as nodes tile an area; the screen floor stops the zoom
        that fits 315 notes from shrinking it back to a speck.

        Neither applies to twelve missions, where the core is already the right
        size at the zoom you look at it — and the screen floor in particular
        would have doubled it the moment you zoomed out, which is a change to a
        view nobody asked to change.
      */
      const coreR = anneals
        ? Math.max(Math.min(150, CORE_R * Math.max(1, Math.sqrt(bodies.length / 12))), floor(46))
        : CORE_R;
      drawCore(ctx, { tick, lift, speaking: v.speaking, busy, load, radius: coreR });

      // Nodes
      for (const b of bodies) {
        const m = b.mission;
        const colour = b.tint;
        const crowded = bodies.length > 40;
        const dim = focus !== null && !near.has(b.id);
        const isHover = hoveredRef.current?.id === b.id;
        const a = dim ? 0.22 : 1;

        // Voice ring — an outline, never a filled disc. Filled haloes overlap
        // into fog; outlines cross each other and stay readable.
        if (lift > 0 && !dim) {
          ctx.beginPath();
          ctx.arc(b.sx, b.sy, b.sr + 12 + lift * 22, 0, Math.PI * 2);
          ctx.strokeStyle = rgba(accent, 0.10 + lift * 0.34);
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }

        /*
          The glow is the expensive part, and on the vault graph it has to be
          rationed.

          `createRadialGradient` allocates a gradient object per call. Twelve
          missions is twelve of those per frame and free; 313 notes is 313 per
          frame at 60fps, which is where a graph stops being a display and
          starts being a fan. Small nodes are the ones whose glow contributes
          least — at r=9 the halo is most of what you see and none of what you
          read — so they go without unless they are the one being pointed at.

          Threshold on the PROJECTED radius, not the base one: a small node
          near the camera in solid mode is big on screen and should glow.
        */
        /*
          On a crowded graph the glow is for what you are POINTING AT, nothing
          else.

          The first guard was `sr > 16`, which never fired: every note came out
          at radius 20 (see the note on `r` above), so all 313 allocated a
          gradient every frame. `crowded` is the honest test — it asks how many
          nodes there are rather than inferring it from a size that turned out
          to be constant.
        */
        if (crowded ? isHover || (focus !== null && near.has(b.id)) : true) {
          const glow = ctx.createRadialGradient(b.sx, b.sy, b.sr * 0.5, b.sx, b.sy, b.sr + 26);
          glow.addColorStop(0, rgba(colour, 0.30 * a));
          glow.addColorStop(1, rgba(colour, 0));
          ctx.fillStyle = glow;
          ctx.beginPath();
          ctx.arc(b.sx, b.sy, b.sr + 26, 0, Math.PI * 2);
          ctx.fill();
        }

        ctx.globalCompositeOperation = "source-over";
        ctx.beginPath();
        ctx.arc(b.sx, b.sy, b.sr, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(6,9,14,${0.94 * a + 0.06})`;
        ctx.fill();

        ctx.globalCompositeOperation = "lighter";
        ctx.beginPath();
        ctx.arc(b.sx, b.sy, b.sr, 0, Math.PI * 2);
        ctx.strokeStyle = rgba(colour, (isHover ? 1 : 0.8) * a);
        ctx.lineWidth = isHover ? 2.4 : 1.5;
        ctx.stroke();

        // Progress arc. Notes have none, so `ring` is 0 and this skips.
        if (b.ring > 0) {
          ctx.beginPath();
          ctx.arc(b.sx, b.sy, b.sr + 8, -Math.PI / 2, -Math.PI / 2 + b.ring * Math.PI * 2);
          ctx.strokeStyle = rgba(
            b.mission?.status === "blocked" ? STATUS_COLOR.blocked : GOLD,
            0.95 * a,
          );
          ctx.lineWidth = 3;
          ctx.lineCap = "round";
          ctx.stroke();
        }

        ctx.globalCompositeOperation = "source-over";
        ctx.textAlign = "center";
        ctx.fillStyle = `rgba(233,237,245,${a})`;
        ctx.font = "500 13px 'JetBrains Mono', ui-monospace, monospace";
        /*
          The number inside the node goes on a crowded graph.

          At r=10 a two-digit count is wider than the circle holding it, so 315
          of them read as noise laid over the structure rather than as data. The
          size already encodes degree; the number is the same fact twice, and
          the less legible copy.
        */
        if (!crowded || isHover) ctx.fillText(b.badge, b.sx, b.sy + 5);

        /*
          Labels fade with depth, and the far half loses them entirely.

          The first solid render showed the cost of three dimensions in one
          picture: "Job verification" printed straight through "Voice — talk to
          Operator", and "Gym" through "Operator". Nodes overlapping is fine —
          you can see which is in front. Two labels in the same place are just
          illegible, and there is no depth cue in text.

          So the back of the graph keeps its node and drops its name, and
          hovering brings any label back regardless of where it sits. Flat mode
          is untouched: depth is 1 for everything, so every label draws exactly
          as it did.
        */
        /*
          On a big graph, only the landmarks are labelled.

          313 note titles drawn at once is a grey field with no information in
          it — every label overlaps two others and none is readable. The
          well-connected notes are what you navigate by, so they keep their
          names; everything else gets its name on hover, which is when you are
          actually asking.

          `degree > 3` rather than a top-N: a fixed count would relabel the
          whole graph every time one link changed.
        */
        const landmark = b.landmark;
        /*
          Only the front of the sphere is named.

          0.42 kept the whole near hemisphere, and a hemisphere of labels lands
          in one crowded patch because perspective squashes them together as
          they curve away. 0.74 keeps roughly the front cap — the notes
          genuinely facing you — and everything else answers on hover.
        */
        const labelAlpha = solid ? Math.max(0, (b.depth - 0.74) / 0.26) : 1;
        if ((landmark && labelAlpha > 0.02) || isHover) {
          ctx.fillStyle = `rgba(196,205,222,${a * (isHover ? 1 : labelAlpha)})`;
          ctx.font = "13px Inter, system-ui, sans-serif";
          const label = b.label.length > 26 ? `${b.label.slice(0, 25)}…` : b.label;
          ctx.fillText(label, b.sx, b.sy + b.sr + 24);
        }
        ctx.globalCompositeOperation = "lighter";
      }

      ctx.restore();
      ctx.globalCompositeOperation = "source-over";
      raf = requestAnimationFrame(step);
    };

    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  /* ---- interaction ---------------------------------------------------- */

  /**
   * A pointer, in the space things are DRAWN in.
   *
   * The exact inverse of the canvas transform — `translate(w/2 + pan)` then
   * `scale(zoom)` — and nothing else, which is what makes it safe to compare
   * against `sx`/`sy`. Those already carry the projection AND the layout
   * spread, so this keeps working unchanged as the spread moves: the number it
   * returns is the number the node was painted at.
   *
   * It is deliberately NOT the simulated position. `toLayout` is that, and the
   * two differ by exactly the spread.
   */
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

  /**
   * A pointer, in the space the PHYSICS runs in.
   *
   * Dragging is the one gesture that writes a position back, so it is the one
   * place the spread has to be undone. Without the divide, grabbing a node at
   * any zoom above the fitted one would multiply its coordinates by the spread
   * the moment you moved — the node would leap outward from the core, and the
   * harder you had zoomed in the further it would go.
   */
  const toLayout = (clientX: number, clientY: number) => {
    const { x, y } = toWorld(clientX, clientY);
    const spread = spreadAt(view.current.zoom);
    return { x: x / spread, y: y / spread };
  };

  const bodyAt = (clientX: number, clientY: number) => {
    const { x, y } = toWorld(clientX, clientY);
    /*
      Generous by the ZOOM, not a fixed number. At 0.6x a 30-unit node is 18
      screen pixels across, and a 6-unit slop is a pixel and a half — which is
      why grabbing one felt like it missed.
    */
    const slop = 10 / Math.max(0.3, view.current.zoom);
    /*
      Tested against the PROJECTED position, and searched near-to-far.

      In 3D two nodes can overlap on screen while being far apart in the
      layout, and the one in front is the one being pointed at. `bodies` is
      sorted far-to-near for painting, so walking it backwards picks whichever
      was drawn last — the same one the eye picked.

      In 2D nothing changes: sx/sy/sr are copies of x/y/r and the order is
      irrelevant.
    */
    const bodies = bodiesRef.current;
    for (let i = bodies.length - 1; i >= 0; i -= 1) {
      const b = bodies[i];
      if (Math.hypot(b.sx - x, b.sy - y) <= b.sr + slop) return b;
    }
    return null;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    /*
      Capture on the canvas, not the event target, and never let it throw.
      With capture held, the pointer can leave the element entirely and the
      drag survives — which is why `onPointerLeave` must NOT be wired to
      release: it fires mid-drag and cancelled both dragging and panning.
    */
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* Not fatal: the drag still works while the pointer stays inside. */
    }
    /*
      Touching the map ends the automatic follow, immediately.

      A camera that keeps re-fitting while you are panning fights you for the
      view and wins, because it runs every fourth frame and you do not. The
      target is synced to wherever the view actually is, so releasing does not
      then glide back to where the follow was heading.
    */
    follow.current = 0;
    viewTarget.current = { ...view.current };

    const hit = bodyAt(e.clientX, e.clientY);
    pointer.current.down = true;
    pointer.current.moved = 0;
    pointer.current.lastX = e.clientX;
    pointer.current.lastY = e.clientY;

    /*
      Right button always pans; left button drags a node, or pans empty space.

      The owner's ask, and it fixes a real collision rather than adding a
      shortcut: with only the left button, wanting to pan meant finding a gap
      between nodes, and on the vault graph — 313 nodes — there frequently is
      no gap. Grabbing a node when you meant to move the view is then the
      normal outcome, not the edge case.

      Left-drag on empty space still pans, so nothing anyone already does stops
      working. The context menu is suppressed on the canvas, or Windows opens
      one over the graph on every pan.
    */
    if (e.button === 2) {
      pointer.current.panning = true;
      pointer.current.orbiting = solidRef.current;
      return;
    }
    if (hit) pointer.current.dragging = hit.id;
    else pointer.current.panning = true;
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    /*
      Self-heal a stuck gesture.

      If a pointerup is ever missed — capture lost, the button released over
      another window, the tab losing focus mid-drag — `panning` or `dragging`
      stays set and the map then slides around under a cursor with no button
      held. That is the "was working a moment then kinda broke" the owner hit,
      and it never recovers on its own because nothing else clears the flag.

      `e.buttons` is the truth about what is currently held, so it is checked
      every move rather than trusting that the release event arrived.
    */
    if (e.buttons === 0 && (pointer.current.dragging || pointer.current.panning)) {
      pointer.current.dragging = null;
      pointer.current.panning = false;
      pointer.current.orbiting = false;
      pointer.current.down = false;
    }

    const dx = e.clientX - pointer.current.lastX;
    const dy = e.clientY - pointer.current.lastY;
    pointer.current.lastX = e.clientX;
    pointer.current.lastY = e.clientY;
    pointer.current.moved += Math.abs(dx) + Math.abs(dy);

    if (pointer.current.dragging) {
      // Resolved fresh each move, so a rebuild between frames cannot strand it.
      const b = bodiesRef.current.find((n) => n.id === pointer.current.dragging);
      if (!b) {
        pointer.current.dragging = null;
        return;
      }
      // `toLayout`, not `toWorld` — a drag writes into the simulation, and the
      // simulation does not know about the layout spread.
      const { x, y } = toLayout(e.clientX, e.clientY);
      // Velocity carried from the pointer, so releasing mid-sweep throws the
      // node instead of dropping it dead.
      b.vx = x - b.x;
      b.vy = y - b.y;
      b.x = x;
      b.y = y;
      return;
    }
    if (pointer.current.panning) {
      /*
        Right-drag ORBITS in solid mode, and pans in flat.

        In three dimensions the useful gesture is turning the thing rather than
        sliding it — which is what every 3D viewer does and what he expected:
        "i thought it would pan the camera in like the 3d view you know how like
        u can on maps n stuff". In flat there is nothing to turn, so the same
        gesture keeps its original job.

        Pitch is clamped short of vertical. Past the pole the scene flips and
        yaw reverses under your hand, which reads as the controls breaking
        rather than as the camera going over the top.
      */
      if (pointer.current.orbiting) {
        steered.current = true;
        spin.current -= dx * 0.006;
        tilt.current = Math.max(-1.25, Math.min(1.25, tilt.current + dy * 0.006));
      } else {
        view.current.panX += dx;
        view.current.panY += dy;
        viewTarget.current = { ...view.current };
        // He has framed it. Nothing reframes it again until he asks — see
        // `userFramed`.
        userFramed.current = true;
      }
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
    /*
      A tap opens whatever the node IS. `sourceRef` rather than `source`, for
      the same reason the animation loop reads a ref: these handlers are passed
      to the canvas once and a stale closure would send a vault tap to
      /missions/<a note id>, which 404s in a way that looks like the note being
      gone.
    */
    if (dragged && pointer.current.moved < 6) {
      const src = sourceRef.current;
      if (src === "vault") navigate(`/knowledge/${dragged}`);
      // Every agent node leads to the same place: the thread it belongs to.
      // Job ids are prefixed so they cannot collide with a mission id.
      else if (src === "agents") navigate("/orchestrator");
      else navigate(`/missions/${dragged}`);
    }
    pointer.current.down = false;
    pointer.current.dragging = null;
    pointer.current.panning = false;
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
  };

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    // Scrolling is a manual gesture like any other; the camera stops steering,
    // and stays stopped — this is him choosing a frame.
    follow.current = 0;
    userFramed.current = true;
    const next = view.current.zoom * (e.deltaY < 0 ? 1.12 : 0.89);
    /*
      The floor depends on how big the graph is.

      0.35 was right for twelve missions and is a wall on 315 notes: the fitted
      zoom is around 0.1, so `fitView` set a value the wheel could not reach and
      one scroll out snapped you back inside the web with no way to get out
      again. A floor should be the point past which zooming out stops being
      useful, and that moves with the node count.
    */
    view.current.zoom = Math.max(zoomFloor(), Math.min(3, next));
    viewTarget.current = { ...view.current };
  };

  /**
   * Where the camera WOULD sit to hold the whole graph, without moving it.
   *
   * Split out of `fitView` because the answer is wanted twice for two different
   * reasons: to go there, and to ask whether the graph has outgrown the window
   * since the last time it did. Those must not be allowed to compute the frame
   * differently — a rule that fires on one measurement and moves the camera to
   * another is a rule that fires again on the next frame, forever.
   *
   * Measured in SIMULATION units, with no spread applied, and that is what
   * keeps the whole arrangement stable: the zoom it returns becomes the anchor
   * (`fitZoom`), and the spread at the anchor is 1 by definition — so the frame
   * it measured is the frame you land in.
   */
  const measureFit = () => {
    const canvas = canvasRef.current;
    const bodies = bodiesRef.current;
    if (!canvas || bodies.length === 0) return null;
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
    /*
      A margin, and the chat is in the way.

      Fitting the bounds exactly puts the outermost node against the edge, and
      the bottom of the canvas is covered by the chat bar — which is why the
      lowest mission was half off screen immediately after pressing RECENTRE.
      The usable height is not the canvas height.
    */
    const usableH = h - 150;
    const zoom = Math.max(
      // The same floor the wheel uses. They were two numbers and disagreed —
      // see `zoomFloor`.
      zoomFloor(),
      Math.min(1.6, Math.min(w / (maxX - minX), usableH / (maxY - minY)) * 0.94),
    );

    return {
      zoom,
      // Shifted up by half the space the chat occupies, so the centre of the
      // web sits in the centre of what you can actually see.
      panX: -((minX + maxX) / 2) * zoom,
      panY: -((minY + maxY) / 2) * zoom - 40,
    };
  };

  /*
    Fit everything on screen, rather than merely returning to 1:1.

    The first version reset zoom and pan to their defaults, which is not what
    "reset" means on a map you can throw nodes around: if you had flung one into
    the distance, the view snapped back to centre and the node was still off
    screen. Measuring the actual bounds and framing them does what the button
    says.
  */
  const fitView = (immediate = true) => {
    const target = measureFit();
    /*
      Framing is the camera's decision again from here.

      Both callers mean that: RECENTRE is him handing the view back, and the
      follow only runs when nothing has taken it. Auto scaling reads this flag
      and nothing else, so this line is the whole of "it holds where he left
      it" — see `userFramed`.
    */
    userFramed.current = false;
    if (!target) {
      viewTarget.current = { zoom: 1, panX: 0, panY: 0 };
      fitZoom.current = 1;
      if (immediate) view.current = { ...viewTarget.current };
      return;
    }

    /*
      Calm the web as well as framing it.

      The simulation never settles by design, and the repulsion that keeps
      missions apart is far stronger than the pull that keeps them home — so a
      view fitted to this instant is wrong a second later, which is exactly how
      it looked broken. Zeroing velocities makes RECENTRE mean "settle down and
      show me everything" rather than "photograph a moving thing".
    */
    /*
      Only when asked for. RECENTRE means "settle down and show me everything",
      so stopping the motion is the point — but doing it while FOLLOWING would
      freeze the layout the moment the camera tried to keep up with it, which
      is the opposite of watching it expand.
    */
    if (immediate) {
      for (const b of bodiesRef.current) {
        b.vx = 0;
        b.vy = 0;
        b.vz = 0;
      }
    }

    viewTarget.current = target;
    /*
      The anchor the layout spread is measured from moves with the fit.

      This is what makes "zoomed in" mean the same thing on twelve missions and
      on 690 notes: it is measured from the view that shows you everything, not
      from 1. It also makes the fit self-consistent — the spread is exactly 1 at
      this zoom, so the bounds `measureFit` just measured are the bounds you
      arrive at.
    */
    fitZoom.current = target.zoom;
    // From here on the camera owns the framing, so auto scaling may act.
    hasFitted.current = true;
    // RECENTRE is a request, so it lands immediately. The animated version is
    // `follow`, below, which is for the camera keeping up with a graph that is
    // still moving.
    if (immediate) view.current = { ...viewTarget.current };
  };

  /*
    A release that happens outside the window never reaches the canvas at all,
    so the gesture has to be ended here too. Alt-tabbing mid-drag was leaving
    the map pinned to a pointer that had long since let go.
  */
  useEffect(() => {
    const release = () => {
      pointer.current.dragging = null;
      pointer.current.panning = false;
      pointer.current.orbiting = false;
      pointer.current.down = false;
    };
    window.addEventListener("blur", release);
    window.addEventListener("pointerup", release);
    return () => {
      window.removeEventListener("blur", release);
      window.removeEventListener("pointerup", release);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        /*
          Back out of the current thing, and in the desktop shell that is
          FULLSCREEN before it is the page. Summoning puts Operator fullscreen
          on the chosen screen; navigating away from there would leave the
          dashboard filling the display with no obvious way out.

          Async, so the navigate only happens when there was no fullscreen to
          leave. In a browser `exitFullscreen` resolves false immediately and
          this behaves exactly as it did.
        */
        void exitFullscreen().then((left) => {
          if (!left) navigate("/dashboard");
        });
      }
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
        // Or Windows opens a context menu over the graph on every right-drag.
        onContextMenu={(e) => e.preventDefault()}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
      />

      {/* HUD */}
      <div className="absolute top-0 left-0 right-0 p-6 flex items-start justify-between pointer-events-none">
        <div>
          {/*
            The title says which graph you are looking at.

            Not decoration: the two are visually similar enough at a glance —
            same renderer, same core, same strands — that a heading reading
            MISSION MAP over 313 notes would be actively misleading.
          */}
          <h1 className="font-display text-lg text-ink-100 tracking-wide">
            {source === "vault" ? "KNOWLEDGE VAULT" : source === "agents" ? "AGENTS" : "MISSION MAP"}
          </h1>
          {source === "agents" ? (
            /*
              Counted by STATE, because that is the question. "Nine jobs" says
              nothing; "two running, one waiting on you" is the whole reason to
              look at this screen.
            */
            <p className="font-mono text-[11px] text-ink-600 mt-1">
              {jobs.filter((j) => j.status === "running").length} running ·{" "}
              {jobs.filter((j) => j.status === "queued").length} queued
              {jobs.some((j) => (j.asking ?? 0) > 0) && (
                <span className="text-xp">
                  {" "}· {jobs.reduce((n, j) => n + (j.asking ?? 0), 0)} waiting on you
                </span>
              )}
            </p>
          ) : (
            <p className="font-mono text-[11px] text-ink-600 mt-1">
              {nodes.length} {source === "vault" ? "notes" : "active"} · {edges.length}{" "}
              {edges.length === 1 ? "link" : "links"}
            </p>
          )}
        </div>

        <div className="flex items-center gap-4">
          {/*
            The old server-mic chip is gone: MicSource on the left now says
            which microphone is in use and whether it is live, and two
            indicators disagreeing about the same thing — "LISTENING" next to
            "THIS DEVICE" — is worse than either alone. The owner said so:
            "bit confused here".

            Speaking is the exception, because it is a different fact. The
            picker says what Operator can HEAR; this says it is talking.
          */}
          {/*
            A count, because the spin says "busy" and not "busy with how much".
            Only when something is running: a permanent "0 running" chip is
            furniture, and this HUD already hides the mic row when the
            microphone is off for the same reason.
          */}
          {busyCount > 0 && (
            <span
              className="flex items-center gap-2 font-mono text-[11px]"
              style={{ color: "#78C8E8" }}
              title={`${busyCount} turn${busyCount === 1 ? "" : "s"} running or queued`}
            >
              <span className="flex items-center gap-0.5" aria-hidden>
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    className="w-1 h-1 rounded-full animate-breathe"
                    style={{ background: "#78C8E8", animationDelay: `${i * 0.22}s` }}
                  />
                ))}
              </span>
              {busyCount === 1 ? "WORKING" : `WORKING ×${busyCount}`}
            </span>
          )}

          {voice.speaking && (
            <span className="flex items-center gap-2 font-mono text-[11px]" style={{ color: "#8D7FE0" }}>
              <span
                className="w-1.5 h-1.5 rounded-full"
                style={{ background: "#8D7FE0", boxShadow: "0 0 8px #8D7FE0" }}
              />
              SPEAKING
            </span>
          )}
          {/*
            A real button, not a keyboard hint.

            "0 to reset" was set in 10px mono at the bottom of the screen and
            read as "B to reset" — which is a fair description of a control
            nobody can see.
          */}
          <MicSource mic={mic} autoSend={autoSend} onAutoSend={setAutoSend} className="pointer-events-auto" />
          {/*
            WHICH graph. The owner's words: "show me mission view or show me
            knowledge view" — so the button says which one you are looking at
            and tapping it swaps.

            Separate from FLAT/SOLID next to it, because they are separate
            questions. A flat vault and a solid mission board are both things
            worth wanting, and one combined control would delete two of the
            four views to save a button.
          */}
          {/*
            Three graphs, cycled by one button.

            A row of three would be clearer and is the wrong trade here: this
            HUD floats over a wall display and every control is one more thing
            between him and the picture. Cycling costs at most two taps and the
            label always says where you are.
          */}
          <button
            onClick={() =>
              setSource(source === "missions" ? "vault" : source === "vault" ? "agents" : "missions")
            }
            title={
              source === "vault"
                ? `${vault.active.length} notes. Tap for what Operator is running.`
                : source === "agents"
                  ? `${jobs.length} job(s). Tap for the mission board.`
                  : "Tap for the Knowledge Vault graph."
            }
            className={`pointer-events-auto font-mono text-[11px] transition-colors border rounded-badge px-3 py-1.5 min-h-[36px] ${
              source === "vault"
                ? "border-rank/50 bg-rank/10 text-rank"
                : source === "agents"
                  ? "border-xp/50 bg-xp/10 text-xp"
                  : "border-base-600 hover:border-base-500 text-ink-500 hover:text-ink-100"
            }`}
          >
            {source === "vault" ? "VAULT" : source === "agents" ? "AGENTS" : "MISSIONS"}
          </button>
          {/*
            Flat or solid. Labelled by what you GET, not by what it is called —
            "3D" is a property of the renderer and "SOLID" is a description of
            the picture, and the button that says the second one needs no
            explaining.
          */}
          <button
            onClick={() => setSolid(!solid)}
            title={
              solid
                ? "Flatten the graph. Easier to read; harder to see how much is connected."
                : "Lay the graph out in three dimensions and turn it slowly."
            }
            aria-pressed={solid}
            className={`pointer-events-auto font-mono text-[11px] transition-colors border rounded-badge px-3 py-1.5 min-h-[36px] ${
              solid
                ? "border-xp/50 bg-xp/10 text-xp"
                : "border-base-600 hover:border-base-500 text-ink-500 hover:text-ink-100"
            }`}
          >
            {solid ? "SOLID" : "FLAT"}
          </button>
          <button
            onClick={() => fitView(true)}
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
            {/*
              The answer it had, when it could not say it.

              Shown in the accent rather than the faint status colour, because
              this is Operator's reply — the thing he asked for — and it only
              appears at all when the spoken channel is closed.
            */}
            {mutedReply && (
              <p className="text-sm leading-snug text-xp/90">{mutedReply}</p>
            )}
            <p className="font-mono text-[10px] text-ink-700/70">
              {mutedReply
                ? "muted — tap the speaker in the chat to hear replies"
                : transcript.working
                  ? "transcribing…"
                  : transcript.status}
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
        <OperatorChat className="w-full max-w-2xl pointer-events-auto" heard={transcript.last?.handled ? null : lastHeard} autoSend={autoSend} />
      </div>

      <p className="absolute bottom-6 right-6 font-mono text-[10px] text-ink-700 pointer-events-none hidden xl:block">
        {`drag a node · right-drag to ${solid ? "turn" : "pan"} · scroll to zoom`}
      </p>
    </div>
  );
}
