import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useJobs } from "@/hooks/useJobs";
import OperatorChat from "@/components/map/OperatorChat";
import { useVoiceActivity } from "@/hooks/useVoiceActivity";
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

  const voiceRef = useRef(voice);
  voiceRef.current = voice;
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
      const heard = v.listening ? Math.min(1, v.level / Math.max(0.004, v.threshold)) : 0;
      const lift = v.speaking ? 1 : heard > 0.35 ? heard : 0;

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

  return (
    <div className="fixed inset-0 bg-[#04060A] overflow-hidden flex flex-col">
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />

      {/* Status, top-left. Only ever says something true. */}
      <div className="relative flex items-center justify-between px-5 pt-5">
        <span className="font-mono text-[11px] text-ink-600 flex items-center gap-2">
          {voice.listening ? (
            <>
              <span
                className="w-1.5 h-1.5 rounded-full transition-all duration-150"
                style={{
                  background: voice.speaking ? "#8D7FE0" : "#E8B04D",
                  opacity: voice.speaking ? 1 : 0.3 + heard * 0.7,
                  transform: `scale(${voice.speaking ? 1.5 : 1 + heard * 0.8})`,
                }}
              />
              {voice.speaking ? "SPEAKING" : hearing ? "HEARING" : "LISTENING"}
            </>
          ) : (
            <span className="text-ink-700">OPERATOR</span>
          )}
        </span>
        <button
          onClick={() => navigate("/dashboard")}
          className="font-mono text-[11px] text-ink-600 border border-base-600 rounded-badge px-3 min-h-[44px] min-w-[44px]"
        >
          ✕
        </button>
      </div>

      <div className="flex-1" />

      {/*
        The chat is shared with the wall display — same component, same
        behaviour, so the two cannot drift apart.
      */}
      <OperatorChat className="relative mx-3 mb-4" />
    </div>
  );
}
