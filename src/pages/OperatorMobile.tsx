import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  onSummoned,
  reportMicState,
  summonWindow,
} from "@/lib/desktop";
import { useJobs } from "@/hooks/useJobs";
import OperatorChat from "@/components/map/OperatorChat";
import { useSpeech } from "@/hooks/useSpeech";
import { useVoiceActivity } from "@/hooks/useVoiceActivity";
import { readStorage, writeStorage } from "@/lib/storage";
import { useMicLevel } from "@/hooks/useMicLevel";
import { registerMic } from "@/lib/micBridge";
import { usePhoneTranscript } from "@/hooks/usePhoneTranscript";
import MicSource from "@/components/map/MicSource";
import { drawCore } from "@/components/map/operatorCore";
import MobileControlDock from "@/components/dashboard/MobileControlDock";

/*
  The text chat feed — archived, not deleted, per the owner: mobile is
  voice-focused going forward (full voice work is separate, waiting on him
  being home with his actual mic), so the feed that used to expand into a
  thread here no longer earns its space. `OperatorChat` itself is UNTOUCHED —
  it is shared with the wall display (MissionMap.tsx) and stays exactly as
  it was there. This flag only gates whether THIS page still mounts it.

  A boolean over a comment block, deliberately: the import, the JSX and the
  props it needs all stay compiled and type-checked with the flag OFF, so a
  future refactor elsewhere in this file can't silently break a code path
  nobody is exercising and nobody would notice until someone flips it back
  on. Flip it to `true` to bring the feed back.
*/
const MOBILE_TEXT_CHAT_ENABLED = false;

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
  // `voice.speaking` is read from speechSynthesis and the audio element, so it
  // covers Kokoro and the fallback voice alike.
  const transcript = usePhoneTranscript(mic, mic.active, voice.speaking);
  /*
    The newest thing heard, handed to the chat so it lands somewhere he can see
    and act on rather than only being displayed. `.at()` is avoided because the
    build targets a lib without it.
  */
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
    The listeners themselves moved to `useShellControls`, mounted in `App`, on
    2026-09-02 — a global hotkey that only fires on two routes is not a global
    hotkey. This page keeps what only it can have: the stream.

    Registered on every render rather than in an effect. `mic` is a fresh object
    each time, and a subscription keyed on that identity is precisely the churn
    that made the tray look broken the first time round.
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
      {/*
        Frosted glass BEHIND the core — stacked first so the canvas (below,
        DOM order = paint order, no z-index games needed) paints over it.
        Was the other way around originally, which read as "glass sitting on
        top of/partially obscuring the core" — the owner's actual complaint
        once the hard edge was fixed and the flaw underneath it was visible:
        wrong stacking, not just a bad edge. A canvas is transparent outside
        what it draws, so putting it on top costs nothing — the glass still
        shows through everywhere the core doesn't draw, and the rings/nucleus
        pixels themselves are now crisp, painted after (i.e. above) the blur
        rather than a blurred backdrop sampling them into the mix.

        Position/size math (unchanged from before, still worth keeping here
        since it's this div's, not the canvas's):

          - Centre: the caller (below) draws at `ctx.translate(width / 2,
            height * 0.42)` — 42% down, NOT 50%. That 8-point gap, at a
            ~66px base radius on a 390px phone, is a FULL RADIUS of vertical
            miss. `top: 42%` here matches it exactly, and the same
            `translateY(-28px)` the canvas carries keeps the two aligned.
          - Size: drawCore's shell (the rings) sits at `radius * 1.62`, the
            soft aura fades out by `radius * 2.2`. `radius` itself is
            `min(width, height) * 0.17` — so in CSS terms, the shell's
            diameter is `min(100vw, 100vh) * 0.17 * 1.62 * 2` ≈ `55vmin`,
            grown to 85vmin below so the mask (next point) still leaves a
            fully-opaque centre roughly that size.
          - Weight: deliberately NOT the shared `.glass` utility (16px blur,
            0.6 alpha) — that class is tuned for the dock sheet reading text
            clearly against a busy background, and at the core's fine
            line-art the same blur reads as mud regardless of correct
            sizing. Lighter, inline, specific to this one use.
          - Edge: no border, and no hard-edged circle — a flat disc read as a
            separate lens laid on top ("what's that circle"), and even
            without a border `backdrop-filter` still has a hard boundary of
            its own at its shape edge. A `mask` radial-gradient fades the
            element's own alpha from solid at the centre to nothing well
            before its edge, so the blur fades out WITH it.
      */}
      <div
        className="pointer-events-none absolute left-1/2 rounded-full"
        style={{
          top: "42%",
          width: "85vmin",
          height: "85vmin",
          transform: "translate(-50%, -50%) translateY(-28px)",
          backdropFilter: "blur(7px)",
          background: "rgba(22, 27, 36, 0.32)",
          WebkitMaskImage: "radial-gradient(circle, black 0%, black 32%, transparent 68%)",
          maskImage: "radial-gradient(circle, black 0%, black 32%, transparent 68%)",
        }}
        aria-hidden
      />

      {/*
        The core itself, on top of the glass now (see comment above). Shifted
        up a little, not redrawn: a pure CSS transform, nothing in
        operatorCore.ts's own drawing math touched. Room underneath is for
        the Control dock's handle (MobileControlDock, fixed to the bottom
        edge) — without this the core's own lower glow sat right up against
        it.
      */}
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full -translate-y-7" />

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

      {transcript.error && mic.active && (
        <p className="relative mx-8 mt-2 text-center text-[11px] text-ink-700">
          {transcript.error}
        </p>
      )}

      <div className="flex-1" />

      {/*
        The chat is shared with the wall display — same component, same
        behaviour, so the two cannot drift apart. Archived here specifically
        (MOBILE_TEXT_CHAT_ENABLED, top of file) — mobile is voice-focused
        now; OperatorChat itself is untouched and MissionMap.tsx still mounts
        it exactly as before.
      */}
      {MOBILE_TEXT_CHAT_ENABLED && (
        <div data-chat>
          <OperatorChat className="relative mx-3 mb-4" heard={transcript.last?.handled ? null : lastHeard} autoSend={autoSend} />
        </div>
      )}

      <MobileControlDock />
    </div>
  );
}
