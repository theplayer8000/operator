import { useEffect, useRef, useState } from "react";
import {
  MessageSquare,
  Send,
  Plus,
  ShieldAlert,
  ChevronRight,
  Loader2,
  Power,
  Volume2,
  VolumeX,
  Square,
  Wrench,
  FileText,
  History,
  Paperclip,
  X,
  RotateCcw,
  ChevronDown,
  ChevronUp,
  Route,
} from "lucide-react";
import Markdown from "@/components/ui/Markdown";
import ConfirmButton from "@/components/ui/ConfirmButton";
import { useJobs, type JobAttempt, type JobEvent, type JobSummary } from "@/hooks/useJobs";
import { useSpeech } from "@/hooks/useSpeech";

/**
 * The orchestrator's conversation surface — was `dev/ClaudeChat.tsx`, renamed
 * and moved 2026-08-20.
 *
 * It kept the Claude name for one commit while it genuinely only spoke to one
 * worker; that stopped being true the moment `server/gemini.mjs` registered a
 * second. Nothing in here is provider-specific any more: the heading, the
 * placeholder, the model chips and the footer all read the selected job's
 * provider and its declared `capabilities`, rather than assuming Claude Code's.
 * A component named for one implementation of an interface it now renders
 * generically is a comment that lies by filename.
 *
 * Each conversation is a **job** with an append-only event log, so this shows
 * two things the old chat couldn't: a strip of jobs to switch between, and what
 * the worker is doing *while* it does it — which file it read, which command it
 * ran. Ten minutes of "working…" is a spinner; ten minutes of watching it read
 * three files and run a build is information.
 *
 * Polls rather than streams, for the reason the terminal established: stream
 * readers deliver nothing on the owner's iPhone, and a reply that silently
 * never appears is worse than a slow one.
 */

const STATUS_TONE: Record<string, string> = {
  running: "text-xp",
  queued: "text-rank",
  complete: "text-ink-500",
  failed: "text-vital-down",
  blocked: "text-vital-down",
  cancelled: "text-ink-700",
};

/** Matches the server's own check in `jobs.mjs`'s `retry()` — keep them in step. */
const RETRYABLE = new Set(["failed", "blocked", "cancelled"]);

/**
 * Whether the work holds up, not just whether the turn ended.
 *
 * `verification` was `not-run` on every job ever created until the gates
 * started running, and a verdict nobody can see is the same as no verdict.
 *
 * **`skipped` is not shown at all.** It is the common case — most jobs answer a
 * question and change nothing — and a permanent "skipped" badge would train the
 * eye to ignore the row that matters. Silence means nothing to check; a badge
 * means something was.
 */
function Verification({
  verification,
}: {
  verification: NonNullable<NonNullable<JobSummary["task"]>["verification"]>;
}) {
  const [open, setOpen] = useState(false);
  const { status, note, checks = [] } = verification;
  /*
    The model's opinion, rendered as a SEPARATE line beneath the gates.

    Deliberately not folded into `status`, which is what the badge colours on.
    The gates cannot be wrong; this is a 3B model's guess, and letting a guess
    paint the badge red would make the two kinds of certainty indistinguishable
    at exactly the moment the difference matters.
  */
  const semantic = (verification as { semantic?: { verdict?: string; note?: string; model?: string } })
    .semantic;

  if (status === "skipped" || status === "not-run") return null;

  const style =
    status === "passed"
      ? "border-vital-up/30 bg-vital-up/5 text-vital-up"
      : status === "failed"
        ? "border-vital-down/40 bg-vital-down/10 text-vital-down"
        : status === "running"
          ? "border-base-600 bg-base-700/30 text-ink-500"
          : "border-xp/30 bg-xp/5 text-xp";

  const failures = checks.filter((c) => !c.passed);

  return (
    <div className={`rounded-badge border px-3 py-2 mb-3 text-[11px] ${style} animate-fade-up`}>
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={checks.length === 0}
        className="flex items-center gap-2 w-full text-left disabled:cursor-default"
      >
        {status === "running" ? (
          <span className="flex items-center gap-0.5 shrink-0" aria-hidden>
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="w-1 h-1 rounded-full bg-current animate-breathe"
                style={{ animationDelay: `${i * 0.22}s` }}
              />
            ))}
          </span>
        ) : (
          <ShieldAlert size={12} className="shrink-0" />
        )}
        <span className="font-mono">
          {status === "running" ? "checking" : status === "passed" ? "checks passed" : status}
        </span>
        <span className="text-ink-700 truncate">{note}</span>
        {checks.length > 0 && (
          <ChevronRight
            size={12}
            className={`ml-auto shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
          />
        )}
      </button>

      {/*
        Only when it has something to say. `unsure` is hidden: a permanent
        "the model could not tell" line is furniture, and the existing badge
        already hides `skipped` on exactly that argument.
      */}
      {semantic && semantic.verdict !== "unsure" && (
        <p
          className={`mt-1.5 pt-1.5 border-t border-current/15 text-[11px] ${
            semantic.verdict === "mismatch" ? "text-xp" : "text-ink-600"
          }`}
        >
          <span className="font-mono">
            {semantic.verdict === "mismatch" ? "may not match the request" : "matches the request"}
          </span>
          {semantic.note ? <span className="text-ink-700"> — {semantic.note}</span> : null}
        </p>
      )}

      {open && (
        <ul className="mt-2 space-y-1 font-mono text-[10px]">
          {checks.map((c) => (
            <li key={c.name}>
              <span className={c.passed ? "text-ink-700" : "text-vital-down"}>
                {c.passed ? "ok  " : "FAIL"} {c.name} · {c.ms}ms
              </span>
              {/* The failing output is the whole point — "tsc failed" tells
                  nobody anything, the line naming the file does. */}
              {c.output && (
                <pre className="mt-1 p-2 rounded-badge bg-base-950/60 border border-base-600 text-ink-300 whitespace-pre-wrap break-all max-h-40 overflow-y-auto">
                  {c.output}
                </pre>
              )}
            </li>
          ))}
        </ul>
      )}

      {!open && failures.length > 0 && (
        <p className="mt-1 text-ink-500">Tap to see what failed.</p>
      )}
    </div>
  );
}

/**
 * A retry history — one line per dispatch of this job's prompt to a worker.
 *
 * Deliberately absent below two attempts. One attempt is just how the job ran;
 * it becomes a *history* worth reading only once there is more than one outcome
 * to compare, which is also the exact moment `retry` starts being interesting
 * rather than decorative. Sits right above the Retry button it explains — you
 * press it having just read why the last one didn't work.
 */
function AttemptHistory({ attempts }: { attempts: JobAttempt[] }) {
  const [open, setOpen] = useState(false);
  if (attempts.length < 2) return null;

  return (
    <div className="mb-2">
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 text-[11px] font-mono text-ink-700 hover:text-ink-300 transition-colors"
      >
        {open ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
        {attempts.length} attempts
      </button>
      {open && (
        <ul className="mt-1.5 space-y-1">
          {attempts.map((a) => (
            <li key={a.number} className="text-[11px] font-mono text-ink-700 break-words">
              <span className="text-ink-500">#{a.number}</span> {a.model}{" "}
              <span className={STATUS_TONE[a.status] ?? "text-ink-500"}>{a.status}</span>
              {a.error ? <span className="text-vital-down"> — {a.error}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ago(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

/** How a question ended, in the words the log should use. */
const ANSWER_TONE: Record<string, { tone: string; label: string }> = {
  allowed: { tone: "text-vital-up", label: "you allowed it" },
  denied: { tone: "text-ink-500", label: "you said no" },
  timeout: { tone: "text-ink-700", label: "no answer in time — treated as no" },
  cancelled: { tone: "text-ink-700", label: "you stopped the job" },
  abandoned: { tone: "text-ink-700", label: "the turn ended first" },
};

/** One event, rendered in the register its type deserves. */
function Event({
  event,
  answers,
  answering,
  onAnswer,
}: {
  event: JobEvent;
  /** Questions already settled, by id — so a live card knows it isn't live. */
  answers: Record<string, JobEvent>;
  /** Ids with a tap in flight, so the buttons can't be double-fired. */
  answering: Record<string, boolean>;
  onAnswer: (id: string, decision: "allow" | "deny", remember: boolean) => void;
}) {
  switch (event.type) {
    case "prompt":
      return (
        <div className="flex justify-end">
          <div className="max-w-[85%] rounded-badge bg-base-700/50 border border-base-600 px-3 py-2 text-sm text-ink-100 whitespace-pre-wrap break-words">
            {event.text}
          </div>
        </div>
      );

    case "text":
      return (
        <div
          className={`text-sm leading-relaxed break-words ${
            event.error ? "text-vital-down" : "text-ink-300"
          }`}
        >
          {event.raw ? (
            <pre className="font-mono text-[11px] whitespace-pre-wrap">{event.text}</pre>
          ) : (
            <Markdown text={event.text ?? ""} />
          )}
        </div>
      );

    /*
      Tool activity is the point of the job model, but it is not the reply — so
      it reads as a margin note rather than as something Claude said. Dense,
      monospaced, one line each.
    */
    case "tool_use":
      return (
        <div className="flex items-start gap-2 text-[11px] font-mono text-ink-700">
          <Wrench size={11} className="mt-0.5 shrink-0 text-rank" />
          <span className="text-ink-500">{event.tool}</span>
          <span className="truncate">{event.subject}</span>
        </div>
      );

    case "tool_result":
      if (!event.text?.trim()) return null;
      return (
        <details className="text-[11px] font-mono text-ink-700 ml-[19px]">
          <summary className={`cursor-pointer ${event.ok ? "text-ink-700" : "text-vital-down"}`}>
            {event.ok ? "result" : "error"} · {event.text.split("\n").length} lines
          </summary>
          <pre className="mt-1 p-2 rounded-badge bg-base-950/60 border border-base-600 overflow-x-auto whitespace-pre-wrap max-h-48 overflow-y-auto">
            {event.text}
          </pre>
        </details>
      );

    /*
      A permission is the one event that needs an action, so it is the one event
      that looks like a card. Three of them share this event type, and which one
      renders is decided in this order — the order matters, because getting it
      wrong is how a permission that had just been *allowed* came to render as
      "it couldn't ask, so it stopped", in red, above the line saying it was
      allowed:

        1. has an `id`   → the SDK path owns it. Waiting: the question, with
                           buttons. Settled: nothing, because
                           `permission_answer` below already says how it ended.
        2. `standing`    → publishing or deleting. **Never a question** — the
                           deny list is a deny, and deny beats allow, so a grant
                           button here would write a rule that sits in
                           settings.local.json looking effective and is refused
                           every time. That is the silently-inert grant the
                           Windows path bug produced, and it took three denied
                           grants to spot. The card hands over the command
                           instead, which is what the profile says should happen.
        3. neither       → the CLI fallback, which genuinely cannot ask. A
                           report of something already over, with no button.
    */
    /*
      Routing that happens silently is indistinguishable from routing that is
      broken. Shown as a margin note rather than a card: it is context for the
      reply beneath it, not something needing an action — but it has to be
      visible, both to earn trust and to make a bad decision noticeable on the
      day the router starts getting it wrong.
    */
    case "routed":
      return (
        <p className="flex items-start gap-2 text-[11px] font-mono text-ink-700">
          <Route size={11} className="mt-0.5 shrink-0 text-rank" />
          <span>
            <span className="text-ink-500">{event.label ?? event.provider}</span>
            {event.why ? ` — ${event.why}` : ""}
          </span>
        </p>
      );

    case "permission_answer": {
      const shown = ANSWER_TONE[event.decision ?? ""] ?? { tone: "text-ink-700", label: "settled" };
      return (
        <p className={`text-[11px] font-mono ${shown.tone} ml-[19px]`}>
          {shown.label}
          {event.by ? ` · from ${event.by}` : ""}
        </p>
      );
    }

    case "permission_request": {
      /*
        **An `id` means the SDK path owns this event, and nothing below applies.**

        Two states, and only two: still waiting, or settled. There is no third
        one where a grant button helps — the turn either resumed or it didn't,
        and `permission_answer` right underneath already says which.

        Falling through to the CLI card once `answers[id]` was set produced a
        genuine contradiction on screen: a permission that had just been allowed
        rendered as "it couldn't ask, so it stopped", in red, with a grant
        button, directly above "you allowed it · from tosin-pc".
      */
      if (event.id) {
        const id = event.id;
        /*
          Answered. Deliberately renders nothing rather than a second line:
          `tool_use` above already names what was asked, and
          `permission_answer` below already reports how it ended. A third
          element between them would be the same fact a third time.
        */
        if (answers[id]) return null;
        const busy = answering[id] === true;
        return (
          <div className="rounded-badge border border-xp/40 bg-xp/5 p-3 space-y-3">
            <div className="flex items-center gap-2 text-xs text-xp">
              <ShieldAlert size={13} className="shrink-0" />
              Waiting on you — it&apos;s holding the turn open
            </div>

            {/* The bridge's own sentence when there is one; it knows things the
                server doesn't, like which path inside a command triggered the
                ask. */}
            <p className="text-sm text-ink-100 break-words">
              {event.title || `Claude wants to use ${event.tool}`}
            </p>
            {/*
              Capped and scrollable, and that is not cosmetic.

              `subject` is the whole command, and a `log-update.mjs` call
              carries a paragraph of prose. Uncapped, the block grew until the
              Allow button was below the fold on a phone — so the card looked
              like it had been tapped and ignored, which is indistinguishable
              from a denial from the agent's side. Found by using it: a short
              command was answered immediately while a long one was
              "refused" twice.

              The buttons must stay reachable without scrolling the card,
              whatever Claude is asking to run.
            */}
            {event.subject ? (
              <pre className="p-2 rounded-badge bg-base-950/60 border border-base-600 font-mono text-[11px] text-ink-300 max-h-24 overflow-y-auto overflow-x-auto whitespace-pre-wrap break-all">
                {event.subject}
              </pre>
            ) : null}

            {/* 44px, and side by side rather than stacked — the two answers
                should look like two answers, not a primary action with an
                afterthought under it. */}
            <div className="flex gap-2">
              <button
                onClick={() => onAnswer(id, "allow", false)}
                disabled={busy}
                className="flex-1 min-h-[44px] px-3 rounded-badge border border-xp/50 bg-xp/15 text-sm text-xp hover:bg-xp/25 disabled:opacity-50 transition-colors"
              >
                {busy ? "…" : "Allow"}
              </button>
              <button
                onClick={() => onAnswer(id, "deny", false)}
                disabled={busy}
                className="flex-1 min-h-[44px] px-3 rounded-badge border border-base-600 text-sm text-ink-300 hover:border-base-500 hover:text-ink-100 disabled:opacity-50 transition-colors"
              >
                No
              </button>
            </div>

            {/*
              Deliberately below, quieter, and full width — a mis-tap here is
              not the same size of mistake as a mis-tap on Allow, so it should
              not sit next to it looking like a peer.
            */}
            <button
              onClick={() => onAnswer(id, "allow", true)}
              disabled={busy}
              className="w-full min-h-[44px] px-3 rounded-badge border border-base-600 text-xs text-ink-500 hover:text-ink-300 hover:border-base-500 disabled:opacity-50 transition-colors"
            >
              Allow, and stop asking about this one
            </button>
            <p className="text-[11px] text-ink-700">
              Until the server restarts. It won&apos;t ask about publishing or deleting either
              way — those are yours.
            </p>
          </div>
        );
      }

      if (event.standing) {
        return (
          <div className="rounded-badge border border-rank/30 bg-rank/5 p-3 space-y-2">
            <div className="flex items-center gap-2 text-xs text-rank">
              <ShieldAlert size={13} className="shrink-0" />
              Yours to run — Claude never does this one
            </div>
            <p className="text-xs text-ink-500 leading-relaxed">
              Publishing and deleting are the two that can&apos;t be taken back, so they stay
              with you. Everything else it can do itself.
            </p>
            {/*
              Selectable text, not a copy button: Operator runs at a bare IP over
              Tailscale, so `navigator.clipboard` doesn't exist there (OPS-001's
              underlying constraint). A copy button would be dead on the one
              device this page is used from.
            */}
            <pre className="p-2 rounded-badge bg-base-950/60 border border-base-600 font-mono text-[11px] text-ink-300 overflow-x-auto whitespace-pre-wrap break-all">
              {event.subject || event.tool}
            </pre>
            <p className="text-[11px] text-ink-700">
              Run it in the terminal on the Dev page, then tell Claude it&apos;s done.
            </p>
          </div>
        );
      }

      /*
        No `id`, so this is the **CLI fallback** (`OPERATOR_JOB_RUNNER=cli`),
        which genuinely cannot ask: print mode has no channel to answer on, so
        the turn ended at the refusal and this is a report of something already
        over.

        **No grant button.** It used to write a rule into
        `.claude/settings.local.json`, which the SDK path does not need — a
        refusal there is a question, not a dead end. Offering it here would be
        offering the old workaround for a problem this runner doesn't have, and
        the rule it writes shadows `canUseTool` silently if the runner is ever
        switched back.
      */
      return (
        <div className="rounded-badge border border-vital-down/30 bg-vital-down/5 p-3 space-y-2">
          <div className="flex items-center gap-2 text-xs text-vital-down">
            <ShieldAlert size={13} className="shrink-0" />
            Needed permission — it couldn&apos;t ask, so it stopped
          </div>
          <p className="text-xs text-ink-500 break-words">
            <span className="font-mono text-ink-300">{event.tool}</span>
            {event.subject ? <span className="font-mono"> — {event.subject}</span> : null}
          </p>
          <p className="text-[11px] text-ink-700 leading-relaxed">
            This job is on the CLI runner, which can&apos;t stop and ask. Send it again once
            the tool is allowed, or run the command yourself from the Dev page.
          </p>
        </div>
      );
    }

    case "status":
      // Only the ends of a turn are worth a line; "running" is already obvious
      // from the spinner in the header.
      if (event.status === "running" || event.status === "queued") return null;
      return (
        <p className={`text-[11px] font-mono ${STATUS_TONE[event.status ?? ""] ?? "text-ink-700"}`}>
          {event.status}
          {event.detail ? ` — ${event.detail}` : ""}
        </p>
      );

    case "usage":
      return (
        <p
          className="text-[11px] font-mono text-ink-700"
          title="Claude Code reports this as the API-equivalent cost. On a subscription it is plan usage, not a charge."
        >
          {(event.turnUsd ?? 0).toFixed(4)} this turn · {(event.jobUsd ?? 0).toFixed(4)} this job
        </p>
      );

    default:
      return null;
  }
}

function Tab({
  job,
  active,
  running,
  onSelect,
}: {
  job: JobSummary;
  active: boolean;
  running: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      /*
        The ring only pulses on a tab that is running AND not the one you are
        looking at. On the open tab the "working…" line below already says so,
        and two things announcing the same state is noise. On a tab you cannot
        see, it is the only signal that anything is happening there.
      */
      className={`shrink-0 flex items-center gap-2 h-9 px-3 rounded-badge border text-xs transition-all duration-200 ${
        running && !active ? "animate-pulse-ring" : ""
      } ${
        active
          ? "border-xp/40 bg-xp/10 text-xp"
          : "border-base-600 text-ink-500 hover:text-ink-100 hover:border-base-500"
      }`}
    >
      {running ? (
        <span className="flex items-center gap-0.5 shrink-0" aria-label="working">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="w-1 h-1 rounded-full bg-current animate-breathe"
              style={{ animationDelay: `${i * 0.22}s` }}
            />
          ))}
        </span>
      ) : job.restored ? (
        <span title="From before a restart — Claude still remembers, the log doesn't">
          <History size={12} className="shrink-0 text-ink-700" />
        </span>
      ) : null}
      <span className="max-w-[140px] truncate">{job.title}</span>
      {job.queued > 0 && <span className="font-mono text-[10px] text-rank">+{job.queued}</span>}
      {/*
        A job that has stopped to ask looks exactly like one that is thinking —
        same spinner, same status — and the turn stays suspended until someone
        answers. If the only way to find that out is to have that tab open, a
        question asked while you are reading another one waits half an hour and
        then times out. So it is marked on the tab.
      */}
      {(job.asking ?? 0) > 0 && (
        <span
          title="Waiting on an answer from you"
          className="shrink-0 w-1.5 h-1.5 rounded-full bg-xp animate-pulse"
        />
      )}
    </button>
  );
}

export default function OrchestratorChat() {
  const j = useJobs();
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [retrying, setRetrying] = useState(false);
  /** Worker+model for the *next* new chat. Null means the server's default. */
  const [pendingModel, setPendingModel] = useState<{ provider: string; model: string } | null>(null);
  /*
    Whether the model row is scrolled to its end, so the fade can disappear
    rather than permanently implying there is more to the right. Starts true so
    a row that fits — one worker, two chips — shows no fade at all.
  */
  const modelRowRef = useRef<HTMLDivElement | null>(null);
  const [modelRowAtEnd, setModelRowAtEnd] = useState(true);

  const speech = useSpeech();
  /*
    The highest event sequence already spoken.

    Tracked rather than "speak the last text event", because the event list is
    re-fetched on every poll: without a watermark the same reply would be read
    again every couple of seconds. It also has to start at whatever is already
    on screen rather than at zero — opening a finished conversation must not
    recite the whole thread, which is what happens if the first poll counts as
    new.
  */
  const spokenUpTo = useRef<number | null>(null);

  useEffect(() => {
    // Switching conversations re-baselines: the new thread's history is not
    // "new" just because it arrived after the switch.
    spokenUpTo.current = null;
  }, [j.selectedId]);

  useEffect(() => {
    if (!speech.enabled) return;
    const latest = j.events.length ? j.events[j.events.length - 1].seq : 0;

    if (spokenUpTo.current === null) {
      spokenUpTo.current = latest;
      return;
    }
    if (latest <= spokenUpTo.current) return;

    /*
      Speak the worker's prose, and only that. A tool call, a permission
      question or an error is either not language or is something to be looked
      at rather than heard — an error read aloud while you are across the room
      tells you something is wrong and not what.
    */
    const fresh = j.events
      .filter((e) => e.seq > (spokenUpTo.current ?? 0) && e.type === "text" && !e.error)
      .map((e) => e.text ?? "")
      .filter(Boolean);

    spokenUpTo.current = latest;
    if (fresh.length) speech.speak(fresh.join(" "));
  }, [j.events, j.selectedId, speech]);

  /*
    Re-measure when the chips change, not just on scroll. A worker appearing
    mid-session is the normal case now: the local worker registers when Ollama
    comes up, which can be after this page is already open.
  */
  useEffect(() => {
    const el = modelRowRef.current;
    if (!el) return;
    const measure = () =>
      setModelRowAtEnd(el.scrollLeft + el.clientWidth >= el.scrollWidth - 4);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  });
  const [answering, setAnswering] = useState<Record<string, boolean>>({});
  const logRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  /*
    Which questions have been settled, keyed by id.

    Derived from the log rather than kept as state, because the log is the
    truth: the answer may have come from the other device, or from the timeout,
    and this client only finds out by reading it back. Holding a local "I
    answered that" flag would leave a stale Allow button on a phone that had
    already been overtaken.
  */
  const answers: Record<string, JobEvent> = {};
  for (const e of j.events) {
    if (e.type === "permission_answer" && e.id) answers[e.id] = e;
  }

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [j.events.length, j.busy]);

  async function retryTurn() {
    if (!j.selectedId || retrying) return;
    setRetrying(true);
    await j.retry(j.selectedId);
    setRetrying(false);
  }

  async function submit() {
    const text = draft.trim();
    if (!text) return;
    setUploading(true);
    const resources = attachments.length ? await j.upload(attachments) : [];
    setUploading(false);
    if (resources === null) return;
    setDraft("");
    setAttachments([]);
    if (j.selectedId) await j.send(j.selectedId, text, resources);
    else await j.create(text, pendingModel?.model, resources, pendingModel?.provider);
  }

  function addFiles(files: FileList | null) {
    if (!files?.length) return;
    setAttachments((current) => {
      const next = [...current];
      for (const file of Array.from(files)) {
        if (!next.some((item) => item.name === file.name && item.size === file.size && item.lastModified === file.lastModified)) next.push(file);
      }
      return next;
    });
    if (fileRef.current) fileRef.current.value = "";
  }

  /**
   * Answer a live question. The turn is suspended on it while this runs.
   *
   * The in-flight flag is not cosmetic: a tap on a phone that appears to do
   * nothing gets tapped again, and the second tap would land on a question the
   * first has already settled.
   */
  async function answer(id: string, decision: "allow" | "deny", remember: boolean) {
    if (!j.selectedId || answering[id]) return;
    setAnswering((p) => ({ ...p, [id]: true }));
    try {
      await j.answerPermission(j.selectedId, id, decision, remember);
    } finally {
      setAnswering((p) => {
        const next = { ...p };
        delete next[id];
        return next;
      });
    }
  }

  async function arm() {
    await fetch("/api/terminal/enable", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    }).catch(() => {});
    await j.refreshList();
  }

  const notAuthorised = j.list !== null && !j.authorised;
  const running = j.selectedId !== null && j.runningId === j.selectedId;
  /*
    "resume operator build" is a documented trigger in CLAUDE.md — it makes a
    cold session read the design doc and the latest handoff and ask the open
    decisions before touching anything. A phrase that only works if you remember
    it stops getting used, and an empty workspace is the one moment it is the
    right thing to type.
  */
  const fresh = j.authorised && j.jobs.length === 0;

  return (
    <section className="card-base p-4 sm:p-5 mb-5 animate-fade-up">
      <header className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <MessageSquare size={15} className="text-ink-500 shrink-0" />
          <div className="min-w-0">
            {/*
              The worker this conversation is actually talking to, not a fixed
              "Claude" — with two providers enabled, a heading that always says
              Claude is wrong half the time. Falls back to the label rather
              than the raw id so an unknown provider still reads as a name.
            */}
            <h2 className="font-display text-sm font-medium text-ink-300">
              {j.providers.find((p) => p.id === j.selected?.provider)?.label ??
                (j.selected ? j.selected.provider : "Orchestrator")}
            </h2>
            <p className="text-xs text-ink-700 truncate">
              {notAuthorised
                ? j.reason
                : j.selected
                  ? `${j.selected.turns} turn${j.selected.turns === 1 ? "" : "s"}` +
                    (j.selected.sessionId ? ` · session ${j.selected.sessionId.slice(0, 8)}` : "") +
                    ` · ${ago(j.selected.createdAt)}`
                  : "No conversations yet"}
            </p>
          </div>
        </div>
        {!notAuthorised && (
          <div className="flex items-center gap-2 shrink-0">
            {/*
              Speaking is off until asked for, and the preference is per-device
              (see useSpeech) — the desk can talk while the phone in a quiet
              room stays silent. Hidden entirely where the browser has no
              synthesis, rather than offered and inert.
            */}
            {speech.supported && (
              <button
                onClick={() => (speech.speaking ? speech.stop() : speech.setEnabled(!speech.enabled))}
                title={
                  speech.speaking
                    ? "Stop speaking"
                    : speech.enabled
                      ? "Speaking replies aloud — click to turn off"
                      : "Read replies aloud on this device"
                }
                aria-label={speech.enabled ? "Turn off spoken replies" : "Read replies aloud"}
                className={`w-11 h-11 shrink-0 rounded-badge border flex items-center justify-center transition-colors ${
                  speech.enabled
                    ? "border-xp/40 bg-xp/10 text-xp"
                    : "border-base-600 text-ink-700 hover:text-ink-300 hover:border-base-500"
                }`}
              >
                {speech.speaking ? (
                  <span className="flex items-center gap-0.5" aria-hidden>
                    {[0, 1, 2].map((i) => (
                      <span
                        key={i}
                        className="w-1 h-3 rounded-full bg-current animate-breathe"
                        style={{ animationDelay: `${i * 0.18}s` }}
                      />
                    ))}
                  </span>
                ) : speech.enabled ? (
                  <Volume2 size={15} />
                ) : (
                  <VolumeX size={15} />
                )}
              </button>
            )}
            {/*
              The voice picker appears only once speaking is on — a select for
              a feature that is off is a control for nothing. Grouped with the
              toggle rather than buried in Settings because choosing a voice is
              something you do WHILE listening to one.
            */}
            {speech.supported && speech.enabled && speech.voices.length > 0 && (
              <select
                value={speech.voiceName ?? ""}
                onChange={(e) => speech.setVoiceName(e.target.value || null)}
                title="Which voice Operator speaks with, on this device"
                aria-label="Operator's voice"
                className="hidden sm:block h-11 max-w-[150px] px-2 rounded-badge border border-base-600 bg-base-800 text-[11px] text-ink-500 hover:text-ink-300 focus:outline-none focus:border-xp/40"
              >
                <option value="">Default voice</option>
                {speech.voices.map((v) => (
                  <option key={v.name} value={v.name}>
                    {v.name.replace(/^Microsoft\s+/, "").replace(/\s+-\s+English.*$/, "")}
                  </option>
                ))}
              </select>
            )}
            {j.jobs.length > 0 && (
              <ConfirmButton onConfirm={() => void j.clearAll()} label="Clear all conversations" compact />
            )}
            <button
              onClick={() => j.startNew()}
              className="flex items-center gap-1.5 px-3 min-h-[44px] rounded-badge border border-base-600 text-xs text-ink-500 hover:text-ink-100 hover:border-base-500 transition-colors"
            >
              <Plus size={14} />
              New chat
            </button>
          </div>
        )}
      </header>

      {notAuthorised && (
        <div className="rounded-badge border border-base-600 bg-base-700/30 p-3 text-sm text-ink-500 leading-relaxed">
          {j.reason}
          {j.canManage && (
            <button
              onClick={() => void arm()}
              className="mt-3 flex items-center gap-2 min-h-[44px] px-3 rounded-badge border border-xp/40 bg-xp/10 text-xs text-xp hover:bg-xp/20 transition-colors"
            >
              <Power size={14} /> Arm it for this session
            </button>
          )}
        </div>
      )}

      {!notAuthorised && (
        <>
          {j.jobs.length > 0 && (
            <div className="flex gap-2 overflow-x-auto scrollbar-none pb-2 mb-3">
              {j.jobs.map((job) => (
                <Tab
                  key={job.id}
                  job={job}
                  active={job.id === j.selectedId}
                  running={job.id === j.runningId}
                  onSelect={() => void j.select(job.id)}
                />
              ))}
            </div>
          )}

          <div
            ref={logRef}
            className="space-y-2.5 max-h-[26rem] overflow-y-auto mb-3 pr-1"
          >
            {j.selectedId === null ? (
              <p className="text-sm text-ink-700 leading-relaxed">
                {j.jobs.length === 0
                  ? "Nothing yet. Ask it something and it starts a conversation that remembers — pick it up from any of your devices."
                  : "New conversation. What you send starts a fresh one."}
              </p>
            ) : j.events.length === 0 ? (
              /*
                Whether a restored tab remembers depends on the worker, and
                saying "it still remembers" for one that doesn't would be a lie
                the owner only discovers by being confused at the reply. Claude
                Code holds its session on disk and genuinely resumes; Gemini's
                history lives in this server's memory and died with the old
                process. `sessions` in the provider's capabilities is what
                distinguishes them.
              */
              <p className="text-sm text-ink-700">
                {!j.selected?.restored
                  ? "No events yet."
                  : j.providers.find((p) => p.id === j.selected?.provider)?.capabilities
                      ?.sessions === "in-memory"
                    ? "From before a restart — this worker keeps its history in memory, so it starts fresh. Earlier turns are gone."
                    : "From before a restart — the log isn't kept, but the worker still remembers. Send a message to carry on."}
              </p>
            ) : (
              /*
                Wrapped rather than animated inside Event, which switches on
                type and would need the class in seven places.

                Only genuinely NEW events animate. The list re-renders on every
                poll, but `key={e.seq}` is stable so React reuses the node and
                the animation does not re-fire — the whole log would otherwise
                flicker every couple of seconds, which is the opposite of
                lively.
              */
              j.events.map((e) => (
                <div key={e.seq} className="animate-slip-in">
                  <Event
                    event={e}
                    answers={answers}
                    answering={answering}
                    onAnswer={(id, decision, remember) => void answer(id, decision, remember)}
                  />
                </div>
              ))
            )}
            {running &&
              // "working…" under a question it has stopped for is the one thing
              // this line must not say — it reads as "no action needed" beneath
              // the card that needs one.
              ((j.selected?.asking ?? 0) > 0 ? (
                /*
                  Deliberately still, and the stillness is the message: it is
                  not working, it is stopped and waiting on you. A spinner here
                  would say the opposite of what is true.
                */
                <p className="flex items-center gap-2 text-xs text-xp animate-fade-up">
                  <ShieldAlert size={13} className="shrink-0" /> holding — waiting on your answer
                  above
                </p>
              ) : (
                /*
                  Breathing rather than spinning. A spinner is the vocabulary of
                  a wait with a known end — a page loading — and a turn has no
                  known end. Three dots out of phase read as thinking, and stay
                  legible from across a desk, which is where this is usually
                  read from.
                */
                <p className="flex items-center gap-2 text-xs text-xp animate-fade-up">
                  <span className="flex items-center gap-1" aria-hidden>
                    {[0, 1, 2].map((i) => (
                      <span
                        key={i}
                        className="w-1.5 h-1.5 rounded-full bg-xp animate-breathe"
                        style={{ animationDelay: `${i * 0.22}s` }}
                      />
                    ))}
                  </span>
                  working…
                </p>
              ))}
          </div>

          {j.selected?.task?.verification && (
            <Verification verification={j.selected.task.verification} />
          )}

          {j.selected?.attempts && <AttemptHistory attempts={j.selected.attempts} />}

          {j.error && <p className="text-xs text-vital-down mb-2 break-words">{j.error}</p>}

          {/*
            Only for a job that has actually stopped this way — never while
            running or queued, which `RETRYABLE` mirrors from the server's own
            check so the button doesn't offer something `retry()` will refuse.
            A restart-orphaned attempt is still offered: the server's refusal
            ("send the instruction again") lands in `j.error` above, which
            teaches the one real limit without the button pre-guessing it.
          */}
          {j.selected && RETRYABLE.has(j.selected.status) && (
            <button
              onClick={() => void retryTurn()}
              disabled={retrying}
              className="mb-2 inline-flex items-center gap-1.5 min-h-[36px] px-3 rounded-badge border border-base-600 text-xs text-ink-300 hover:text-ink-100 hover:border-base-500 disabled:opacity-50 transition-colors"
            >
              <RotateCcw size={13} className={retrying ? "animate-spin" : undefined} />
              {retrying ? "Retrying…" : "Retry this turn"}
            </button>
          )}

          {/*
            Sending while a question is outstanding queues the message behind a
            turn that cannot move — so it reads as a stuck job you just nudged,
            when really you added a second thing behind a blocked one. Say so
            rather than blocking it: the card may well be scrolled off, and
            refusing the send with no visible reason would be worse.
          */}
          {(j.selected?.asking ?? 0) > 0 && (
            <p className="flex items-start gap-2 mb-2 text-xs text-xp">
              <ShieldAlert size={13} className="shrink-0 mt-0.5" />
              <span>
                A question is waiting above — answer it and this turn carries on. Anything you
                send now waits in the queue until then.
              </span>
            </p>
          )}

          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-2">
              {attachments.map((file) => (
                <span key={`${file.name}-${file.lastModified}-${file.size}`} className="inline-flex items-center gap-1 rounded-badge border border-base-600 bg-base-700/40 pl-2 pr-1 h-8 text-xs text-ink-400 max-w-full">
                  <Paperclip size={11} className="shrink-0 text-ink-600" />
                  <span className="truncate max-w-[13rem]">{file.name}</span>
                  <button
                    type="button"
                    onClick={() => setAttachments((current) => current.filter((item) => item !== file))}
                    aria-label={`Remove ${file.name}`}
                    className="w-7 h-7 shrink-0 rounded-badge text-ink-600 hover:text-ink-100 transition-colors"
                  >
                    <X size={13} className="mx-auto" />
                  </button>
                </span>
              ))}
            </div>
          )}

          <div className="flex items-end gap-2">
            <input ref={fileRef} type="file" multiple className="sr-only" onChange={(e) => addFiles(e.target.files)} />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={running || uploading}
              aria-label="Attach files"
              title="Attach files (up to 10 MB each)"
              className="w-11 h-11 shrink-0 rounded-badge border border-base-600 flex items-center justify-center text-ink-500 hover:text-ink-100 hover:border-base-500 disabled:opacity-40 transition-colors"
            >
              <Paperclip size={15} />
            </button>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void submit();
                }
              }}
              rows={2}
              placeholder={
                fresh
                  ? "resume operator build"
                  : j.selected
                    ? `Ask ${
                        j.providers.find((p) => p.id === j.selected?.provider)?.label ?? "it"
                      }…`
                    : "Ask about this project…"
              }
              className="flex-1 min-w-0 bg-base-700/40 border border-base-600 rounded-badge px-3 py-2 text-base sm:text-sm text-ink-100 placeholder:text-ink-700 outline-none focus:border-xp/50 resize-none transition-colors"
            />
            {running ? (
              <button
                onClick={() => void j.cancel(j.selectedId as string)}
                aria-label="Stop"
                title="Stop this turn"
                className="w-11 h-11 shrink-0 rounded-badge border border-vital-down/40 bg-vital-down/10 flex items-center justify-center text-vital-down hover:bg-vital-down/20 transition-colors"
              >
                <Square size={14} />
              </button>
            ) : (
              <button
                onClick={() => void submit()}
                disabled={!draft.trim() || uploading}
                aria-label="Send"
                className="w-11 h-11 shrink-0 rounded-badge border border-xp/40 bg-xp/10 flex items-center justify-center text-xp hover:bg-xp/20 disabled:text-ink-700 disabled:border-base-600 disabled:bg-transparent transition-colors"
              >
                {uploading ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              </button>
            )}
          </div>

          {/*
            Two jobs for one row of chips, because which one it is depends on
            whether a conversation exists yet:

            - **No job selected (a new chat)** — every enabled worker's models,
              and tapping one chooses the worker this conversation will use.
              That choice is only available here: a job holds one worker's
              session for its whole life, and the two aren't interchangeable
              (Claude Code owns a session on disk, Gemini's is a replayed
              history in memory). Offering a switch mid-thread would silently
              start a new conversation wearing the old one's tab.
            - **A job selected** — only that worker's own models, which is the
              switch that has always worked (Opus ↔ Sonnet keeps the session).

            Grouped by worker only when there is more than one; a lone "Claude
            Code" label above two chips is noise.
          */}
          <div className="flex items-center justify-between gap-3 mt-2">
            {/*
              `min-w-0` is load-bearing, not tidying. A flex child will not
              shrink below its content's intrinsic width without it, so this row
              grew past the card and clipped its last chips instead of
              scrolling — `overflow-x-auto` never got the chance to apply. With
              three workers and seven models the cut-off ones were simply
              unreachable, which is what the owner reported.

              The fade on the right is the affordance: `scrollbar-none` hides
              the scrollbar, so without it there is nothing on screen saying
              more chips exist. It is masked out once the row is scrolled to the
              end so it does not imply content that isn't there.
            */}
            <div className="relative min-w-0 flex-1">
              {/*
                A scrollable row a mouse cannot scroll is not scrollable.

                min-w-0 above fixed the mechanics and the row still could not be
                reached: a vertical wheel does not scroll a horizontal box, and
                scrollbar-none removes the bar you would otherwise drag. On a
                phone it worked the whole time, which is exactly why it survived
                a round of "fixed" — the desk is where it was broken.

                So: the wheel drives it, and it can be dragged. Both convert to
                scrollLeft rather than moving anything, so the chips stay
                ordinary buttons and a click still selects.
              */}
              <div
                ref={modelRowRef}
                onScroll={(e) => {
                  const el = e.currentTarget;
                  setModelRowAtEnd(el.scrollLeft + el.clientWidth >= el.scrollWidth - 4);
                }}
                onWheel={(e) => {
                  const el = e.currentTarget;
                  if (el.scrollWidth <= el.clientWidth) return;
                  // A trackpad already sends deltaX; a wheel only sends deltaY.
                  const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
                  el.scrollLeft += delta;
                }}
                onPointerDown={(e) => {
                  // Ignore the buttons themselves, or dragging would fight
                  // clicking a model.
                  if ((e.target as HTMLElement).closest("button")) return;
                  const el = e.currentTarget;
                  const startX = e.clientX;
                  const startScroll = el.scrollLeft;
                  el.setPointerCapture(e.pointerId);
                  const move = (ev: PointerEvent) => {
                    el.scrollLeft = startScroll - (ev.clientX - startX);
                  };
                  const up = () => {
                    el.releasePointerCapture(e.pointerId);
                    el.removeEventListener("pointermove", move);
                    el.removeEventListener("pointerup", up);
                  };
                  el.addEventListener("pointermove", move);
                  el.addEventListener("pointerup", up);
                }}
                className="flex items-center gap-2.5 overflow-x-auto scrollbar-none cursor-grab active:cursor-grabbing"
              >
              {/*
                Auto is the default and sits first, because choosing from a row
                of chips is a menu and the orchestrator is meant to decide. The
                explicit models stay as an override for when he knows better
                than the router — but nothing has to be picked to start a job.

                Only offered when there is a decision to make: with one worker
                enabled, "Auto" and its single alternative are the same thing
                said twice.
              */}
              {!j.selectedId && j.providers.length > 1 && (
                <button
                  onClick={() => setPendingModel(null)}
                  disabled={running}
                  title="Let the orchestrator pick the worker for this task"
                  className={`shrink-0 px-2.5 h-8 rounded-badge border text-[11px] transition-colors disabled:opacity-40 ${
                    pendingModel === null
                      ? "border-rank/50 bg-rank/10 text-rank"
                      : "border-base-600 text-ink-700 hover:text-ink-300"
                  }`}
                >
                  Auto
                </button>
              )}
              {(j.selectedId
                ? j.providers.filter((p) => p.id === (j.selected?.provider ?? "claude-code"))
                : j.providers
              ).map((provider) => (
                <div key={provider.id} className="flex items-center gap-1.5 shrink-0">
                  {!j.selectedId && j.providers.length > 1 && (
                    <span className="text-[10px] font-mono text-ink-700 shrink-0">
                      {provider.label}
                    </span>
                  )}
                  {provider.models.map((m) => {
                    /*
                      Nothing is highlighted while Auto is selected — a chip
                      lit up next to an active "Auto" would claim the worker
                      is already decided when the whole point is that it
                      isn't yet. With one worker there is no Auto chip, so the
                      default stays lit as before.
                    */
                    const active = j.selectedId
                      ? (j.selected?.model ?? j.defaultModel) === m.id
                      : pendingModel
                        ? pendingModel.model === m.id
                        : j.providers.length <= 1 && m.id === j.defaultModel;
                    return (
                      <button
                        key={m.id}
                        onClick={() =>
                          j.selectedId
                            ? void j.setModel(j.selectedId, m.id)
                            : setPendingModel({ provider: provider.id, model: m.id })
                        }
                        disabled={running}
                        className={`shrink-0 px-2.5 h-8 rounded-badge border text-[11px] transition-colors disabled:opacity-40 ${
                          active
                            ? "border-xp/40 bg-xp/10 text-xp"
                            : "border-base-600 text-ink-700 hover:text-ink-300"
                        }`}
                      >
                        {m.label}
                      </button>
                    );
                  })}
                </div>
              ))}
              </div>
              <div
                aria-hidden
                className={`pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-base-800 to-transparent transition-opacity ${
                  modelRowAtEnd ? "opacity-0" : "opacity-100"
                }`}
              />
            </div>
            <p
              className="shrink-0 text-[11px] font-mono text-ink-700"
              title="Operator's own usage only — this cannot see your plan percentage."
            >
              {j.spentUsd.toFixed(3)}
              {j.budgetUsd ? ` / ${j.budgetUsd}` : ""}
            </p>
          </div>

          {/*
            Describes the worker in front of you, not Claude Code always.

            The previous version said it "can't stop and ask you anything —
            print mode is one-way", which was true of the CLI and stopped being
            true the day ADR 0012's option C landed. A blurb that confidently
            describes behaviour the app no longer has is worse than none: it is
            the thing the owner reads to find out what the tool does.
          */}
          {(() => {
            /*
              Resolve the worker before describing it, and describe NOTHING
              rather than guess.

              The previous version asked "does the selected job's provider have
              capability-actions?" and, whenever that lookup came back empty,
              fell through to the Claude Code paragraph. That is an unsafe
              default: an empty answer means "I do not know which worker this
              is", and the fallback answered it with a confident description of
              a specific one. Caught on 2026-08-30 with an `ollama` job open,
              reading "Runs Claude Code against this project" underneath a
              conversation with a local model.

              A lookup can come back empty for ordinary reasons — the list
              poll and the provider list arriving out of step, a worker
              deregistering (the local one now appears and disappears with
              Ollama). None of them justify claiming a different worker's
              permissions model, which is the one thing on this page the owner
              relies on being true.

              So: fall back to the job's OWN recorded provider id, and when
              even that is unknown, say nothing at all.
            */
            const selectedProvider = j.selected?.provider;
            const worker = selectedProvider
              ? j.providers.find((p) => p.id === selectedProvider)
              : undefined;
            const tools = worker?.capabilities?.tools;
            const isCapabilityWorker =
              tools === "capability-actions" ||
              // The list has not caught up, but the job knows what ran it.
              (!worker && selectedProvider !== undefined && selectedProvider !== "claude-code");
            const isClaudeCode = selectedProvider === "claude-code" || !j.selectedId;
            return (
              <>
          {(isCapabilityWorker ? (
            <p className="text-[11px] text-ink-700 mt-3 leading-relaxed">
              A model with access to Operator&apos;s own data — it can change the Mission Board,
              the calendar, the gym log and the daily routine through{" "}
              <strong className="font-normal text-ink-500">named, validated actions</strong>, the
              same ones the app&apos;s own pages use. No file access and no shell, so there is
              nothing for it to ask permission about. Its memory of a conversation lives in this
              server and{" "}
              <strong className="font-normal text-ink-500">does not survive a restart</strong>.
            </p>
          ) : isClaudeCode ? (
            <p className="text-[11px] text-ink-700 mt-3 leading-relaxed">
              Runs Claude Code against this project and remembers across messages — the same
              conversation you can pick up at the desk. It has tool access and one standing
              permission:{" "}
              <strong className="font-normal text-ink-500">
                everything except publishing and deleting
              </strong>
              . Those two can&apos;t be undone, so it writes the command out and you run it.
              Anything else outside the pre-approved list{" "}
              <strong className="font-normal text-ink-500">pauses the turn and asks you</strong>,
              and answering carries the same turn on. Conversations survive a restart; the event
              log doesn&apos;t, but its own session does, so a restored one picks up where it
              left off.
            </p>
          ) : null)}

          <p className="flex items-center gap-1.5 text-[11px] text-ink-700 mt-1.5">
            <FileText size={11} className="shrink-0" />
            One job runs at a time — a second is queued rather than run alongside.
          </p>

          {/*
            Named from the server, not repeated in prose. OPERATOR_JOB_DENY can
            change the profile, and a hardcoded list here would go quietly wrong
            the first time it does.

            Only shown for a worker the profile actually applies to. A model
            reached over HTTP with no shell and no filesystem cannot run
            `git push` under any circumstances, so listing it as something that
            worker is forbidden implies a capability it never had — and quietly
            teaches that the deny list is what stops it, rather than the absence
            of any way to run a command at all.
          */}
          {isClaudeCode && j.deniedTools.length > 0 && (
            <p className="text-[11px] font-mono text-ink-700 mt-1 break-all">
              never: {j.deniedTools.join("  ·  ")}
            </p>
          )}
              </>
            );
          })()}
        </>
      )}
    </section>
  );
}
