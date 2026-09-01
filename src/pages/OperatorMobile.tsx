import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useJobs } from "@/hooks/useJobs";
import OperatorChat from "@/components/map/OperatorChat";
import { useVoiceActivity } from "@/hooks/useVoiceActivity";
import { readStorage, writeStorage } from "@/lib/storage";
import { useMicLevel } from "@/hooks/useMicLevel";
import { usePhoneTranscript } from "@/hooks/usePhoneTranscript";
import MicSource from "@/components/map/MicSource";
import { drawCore } from "@/components/map/operatorCore";

/**
 * Operator on a phone: the core, and a chat that isn't there until you use it.
 *
 * The owner's brief, after seeing the wall display: *"for mobile i figured out
 * what i want just the core on its own for voice interactivty snd then for
 * chat it a dynamic live chat that expands once ive prompted something"*.
 *
 * So this is deliberately **not** a shrunken `/map`. The graph is a big-screen
 * view — he has said so twice — and nine labelled nodes on a 390px screen is
 * the fog problem again in a different costume. What a phone gets is the part
 * that says Operator is alive and listening, plus a way to talk to it.
 *
 * ## The chat earns its space
 *
 * Collapsed it is one input bar. Send something and it expands into the thread.
 * That ordering matters: an empty transcript occupying two thirds of a phone
 * screen is a promise the app has not kept yet, and it would cover the core —
 * which is the thing he actually wants to look at while speaking.
 *
 * ## Reuses the job model, does not reinvent it
 *
 * `useJobs` owns creating a job, polling its event log, and answering a
 * permission question. This renders a phone-shaped view of that and nothing
 * more. Anything clever about routing, retries or attempts belongs in
 * `server/jobs.mjs`, not here.
 */

export default function OperatorMobile() {
  const navigate = useNavigate();
  const voice = useVoiceActivity();
  const jobs = useJobs();

  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  /*
    This phone's own microphone, read locally at frame rate.

    The owner's idea, and it is the right one: the device in his hand has a
    better microphone than the desktop rig, it is always with him, and reading
    it here means the core responds to his voice with NO network in the loop.
    The server poll can only ever be a quarter-second behind.

    It is opt-in behind a tap because browsers require a gesture, and because
    an app that opens your microphone unasked is one you stop trusting.
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
  const lastClaps = useRef(0);
  useEffect(() => {
    if (voice.claps === lastClaps.current) return;
    const first = lastClaps.current === 0;
    lastClaps.current = voice.claps;
    // Not on the very first reading, which is just learning the current count
    // rather than a clap that happened while he was looking at this page.
    if (first || mic.active || !mic.supported) return;
    void mic.enable();
  }, [voice.claps, mic]);
  /*
    What it is hearing, in words, straight under the core.

    A test surface first and a feature second — the owner asked for it "just
    for like a quick test" so he can see the phone actually picking him up
    before the boom mic arrives. Deliberately faint: it should read as
    something overheard, not as a transcript competing with the core for
    attention.
  */
  /*
    Remembered across reloads.

    It was deliberately not persisted at first, on the grounds that a
    preference which spends money should be a fresh decision each session. In
    use that was just annoying — he turned it on, navigated away, came back and
    it was off, which reads as the toggle being broken rather than cautious.
    His call, and he has lived with it: "set it so that it remembers".
  */
  const [autoSend, setAutoSendState] = useState(() => readStorage("voice.autoSend", false));
  const setAutoSend = (next: boolean) => {
    setAutoSendState(next);
    writeStorage("voice.autoSend", next);
  };
  const transcript = usePhoneTranscript(mic, mic.active);
  /*
    The newest thing heard, handed to the chat so it lands somewhere he can see
    and act on rather than only being displayed. `.at()` is avoided because the
    build targets a lib without it.
  */
  const lastHeard = transcript.lines.length
    ? transcript.lines[transcript.lines.length - 1]
    : null;

  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  const micRef = useRef(mic);
  micRef.current = mic;
  const busyRef = useRef(false);
  busyRef.current = jobs.busy || Boolean(jobs.runningId);

  /* ---- the core, and only the core ---------------------------------- */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let tick = 0;
    let width = 0;
    let height = 0;

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

    const frame = () => {
      const v = voiceRef.current;
      const m = micRef.current;
      /*
        This phone's microphone wins when it is open.

        Local is both faster and more relevant: the server's level describes
        the room the PC is in, which is not where he is standing. The server
        poll stays as the fallback so the core still lives when the phone's
        microphone is closed.
      */
      const heard = m.active
        ? m.levelRef.current
        : v.listening
          ? Math.min(1, v.level / Math.max(0.004, v.threshold))
          : 0;
      const lift = v.speaking ? 1 : heard > 0.12 ? heard : 0;

      ctx.globalCompositeOperation = "source-over";
      const bg = ctx.createRadialGradient(
        width / 2, height * 0.42, 0,
        width / 2, height * 0.42, Math.max(width, height) * 0.8,
      );
      bg.addColorStop(0, "#0D1119");
      bg.addColorStop(1, "#04060A");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, width, height);

      ctx.save();
      ctx.translate(width / 2, height * 0.42);
      drawCore(ctx, {
        tick: (tick += 1),
        lift,
        speaking: v.speaking,
        busy: busyRef.current,
        // Sized off the narrow edge so it fills a phone without the aura
        // clipping. Much larger than the 62 the wall display uses, because
        // here it is the whole interface rather than one element of it.
        radius: Math.min(width, height) * 0.17,
      });
      ctx.restore();
      ctx.globalCompositeOperation = "source-over";
      raf = requestAnimationFrame(frame);
    };

    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, []);

  const heard = voice.listening ? Math.min(1, voice.level / Math.max(0.004, voice.threshold)) : 0;
  const hearing = heard > 0.35;

  /*
    Swipe down to dismiss, the way a phone sheet behaves.

    This is the landing page, so "back" has nowhere to go — the browser would
    leave the app entirely. A downward drag is the gesture every iOS sheet uses
    for the same job, and it beats aiming at a 44px cross in the corner
    one-handed.

    Only starts from a touch that is NOT on the chat: dragging the transcript
    should scroll it, and a page-dismiss gesture that fires while you are
    reading a reply is worse than no gesture.
  */
  const [pull, setPull] = useState(0);
  const drag = useRef({ y: 0, active: false });
  const DISMISS_AT = 120;

  const onTouchStart = (e: React.TouchEvent) => {
    if ((e.target as HTMLElement).closest("[data-chat]")) return;
    drag.current = { y: e.touches[0].clientY, active: true };
  };
  const onTouchMove = (e: React.TouchEvent) => {
    if (!drag.current.active) return;
    const dy = e.touches[0].clientY - drag.current.y;
    // Downward only, and resisted past the threshold so it feels like a sheet
    // rather than a page that fell off.
    setPull(dy > 0 ? (dy > DISMISS_AT ? DISMISS_AT + (dy - DISMISS_AT) * 0.3 : dy) : 0);
  };
  const onTouchEnd = () => {
    if (!drag.current.active) return;
    drag.current.active = false;
    if (pull >= DISMISS_AT) navigate("/dashboard");
    setPull(0);
  };

  return (
    <div
      className="fixed inset-0 bg-[#04060A] overflow-hidden flex flex-col"
      style={{ transform: pull ? `translateY(${pull}px)` : undefined, transition: pull ? "none" : "transform 200ms" }}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    >
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />

      {/*
        The grabber. Every iOS sheet has one, which is exactly why it is here:
        it is the one mark that tells you a surface can be pulled down without
        anyone having to say so. Brightens as you drag, so the gesture confirms
        itself before you have committed to it.
      */}
      <div
        className="relative mx-auto mt-2 h-1 w-10 rounded-full transition-colors"
        style={{
          background: pull > 0 ? "rgba(232,176,77,0.7)" : "rgba(255,255,255,0.14)",
        }}
        aria-hidden
      />

      {/* Status, top-left. Only ever says something true. */}
      <div className="relative flex items-center justify-between px-5 pt-5">
        <MicSource mic={mic} autoSend={autoSend} onAutoSend={setAutoSend} />
        <div className="flex items-center gap-2">
          {/*
            Opening the microphone needs a user gesture, so it is a button and
            not something that happens on load. Hidden entirely when the page
            is not a secure context — a dead button teaches you the feature is
            broken, where its absence plus the message below is the truth.
          */}
          <button
            onClick={() => navigate("/dashboard")}
            className="font-mono text-[11px] text-ink-600 border border-base-600 rounded-badge px-3 min-h-[44px] min-w-[44px]"
          >
            ✕
          </button>
        </div>
      </div>

      {(mic.error || (!mic.supported && !voice.listening)) && (
        <p className="relative mx-5 mt-3 text-[11px] text-ink-600 leading-relaxed">
          {mic.error ??
            "Open Operator at its https://…ts.net address to use this phone's microphone — a bare IP is not a secure page, so the browser will not hand it over."}
        </p>
      )}

      {/*
        Sits under the core, barely there. Newest last, oldest fading out —
        the older a line is the less it matters, and fading says that without
        a timestamp on every row.
      */}
      {mic.active && (
        <div className="relative px-8 mt-2 pointer-events-none select-none">
          <div className="mx-auto max-w-sm text-center space-y-1">
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
              Always visible while the mic is on. The owner's call: "i kinda
              like it and it reasures me its working".

              He is right that it is doing a second job now — it found a real
              bug in one round, and it is also the only thing that says the
              pipeline is alive between sentences. Worth removing once the
              novelty wears off, not before.
            */}
            <p className="font-mono text-[10px] text-ink-700/70">
              {transcript.working ? "transcribing…" : transcript.status}
            </p>
          </div>
        </div>
      )}

      {transcript.error && mic.active && (
        <p className="relative mx-8 mt-2 text-center text-[11px] text-ink-700">
          {transcript.error}
        </p>
      )}

      <div className="flex-1" />

      {/*
        The chat is shared with the wall display — same component, same
        behaviour, so the two cannot drift apart.
      */}
      <div data-chat>
        <OperatorChat className="relative mx-3 mb-4" heard={lastHeard} autoSend={autoSend} />
      </div>
    </div>
  );
}
