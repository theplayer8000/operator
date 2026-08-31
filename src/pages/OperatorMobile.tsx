import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowUp, X, Loader2, ChevronDown } from "lucide-react";
import { useJobs } from "@/hooks/useJobs";
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
  const [draft, setDraft] = useState("");
  const [expanded, setExpanded] = useState(false);

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

  /* ---- talking to it -------------------------------------------------- */

  const messages = useMemo(
    () =>
      jobs.events.filter(
        (e) => e.type === "prompt" || e.type === "text" || e.type === "permission_request",
      ),
    [jobs.events],
  );

  const send = async () => {
    const text = draft.trim();
    if (!text || jobs.busy) return;
    setDraft("");
    setExpanded(true);
    try {
      // Continue the open thread if there is one, otherwise start a job. The
      // router picks the worker, exactly as it does from the desk — a spoken
      // or phone-typed request is not a different KIND of request.
      if (jobs.selectedId) await jobs.send(jobs.selectedId, text);
      else await jobs.create(text);
    } catch {
      /* useJobs owns the error surface; it renders below. */
    }
  };

  const bottomRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (expanded) bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, expanded]);

  const heard = voice.listening ? Math.min(1, voice.level / Math.max(0.004, voice.threshold)) : 0;
  const hearing = heard > 0.35;

  /*
    Jobs are tier 3 — a turn has tool access, so it is execution and needs the
    terminal armed. Said plainly rather than letting the input fail silently:
    the failure is a policy, not a fault, and it has a one-tap fix.
  */
  const locked = !jobs.authorised;

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

      {/* ---- the chat, which is a single bar until it has something to show ---- */}
      <div className="relative">
        {expanded && (
          <div className="mx-3 mb-2 card-base max-h-[52vh] flex flex-col overflow-hidden animate-fade-up">
            <div className="flex items-center justify-between px-4 py-2 border-b border-base-600 shrink-0">
              <span className="font-mono text-[11px] text-ink-600">
                {jobs.selected?.title ?? "New job"}
              </span>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setExpanded(false)}
                  aria-label="Collapse the thread"
                  className="text-ink-600 hover:text-ink-100 min-h-[44px] min-w-[44px] flex items-center justify-center"
                >
                  <ChevronDown size={16} />
                </button>
                <button
                  onClick={() => {
                    void jobs.clearAll();
                    setExpanded(false);
                  }}
                  aria-label="Clear"
                  className="text-ink-600 hover:text-ink-100 min-h-[44px] min-w-[44px] flex items-center justify-center"
                >
                  <X size={16} />
                </button>
              </div>
            </div>

            <div className="overflow-y-auto px-4 py-3 space-y-3">
              {messages.map((e, i) => (
                <div key={i}>
                  {e.type === "prompt" ? (
                    <p className="text-sm text-ink-100 bg-base-700/60 rounded-badge px-3 py-2 ml-8">
                      {e.text}
                    </p>
                  ) : e.type === "permission_request" ? (
                    <div className="rounded-badge border border-xp/40 bg-xp/5 px-3 py-2">
                      <p className="text-xs text-xp font-mono mb-1">Needs your say-so</p>
                      <p className="text-sm text-ink-200 break-words">{e.text ?? "A tool wants to run."}</p>
                      <p className="text-[11px] text-ink-600 mt-1">
                        Answer it on the Orchestrator page.
                      </p>
                    </div>
                  ) : (
                    <p className="text-sm text-ink-300 whitespace-pre-wrap break-words mr-8">
                      {e.text}
                    </p>
                  )}
                </div>
              ))}
              {jobs.busy && (
                <p className="flex items-center gap-2 text-xs text-ink-600">
                  <Loader2 size={13} className="animate-spin" /> working…
                </p>
              )}
              {jobs.error && <p className="text-xs text-vital-down">{jobs.error}</p>}
              <div ref={bottomRef} />
            </div>
          </div>
        )}

        {locked ? (
          <p className="mx-3 mb-4 card-base px-4 py-3 text-xs text-ink-500">
            {jobs.reason ?? "Not authorised."} Arm the terminal on the Dev page to start a job —
            a turn can run tools, so it counts as execution.
          </p>
        ) : (
          <div className="mx-3 mb-4 flex items-end gap-2">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              onFocus={() => messages.length > 0 && setExpanded(true)}
              rows={1}
              placeholder="Ask Operator…"
              /*
                `text-base` and not `text-sm`: iOS zooms the whole page when a
                focused input is under 16px, and the design system calls this
                out as one of the four rules that get broken most.
              */
              className="flex-1 resize-none card-base px-4 py-3 text-base text-ink-100 placeholder:text-ink-700 outline-none focus:border-xp/50 max-h-32"
            />
            <button
              onClick={() => void send()}
              disabled={!draft.trim() || jobs.busy}
              aria-label="Send"
              className="shrink-0 min-h-[48px] min-w-[48px] rounded-badge bg-xp text-base-950 flex items-center justify-center disabled:opacity-30 transition-opacity"
            >
              {jobs.busy ? <Loader2 size={18} className="animate-spin" /> : <ArrowUp size={18} />}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
