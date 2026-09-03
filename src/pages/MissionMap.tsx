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
  const [source, setSourceState] = useState<"missions" | "vault">(() => {
    const wanted = new URLSearchParams(window.location.search).get("graph");
    if (wanted === "vault" || wanted === "missions") return wanted;
    return readStorage<string>("map.source", "missions") === "vault" ? "vault" : "missions";
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
  const setSource = (next: "missions" | "vault") => {
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
  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      if (typeof document !== "undefined" && document.hidden) return;
      try {
        const res = await fetch("/api/jobs", { headers: { accept: "application/json" } });
        const body = await res.json();
        if (stopped) return;
        const jobs: { status?: string }[] = Array.isArray(body?.jobs) ? body.jobs : [];
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
      }));
    }
    return active.map((m) => ({
      id: m.id,
      label: m.name,
      links: m.dependsOn ?? [],
      mission: m,
      note: null,
    }));
  }, [source, active, vault.active]);

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
        tint: m ? (STATUS_COLOR[m.status] ?? STATUS_COLOR.not_started) : noteTint,
        // Notes have no progress, so no arc. Their badge is how connected they
        // are, which is the equivalent question for a vault: a note nothing
        // links to is one you will never arrive at by accident.
        ring: m ? Math.max(0, Math.min(100, m.progress)) / 100 : 0,
        badge: m ? `${Math.round(Math.max(0, Math.min(100, m.progress)))}%` : String(d),
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
        r: m ? 26 + Math.min(14, d * 3) : 6 + Math.min(9, Math.sqrt(d) * 2.4),
        degree: d,
        landmark: !m ? labelled.has(n.id) : true,
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
      follow.current = source === "vault" ? 900 : 40;
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
    window.addEventListener("resize", resize);

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

      220 is enough to read as a sky at 1440p and cheap enough to draw as plain
      arcs. No gradients here — that is the mistake that made the vault graph
      unusable.
    */
    const stars = Array.from({ length: 220 }, () => {
      const depth = 0.25 + Math.random() * 0.75;
      return {
        // Spread over a generous area so panning does not run out of sky.
        x: (Math.random() - 0.5) * 3600,
        y: (Math.random() - 0.5) * 2600,
        depth,
        r: 0.4 + depth * 1.1,
        // Slightly cool, slightly varied — a field of identical dots reads as
        // a texture rather than as distance.
        alpha: 0.12 + depth * 0.4,
      };
    });

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
      const CUTOFF2 = bodies.length > 40 ? 620 * 620 : Infinity;

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
      const anneals = bodies.length > 40;
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

      if (solid) {
        // A slow yaw so depth is legible. A static projection of a 3D layout
        // is just a strange 2D one — the rotation is what reveals the shape.
        spin.current += 0.0022;
        const yaw = spin.current;
        const tilt = 0.34;
        const cy = Math.cos(yaw);
        const sy = Math.sin(yaw);
        const ct = Math.cos(tilt);
        const st = Math.sin(tilt);
        /*
          Deep enough to read as depth, shallow enough that a node at the back
          is still a node rather than a speck. Measured by looking: below about
          900 the near nodes balloon and the far ones vanish.
        */
        const FOV = 1400;
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
          b.sx = x1 * p;
          b.sy = y1 * p;
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
          b.sx = b.x;
          b.sy = b.y;
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
        // Stop early once the layout has stopped moving; there is nothing left
        // to keep up with, and a camera that keeps adjusting a still picture
        // reads as drift.
        if (heat.current < 0.12) follow.current = 0;
        // Every fourth frame: fitting is a pass over every body, and the target
        // does not move fast enough to need it more often than that.
        if (follow.current % 4 === 0) fitView(false);
      }
      const target = viewTarget.current;
      const ease = follow.current > 0 ? 0.06 : 0.12;
      view.current.zoom += (target.zoom - view.current.zoom) * ease;
      view.current.panX += (target.panX - view.current.panX) * ease;
      view.current.panY += (target.panY - view.current.panY) * ease;

      ctx.save();
      ctx.translate(width / 2 + view.current.panX, height / 2 + view.current.panY);
      ctx.scale(view.current.zoom, view.current.zoom);

      ctx.globalCompositeOperation = "lighter";

      /*
        The sky, drawn first and furthest.

        Parallax by depth against the same yaw the nodes use, so the field
        turns with the graph instead of sitting on the glass in front of it.
        In flat mode there is no yaw, so they simply sit still — which is
        correct: a flat graph is a diagram and a diagram does not need a sky
        moving behind it.
      */
      for (const star of stars) {
        const drift = solid ? Math.sin(spin.current) * star.depth * 180 : 0;
        const x = star.x + drift;
        // Wrapped rather than clipped, so panning never reaches an edge of the
        // field and finds nothing.
        const wrapped = ((x + 1800) % 3600) - 1800;
        ctx.beginPath();
        ctx.arc(wrapped, star.y, star.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(184,204,236,${star.alpha * (solid ? 1 : 0.55)})`;
        ctx.fill();
      }

      // Faint concentric rings — a horizon for the web to sit in, so the nodes
      // read as being somewhere rather than floating on nothing.
      for (let i = 1; i <= 4; i++) {
        ctx.beginPath();
        ctx.arc(0, 0, i * 165, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(80,110,160,${0.035 + lift * 0.03})`;
        ctx.lineWidth = 1;
        ctx.stroke();
      }

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

      if (focus === null) {
        strand(
          eds,
          lift > 0 ? accent : ([90, 118, 158] as Rgb),
          0.16 + lift * 0.42,
          1 + lift * 1.2,
        );
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
        const labelAlpha = solid ? Math.max(0, (b.depth - 0.42) / 0.58) : 1;
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
      window.removeEventListener("resize", resize);
    };
  }, []);

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
      const { x, y } = toWorld(e.clientX, e.clientY);
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
    /*
      A tap opens whatever the node IS. `sourceRef` rather than `source`, for
      the same reason the animation loop reads a ref: these handlers are passed
      to the canvas once and a stale closure would send a vault tap to
      /missions/<a note id>, which 404s in a way that looks like the note being
      gone.
    */
    if (dragged && pointer.current.moved < 6) {
      navigate(
        sourceRef.current === "vault" ? `/knowledge/${dragged}` : `/missions/${dragged}`,
      );
    }
    pointer.current.down = false;
    pointer.current.dragging = null;
    pointer.current.panning = false;
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
  };

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    // Scrolling is a manual gesture like any other; the camera stops steering.
    follow.current = 0;
    const next = view.current.zoom * (e.deltaY < 0 ? 1.12 : 0.89);
    /*
      The floor depends on how big the graph is.

      0.35 was right for twelve missions and is a wall on 315 notes: the fitted
      zoom is around 0.1, so `fitView` set a value the wheel could not reach and
      one scroll out snapped you back inside the web with no way to get out
      again. A floor should be the point past which zooming out stops being
      useful, and that moves with the node count.
    */
    const low = bodiesRef.current.length > 40 ? 0.06 : 0.35;
    view.current.zoom = Math.max(low, Math.min(3, next));
    viewTarget.current = { ...view.current };
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
    const canvas = canvasRef.current;
    const bodies = bodiesRef.current;
    if (!canvas || bodies.length === 0) {
      viewTarget.current = { zoom: 1, panX: 0, panY: 0 };
      if (immediate) view.current = { ...viewTarget.current };
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
    /*
      A margin, and the chat is in the way.

      Fitting the bounds exactly puts the outermost node against the edge, and
      the bottom of the canvas is covered by the chat bar — which is why the
      lowest mission was half off screen immediately after pressing RECENTRE.
      The usable height is not the canvas height.
    */
    const usableH = h - 150;
    const zoom = Math.max(
      0.3,
      Math.min(1.6, Math.min(w / (maxX - minX), usableH / (maxY - minY)) * 0.94),
    );

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
      for (const b of bodies) {
        b.vx = 0;
        b.vy = 0;
        b.vz = 0;
      }
    }

    viewTarget.current = {
      zoom,
      // Shifted up by half the space the chat occupies, so the centre of the
      // web sits in the centre of what you can actually see.
      panX: -((minX + maxX) / 2) * zoom,
      panY: -((minY + maxY) / 2) * zoom - 40,
    };
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
            {source === "vault" ? "KNOWLEDGE VAULT" : "MISSION MAP"}
          </h1>
          <p className="font-mono text-[11px] text-ink-600 mt-1">
            {nodes.length} {source === "vault" ? "notes" : "active"} · {edges.length}{" "}
            {edges.length === 1 ? "link" : "links"}
          </p>
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
          <button
            onClick={() => setSource(source === "vault" ? "missions" : "vault")}
            title={
              source === "vault"
                ? `${vault.active.length} notes. Tap for the mission board.`
                : "Tap for the Knowledge Vault graph."
            }
            className={`pointer-events-auto font-mono text-[11px] transition-colors border rounded-badge px-3 py-1.5 min-h-[36px] ${
              source === "vault"
                ? "border-rank/50 bg-rank/10 text-rank"
                : "border-base-600 hover:border-base-500 text-ink-500 hover:text-ink-100"
            }`}
          >
            {source === "vault" ? "VAULT" : "MISSIONS"}
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
        drag a node · right-drag to pan · scroll to zoom
      </p>
    </div>
  );
}
