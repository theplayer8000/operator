import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, X, Loader2, ChevronDown, Volume2, VolumeX } from "lucide-react";
import { useJobs } from "@/hooks/useJobs";
import { useSpeech } from "@/hooks/useSpeech";

/**
 * Talking to Operator, on top of the map — the same chat on a phone and on the
 * wall display.
 *
 * The owner asked for the phone version first, liked it, and then asked for
 * "the same for pc mode... and remove orchestrator chat since its basically
 * the same now". One component rather than two so that stays true: a second
 * implementation would drift within a week, and the divergence would show up
 * as "it works on my phone but not at my desk", which is the worst kind of bug
 * to be told about.
 *
 * ## It is a single bar until it has something to show
 *
 * An empty transcript occupying half the screen is a promise the app has not
 * kept yet, and on the map it would cover the thing you came to look at. Send
 * something and it expands.
 *
 * ## Answering a permission question is the part that matters
 *
 * A tool outside the pre-allow list suspends the running turn and dies after
 * thirty minutes (ADR 0012). Notifications now wake him for exactly this, so
 * the tap has to land somewhere that can answer — otherwise the phone buzzes
 * to tell him about a decision he cannot make.
 *
 * The buttons render **only when the event carries an `id`**. The same event
 * type is also emitted after the fact by the CLI fallback to describe a denial
 * that already ended a turn, and an event log replayed after a restart
 * describes a question that died with the process. Buttons on either would
 * offer a decision that resolves nothing.
 *
 * ## What it deliberately does not do
 *
 * No model picker, no attachments, no tab strip, no retry. Those live on
 * `/orchestrator`, which is still there. This is the everyday surface — ask a
 * thing, read the answer, unblock a turn — and keeping it that small is what
 * makes it fit under a map on a phone.
 */

export default function OperatorChat({
  className = "",
  heard,
  autoSend = false,
}: {
  className?: string;
  /**
   * The last thing the microphone made out, if anything.
   *
   * Put into the input rather than sent. The owner's complaint was that voice
   * "heard it but didnt give me a feedback ... nor does it like sync or
   * connect" — so the words have to arrive somewhere he can see and act on.
   *
   * NOT auto-sent, deliberately. Every sentence becoming a job is how twenty
   * phantom ones happened on 2026-08-31, and a misheard word would spend money
   * with no chance to catch it. Filling the box makes the loop visible and
   * leaves the decision one tap away.
   */
  heard?: string | null;
  /** Send what was heard immediately instead of filling the box. */
  autoSend?: boolean;
}) {
  const jobs = useJobs();
  const [draft, setDraft] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  /*
    Which worker answers, chosen here rather than by the router.

    "the replys are awful" and "any way we can add in a fast model" — and the
    diagnosis is routing, not a missing model. A short spoken question matches
    the JUST_DATA rules and goes to Gemini, which is configured as a
    capability-actions worker: terse, tool-shaped, and not trying to hold a
    conversation. Claude Fable 5 has been in the picker all along and is the
    fast one.

    `null` means auto — keep the router, which is right when he does not care.
    Naming a worker here is for when he does.
  */
  const [worker, setWorker] = useState<string | null>(null);
  const speech = useSpeech();

  /*
    Read the answer out loud.

    The owner asked the time from his phone and reported "it didnt plsy out
    loud" — the core went blue and the reply arrived, silently. Speech was
    wired into the old Orchestrator page and nowhere else, so moving the chat
    onto the map lost it.

    Only the LAST assistant message, and only once. Tracked by index rather
    than by text: two identical replies in a thread are two things worth
    hearing, and de-duping on content would swallow the second.

    `speechSynthesis` lives in the browser, which is why this is here and not
    on the server — the server genuinely cannot know whether anything was said
    aloud, and `useVoiceActivity` deliberately does not claim to.
  */
  const spokenTo = useRef(-1);
  /** False until the first render has decided what counts as already-heard. */
  const caughtUp = useRef(false);

  const messages = useMemo(
    () =>
      jobs.events.filter(
        (e) =>
          e.type === "prompt" ||
          e.type === "text" ||
          e.type === "permission_request" ||
          e.type === "permission_answer",
      ),
    [jobs.events],
  );

  /** One place that actually sends, so voice and the button cannot diverge. */
  const sendText = useCallback(
    async (text: string) => {
      if (!text.trim() || jobs.busy) return;
      setExpanded(true);

      /*
        `selected`, not `selectedId`.

        `selectedId` is raw state and is never checked against the job list;
        `selected` is `jobs.find(...) ?? null`, so it is only set when the job
        genuinely still exists. Sending to the unvalidated one meant a stale id
        survived every server restart and every "clear all", and the next thing
        the owner said came back "no such job" — which he hit asking the time.
      */
      const live = jobs.selected?.id ?? null;

      try {
        if (live) await jobs.send(live, text);
        else await jobs.create(text, undefined, [], worker ?? undefined);
      } catch (err) {
        /*
          A job can also disappear between the check and the send — another
          device clearing, or a restart landing in that gap. Losing what he
          just said to a race is worse than quietly starting a new thread.
        */
        if (String((err as Error)?.message ?? "").includes("no such job")) {
          try {
            await jobs.create(text, undefined, [], worker ?? undefined);
          } catch {
            /* useJobs owns the error surface; it renders below. */
          }
        }
      }
    },
    [jobs, worker],
  );

  const send = async () => {
    const text = draft.trim();
    if (!text || jobs.busy) return;
    setDraft("");
    setExpanded(true);
    // One path for both, so the button and the voice cannot diverge — which is
    // how only one of them carried the stale-id bug.
    await sendText(text);
  };

  const answer = async (permissionId: string, decision: "allow" | "deny", remember = false) => {
    // Validated, for the same reason sending is: a question on a job that no
    // longer exists cannot be answered, and trying reports a confusing failure.
    const live = jobs.selected?.id;
    if (!live) return;
    const problem = await jobs.answerPermission(live, permissionId, decision, remember);
    // "Already settled" is information, not a failure — it happens when the
    // same question was answered from another device, which is normal here.
    if (problem) setNote(problem);
  };

  useEffect(() => {
    /*
      Catch up silently the first time.

      `spokenTo` starts before the beginning, so a freshly mounted chat with an
      existing thread read the WHOLE history out loud. The owner hit it by
      clicking a Statistics tile through to the map: "it took me to operator and
      replayed out its last prompt ... kind of a bug". It is — arriving
      somewhere should not make it recite what you already heard.

      Only messages that appear AFTER this component is on screen are new.
    */
    if (!caughtUp.current) {
      caughtUp.current = true;
      spokenTo.current = messages.length - 1;
      return;
    }

    if (!speech.enabled) {
      // Keep the marker level with the thread while muted, or unmuting would
      // read out everything that arrived in the meantime.
      spokenTo.current = messages.length - 1;
      return;
    }
    for (let i = spokenTo.current + 1; i < messages.length; i++) {
      const e = messages[i];
      if (e.type === "text" && !e.error && e.text?.trim()) speech.speak(e.text);
    }
    spokenTo.current = messages.length - 1;
  }, [messages, speech]);

  /*
    Fill the box when something new is heard, and open the thread so it is
    visible. Tracked by value rather than by a counter: the same sentence said
    twice is two intentions, but the SAME string arriving again from a
    re-render is not, and only one of those should re-fill a box he may have
    started editing.
  */
  const lastHeard = useRef<string | null>(null);
  useEffect(() => {
    if (!heard || heard === lastHeard.current) return;
    lastHeard.current = heard;
    setExpanded(true);
    if (autoSend) {
      // Straight through. Guarded by `busy` inside sendText so a sentence
      // arriving mid-turn joins the thread rather than colliding with it.
      void sendText(heard);
      return;
    }
    setDraft((prev) => (prev.trim() ? `${prev.trim()} ${heard}` : heard));
  }, [heard, autoSend, sendText]);

  const bottomRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (expanded) bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, expanded]);

  // Auto-open on a live question. The turn is suspended and the clock is
  // running; a collapsed bar would hide the one thing that needs a tap.
  const liveQuestion = messages.some((e) => e.type === "permission_request" && e.id);
  useEffect(() => {
    if (liveQuestion) setExpanded(true);
  }, [liveQuestion]);

  if (!jobs.authorised) {
    return (
      <div className={className}>
        <p className="card-base px-4 py-3 text-xs text-ink-500">
          {jobs.reason ?? "Not authorised."} Arm the terminal on the Dev page to start a job — a
          turn can run tools, so it counts as execution.
        </p>
      </div>
    );
  }

  return (
    <div className={className}>
      {expanded && (
        <div className="mb-2 card-base max-h-[52vh] flex flex-col overflow-hidden animate-fade-up">
          <div className="flex items-center justify-between px-4 py-2 border-b border-base-600 shrink-0">
            <span className="font-mono text-[11px] text-ink-600 truncate">
              {jobs.selected?.title ?? "New job"}
            </span>
            <div className="flex items-center gap-1 shrink-0">
              {speech.supported && (
                <button
                  onClick={() => speech.setEnabled(!speech.enabled)}
                  aria-label={speech.enabled ? "Mute replies" : "Read replies aloud"}
                  className={`min-h-[44px] min-w-[44px] flex items-center justify-center transition-colors ${
                    speech.enabled ? "text-xp" : "text-ink-600 hover:text-ink-100"
                  }`}
                >
                  {speech.enabled ? <Volume2 size={16} /> : <VolumeX size={16} />}
                </button>
              )}
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
            {messages.map((e, i) =>
              e.type === "prompt" ? (
                <p
                  key={i}
                  className="text-sm text-ink-100 bg-base-700/60 rounded-badge px-3 py-2 ml-8 whitespace-pre-wrap break-words"
                >
                  {e.text}
                </p>
              ) : e.type === "permission_answer" ? (
                <p key={i} className="font-mono text-[11px] text-ink-600">
                  {e.decision === "allowed" ? "allowed" : e.decision} {e.by ? `by ${e.by}` : ""}
                </p>
              ) : e.type === "permission_request" ? (
                <div key={i} className="rounded-badge border border-xp/40 bg-xp/5 px-3 py-3">
                  <p className="text-xs text-xp font-mono mb-1">Needs your say-so</p>
                  <p className="text-sm text-ink-200 break-words">
                    {e.title || e.rule || e.tool || "A tool wants to run."}
                  </p>
                  {e.description && (
                    <p className="text-xs text-ink-500 mt-1 break-words">{e.description}</p>
                  )}
                  {e.id ? (
                    <div className="flex flex-wrap gap-2 mt-3">
                      <button
                        onClick={() => void answer(e.id!, "allow")}
                        className="min-h-[44px] px-4 rounded-badge bg-xp text-base-950 text-sm font-medium"
                      >
                        Allow
                      </button>
                      <button
                        onClick={() => void answer(e.id!, "deny")}
                        className="min-h-[44px] px-4 rounded-badge border border-base-500 text-ink-300 text-sm"
                      >
                        No
                      </button>
                      <button
                        onClick={() => void answer(e.id!, "allow", true)}
                        className="min-h-[44px] px-4 rounded-badge border border-base-600 text-ink-500 text-sm"
                      >
                        Allow &amp; stop asking
                      </button>
                    </div>
                  ) : (
                    /*
                      No `id` means nothing is waiting: either the CLI fallback
                      describing a denial that already ended the turn, or a log
                      replayed after a restart. Buttons here would resolve
                      nothing.
                    */
                    <p className="text-[11px] text-ink-600 mt-2">
                      No longer answerable — the turn it belonged to has ended.
                    </p>
                  )}
                </div>
              ) : (
                <p
                  key={i}
                  className={`text-sm whitespace-pre-wrap break-words mr-8 ${
                    e.error ? "text-vital-down" : "text-ink-300"
                  }`}
                >
                  {e.text}
                </p>
              ),
            )}
            {jobs.busy && (
              <p className="flex items-center gap-2 text-xs text-ink-600">
                <Loader2 size={13} className="animate-spin" /> working…
              </p>
            )}
            {note && <p className="text-xs text-ink-600">{note}</p>}
            {jobs.error && <p className="text-xs text-vital-down">{jobs.error}</p>}
            <div ref={bottomRef} />
          </div>
        </div>
      )}

      {/*
        Only when the thread is open. A worker picker permanently above the
        input would be chrome on a surface whose whole point is being one bar
        until it has something to say.
      */}
      {expanded && jobs.providers.length > 1 && (
        <div className="flex items-center gap-1.5 mb-2 overflow-x-auto scrollbar-none">
          <button
            onClick={() => setWorker(null)}
            className={`shrink-0 px-2.5 min-h-[32px] rounded-badge text-[11px] font-mono border transition-colors ${
              worker === null
                ? "border-xp/50 text-xp"
                : "border-base-600 text-ink-600 hover:text-ink-300"
            }`}
            title="Let the router choose"
          >
            auto
          </button>
          {jobs.providers.map((p) => (
            <button
              key={p.id}
              onClick={() => setWorker(p.id)}
              className={`shrink-0 px-2.5 min-h-[32px] rounded-badge text-[11px] font-mono border transition-colors ${
                worker === p.id
                  ? "border-xp/50 text-xp"
                  : "border-base-600 text-ink-600 hover:text-ink-300"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}

      <div className="flex items-end gap-2">
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
            `text-base` on the small breakpoint, not `text-sm`: iOS zooms the
            whole page when a focused input is under 16px. One of the four
            responsive rules the design system says get broken most.
          */
          className="flex-1 resize-none card-base px-4 py-3 text-base sm:text-sm text-ink-100 placeholder:text-ink-700 outline-none focus:border-xp/50 max-h-32"
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
    </div>
  );
}
