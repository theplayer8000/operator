import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, X, Loader2, ChevronDown, Paperclip, Volume2, VolumeX } from "lucide-react";
import { useJobs, type JobResource } from "@/hooks/useJobs";
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
 * `/orchestrator`, which is still there. Attachments ARE here (2026-09-06 —
 * the owner's pictures never made it because this surface had no button
 * while the wiring existed). This is the everyday surface — ask a
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
  /*
    The draft survives a swipe-out / rotation / reload — "twice now this has
    happened, me accidentally swiping out and losing my prompt because the
    chat closes" (7 Sep). An unsent prompt is raw data; flushing it to
    localStorage on every keystroke means the worst case is being a snippet
    behind, never gone. One draft per thread: switching jobs swaps in that
    thread's text, so there is no cross-thread bleed. Sending clears it the
    same way it clears the box — setDraft("") writes "" over the key.
  */
  const draftKey = () => {
    const id = jobs.selected?.id ?? null;
    return id ? `op.chat.draft.${id}` : "op.chat.draft.unthreaded";
  };
  useEffect(() => {
    try {
      const saved = localStorage.getItem(draftKey());
      if (saved != null) setDraft(saved);
    } catch {
      /* private browsing / locked-down webview: the draft is in-memory only */
    }
    // Restore on mount AND when the thread changes.
  }, [jobs.selected?.id]);
  useEffect(() => {
    try {
      localStorage.setItem(draftKey(), draft);
    } catch {
      /* same — nothing durable to hang the draft on */
    }
  }, [draft, jobs.selected?.id]);
  /*
    Local files picked for the next message, uploaded only when Send is hit —
    an eager upload would leave a staged resource with no turn to belong to
    (server/uploads.mjs stages at job start, not picker close). Same shape as
    OrchestratorChat, keeping the everyday surface to pick → chip → send.
  */
  const [attachments, setAttachments] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
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
  /**
   * Which thread `spokenTo` is measured against, or null before anything loads.
   *
   * This was a boolean — "have we caught up yet" — and it was wrong in a way
   * that only showed on a real page load. The effect's FIRST run happens while
   * `jobs.events` is still empty, so it marked itself caught-up against an
   * empty list. When the history then arrived, every event in it was "new" and
   * got read aloud: opening the page replayed the last answer and announced
   * "Got it, Claude is on it" for a job accepted hours earlier.
   *
   * Keying on the job id fixes both that and switching tabs, because the marker
   * is only trusted while it refers to the thread currently on screen.
   */
  /*
    `undefined` is "nothing yet", `null` is "no job selected". They must be
    different values, and making them the same was a real bug.

    This ref was initialised to `null`, which is also what `jobs.selected?.id ??
    null` evaluates to before the job list resolves. So on a fresh mount with a
    thread already cached, the first run compared null against null, decided it
    was the SAME thread it had been tracking, skipped the catch-up branch, and
    read the entire history out loud. The owner's report: "whenever i reopen the
    operator chat it repeats its last turn."

    The earlier fix — keying on the job id rather than a boolean — was right and
    is kept. It just needed a starting value no job id and no empty selection
    can ever equal.
  */
  const spokenForJob = useRef<string | null | undefined>(undefined);

  const messages = useMemo(
    () =>
      jobs.events.filter(
        (e) =>
          e.type === "prompt" ||
          e.type === "text" ||
          e.type === "accepted" ||
          e.type === "permission_request" ||
          e.type === "permission_answer",
      ),
    [jobs.events],
  );

  /*
    What THIS device asked for, so only this device reads the answer aloud.

    Jobs are shared — the event log is server-side and every open client sees
    every event on the selected thread. The speech effect below spoke anything
    new, so telling Operator on the phone that a gym session was skipped made
    the PC in the other room announce the confirmation too. The owner's report:
    "i tried telling it i skipped gym yesterday and it worked but then also came
    on my pc".

    Matching on the prompt TEXT rather than an id, because that needs no server
    change and no per-client identity: the question is only ever "was the thing
    being answered something I asked?". A collision needs the same sentence sent
    from two devices into one thread within the same session, and the cost of
    one is a duplicate reading — the failure it replaces is the guaranteed one.

    A Set rather than a single value: two questions can be in flight at once now
    that turns run concurrently.
  */
  const askedHere = useRef<Set<string>>(new Set());

  /** One place that actually sends, so voice and the button cannot diverge. */
  const sendText = useCallback(
    async (text: string, resources: JobResource[] = []) => {
      if (!text.trim() || jobs.busy) return;
      setExpanded(true);
      // Before sending, so a fast reply cannot arrive before the record of
      // having asked for it.
      askedHere.current.add(text.trim());

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
        if (live) await jobs.send(live, text, resources);
        else await jobs.create(text, undefined, resources, worker ?? undefined);
      } catch (err) {
        /*
          A job can also disappear between the check and the send — another
          device clearing, or a restart landing in that gap. Losing what he
          just said to a race is worse than quietly starting a new thread.
        */
        if (String((err as Error)?.message ?? "").includes("no such job")) {
          try {
            await jobs.create(text, undefined, resources, worker ?? undefined);
          } catch {
            /* useJobs owns the error surface; it renders below. */
          }
        }
      }
    },
    [jobs, worker],
  );

  function addFiles(files: FileList | null) {
    if (!files?.length) return;
    setAttachments((current) => {
      const next = [...current];
      for (const file of Array.from(files)) {
        const dup = next.some(
          (item) => item.name === file.name && item.size === file.size && item.lastModified === file.lastModified,
        );
        if (!dup) next.push(file);
      }
      return next;
    });
    // Reset the input value so picking the SAME file again re-fires onChange.
    if (fileRef.current) fileRef.current.value = "";
  }

  const send = async () => {
    const text = draft.trim();
    if (!text || jobs.busy) return;
    setUploading(true);
    const resources = attachments.length ? await jobs.upload(attachments) : [];
    setUploading(false);
    if (resources === null) return;
    setDraft("");
    setAttachments([]);
    setExpanded(true);
    // One path for both, so the button and the voice cannot diverge — which is
    // how only one of them carried the stale-id bug.
    await sendText(text, resources);
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
    /*
      Speak the acknowledgement, not just the answer.

      A long turn used to be four minutes of silence — "did it even hear me".
      The server emits an `accepted` event the instant it decides what to do
      with a request, so Operator can say what it is doing before it has done
      it. The wording lives here rather than on the server because the server
      emits a FACT (started or queued, which worker, what is ahead) and a fact
      is not a sentence. Generating one with a model would be a model call on
      the fast path, which is the thing this design exists to avoid.
    */
    /*
      A different thread — including the first one to load — is history, not
      news. Jump the marker to the end and say nothing.
    */
    const jobId = jobs.selected?.id ?? null;
    if (spokenForJob.current !== jobId) {
      spokenForJob.current = jobId;
      spokenTo.current = messages.length - 1;
      return;
    }

    if (!speech.enabled) {
      // Keep the marker level with the thread while muted, or unmuting would
      // read out everything that arrived in the meantime.
      spokenTo.current = messages.length - 1;
      return;
    }
    /*
      Whether the turn currently being answered was asked FROM THIS DEVICE.

      Walked forward with the messages rather than decided up front, because a
      thread can hold answers to several questions and they can come from
      different devices. Each `prompt` event flips it, so the replies that
      follow are read aloud only where the question was typed or spoken.

      Defaults to false at the top of a thread: an answer with no prompt in
      front of it is history, and nobody in this room asked for it.
    */
    let mine = false;

    for (let i = spokenTo.current + 1; i < messages.length; i++) {
      const e = messages[i];
      if (e.type === "prompt") {
        mine = askedHere.current.has(String(e.text ?? "").trim());
        continue;
      }
      if (!mine) continue;
      if (e.type === "accepted") {
        const worker = e.provider === "claude-code" ? "Claude" : e.provider === "gemini" ? "Gemini" : "the local model";
        speech.speak(
          e.started
            ? `Got it. ${worker} is on it.`
            : e.ahead && e.ahead > 0
              ? `Got it. That will wait behind ${e.ahead === 1 ? "one job" : `${e.ahead} jobs`}.`
              : "Got it. Starting shortly.",
        );
        continue;
      }
      if (e.type === "text" && !e.error && e.text?.trim()) speech.speak(e.text);
    }
    spokenTo.current = messages.length - 1;
  }, [messages, speech, jobs.selected?.id]);

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

  /*
    No lock screen any more.

    This used to refuse everything when the terminal was disarmed, and that
    became a lie the moment the gate moved to the WORKER: talking to Operator
    needs no arming, only reaching Claude Code does. The owner watched it say
    "arm the terminal to start a job" immediately after starting one.

    What `authorised: false` now means is narrower — Claude Code is out of
    reach — so it is said once, quietly, beneath the input rather than in place
    of it.
  */

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
              ) : e.type === "accepted" ? null : e.type === "permission_answer" ? (
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

      {!jobs.authorised && (
        <p className="mb-2 text-[11px] text-ink-700 leading-relaxed">
          Claude Code needs the terminal armed — everything else answers without it.
        </p>
      )}

      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {attachments.map((file) => (
            <span
              key={`${file.name}-${file.lastModified}-${file.size}`}
              className="inline-flex items-center gap-1 rounded-badge border border-base-600 bg-base-700/40 pl-2 pr-1 h-8 text-xs text-ink-400 max-w-full"
            >
              <Paperclip size={11} className="shrink-0 text-ink-600" />
              <span className="truncate max-w-[13rem]">{file.name}</span>
              <button
                type="button"
                onClick={() => setAttachments((current) => current.filter((item) => item !== file))}
                aria-label={`Remove ${file.name}`}
                disabled={uploading}
                className="w-7 h-7 shrink-0 rounded-badge text-ink-600 hover:text-ink-100 transition-colors"
              >
                <X size={13} className="mx-auto" />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="flex items-end gap-2">
        <input
          ref={fileRef}
          type="file"
          multiple
          className="sr-only"
          onChange={(e) => addFiles(e.target.files)}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={jobs.busy || uploading}
          aria-label="Attach files"
          title="Attach files (up to 10 MB each)"
          className="shrink-0 min-h-[48px] min-w-[48px] rounded-badge border border-base-600 flex items-center justify-center text-ink-500 hover:text-ink-100 hover:border-base-500 disabled:opacity-40 transition-colors"
        >
          {uploading ? <Loader2 size={16} className="animate-spin" /> : <Paperclip size={16} />}
        </button>
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
