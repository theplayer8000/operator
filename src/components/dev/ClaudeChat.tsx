import { useEffect, useRef, useState } from "react";
import {
  MessageSquare,
  Send,
  Plus,
  ShieldAlert,
  Loader2,
  Check,
  Power,
  Square,
  Wrench,
  FileText,
  History,
} from "lucide-react";
import Markdown from "@/components/ui/Markdown";
import ConfirmButton from "@/components/ui/ConfirmButton";
import { useJobs, type JobEvent, type JobSummary } from "@/hooks/useJobs";

/**
 * The Claude workspace.
 *
 * Each conversation is a **job** with an append-only event log, so this shows
 * two things the old chat couldn't: a strip of jobs to switch between, and what
 * Claude is doing *while* it does it — which file it read, which command it
 * ran. Ten minutes of "Claude is working…" is a spinner; ten minutes of watching
 * it read three files and run a build is information.
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

function ago(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

/** One event, rendered in the register its type deserves. */
function Event({
  event,
  onAllow,
  grants,
}: {
  event: JobEvent;
  onAllow: (rule: string) => void;
  grants: Record<string, string>;
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
      A denial is the one event that needs an action, so it is the one event
      that looks like a card. Print mode can't stop and ask — the alternative is
      the owner reading a refusal with no way to answer it from a phone.

      Two different refusals share this event type, and the difference decides
      what the card offers. A **standing** one — publishing, deleting — is the
      owner's own decision and cannot be granted at all: the deny list is a deny,
      and a deny beats an allow, so an "Allow this" button here would write a
      rule that sits in settings.local.json looking effective and is refused
      every time it is used. That is the same silently-inert grant the Windows
      path bug produced, and it took three denied grants to spot. So the standing
      card hands over the command instead, which is exactly what the profile says
      should happen.
    */
    case "permission_request": {
      const rule = event.rule ?? "";
      const state = grants[rule];

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
          <p className="text-[11px] font-mono text-ink-700 break-all">rule: {rule}</p>
          {state === "allowed" || state === "already allowed" ? (
            <p className="flex items-center gap-1.5 text-xs text-vital-up">
              <Check size={13} /> {state} — send again to retry
            </p>
          ) : (
            <button
              onClick={() => onAllow(rule)}
              disabled={state === "working"}
              className="min-h-[44px] px-3 rounded-badge border border-xp/40 bg-xp/10 text-xs text-xp hover:bg-xp/20 disabled:opacity-50 transition-colors"
            >
              {state === "working" ? "Writing…" : "Allow this"}
            </button>
          )}
          {state && !["working", "allowed", "already allowed"].includes(state) && (
            <p className="text-xs text-vital-down">{state}</p>
          )}
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
      className={`shrink-0 flex items-center gap-2 h-9 px-3 rounded-badge border text-xs transition-colors ${
        active
          ? "border-xp/40 bg-xp/10 text-xp"
          : "border-base-600 text-ink-500 hover:text-ink-100 hover:border-base-500"
      }`}
    >
      {running ? (
        <Loader2 size={12} className="animate-spin shrink-0" />
      ) : job.restored ? (
        <span title="From before a restart — Claude still remembers, the log doesn't">
          <History size={12} className="shrink-0 text-ink-700" />
        </span>
      ) : null}
      <span className="max-w-[140px] truncate">{job.title}</span>
      {job.queued > 0 && <span className="font-mono text-[10px] text-rank">+{job.queued}</span>}
    </button>
  );
}

export default function ClaudeChat() {
  const j = useJobs();
  const [draft, setDraft] = useState("");
  const [grants, setGrants] = useState<Record<string, string>>({});
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [j.events.length, j.busy]);

  async function submit() {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    if (j.selectedId) await j.send(j.selectedId, text);
    else await j.create(text);
  }

  async function allow(rule: string) {
    setGrants((p) => ({ ...p, [rule]: "working" }));
    try {
      const outcome = await j.allowRule(rule);
      setGrants((p) => ({ ...p, [rule]: outcome }));
    } catch (err) {
      setGrants((p) => ({ ...p, [rule]: (err as Error).message }));
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
            <h2 className="font-display text-sm font-medium text-ink-300">Claude</h2>
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
              <p className="text-sm text-ink-700">
                {j.selected?.restored
                  ? "From before a restart — the log isn't kept, but Claude still remembers. Send a message to carry on."
                  : "No events yet."}
              </p>
            ) : (
              j.events.map((e) => (
                <Event key={e.seq} event={e} onAllow={(r) => void allow(r)} grants={grants} />
              ))
            )}
            {running && (
              <p className="flex items-center gap-2 text-xs text-xp">
                <Loader2 size={13} className="animate-spin" /> working…
              </p>
            )}
          </div>

          {j.error && <p className="text-xs text-vital-down mb-2 break-words">{j.error}</p>}

          <div className="flex items-end gap-2">
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
              placeholder={fresh ? "resume operator build" : "Ask Claude about this project…"}
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
                disabled={!draft.trim()}
                aria-label="Send"
                className="w-11 h-11 shrink-0 rounded-badge border border-xp/40 bg-xp/10 flex items-center justify-center text-xp hover:bg-xp/20 disabled:text-ink-700 disabled:border-base-600 disabled:bg-transparent transition-colors"
              >
                <Send size={14} />
              </button>
            )}
          </div>

          <div className="flex items-center justify-between gap-3 mt-2">
            <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-none">
              {j.models.map((m) => {
                const active = (j.selected?.model ?? j.defaultModel) === m.id;
                return (
                  <button
                    key={m.id}
                    onClick={() => j.selectedId && void j.setModel(j.selectedId, m.id)}
                    disabled={!j.selectedId || running}
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
            <p
              className="shrink-0 text-[11px] font-mono text-ink-700"
              title="Operator's own usage only — this cannot see your plan percentage."
            >
              {j.spentUsd.toFixed(3)}
              {j.budgetUsd ? ` / ${j.budgetUsd}` : ""}
            </p>
          </div>

          <p className="text-[11px] text-ink-700 mt-3 leading-relaxed">
            Runs Claude Code against this project and remembers across messages — the same
            conversation you can pick up at the desk. It has tool access and one standing
            permission:{" "}
            <strong className="font-normal text-ink-500">
              everything except publishing and deleting
            </strong>
            . Those two can&apos;t be undone, so it writes the command out and you run it. It{" "}
            <strong className="font-normal text-ink-500">can&apos;t stop and ask you anything</strong>{" "}
            either — print mode is one-way — so anything else it&apos;s refused shows the rule that
            would allow it, one tap. Conversations survive a restart; the event log doesn&apos;t,
            but Claude&apos;s own session does, so a restored one carries on where it left off.
          </p>

          <p className="flex items-center gap-1.5 text-[11px] text-ink-700 mt-1.5">
            <FileText size={11} className="shrink-0" />
            One job runs at a time — a second is queued rather than run alongside.
          </p>

          {/*
            Named from the server, not repeated in prose. OPERATOR_JOB_DENY can
            change the profile, and a hardcoded list here would go quietly wrong
            the first time it does.
          */}
          {j.deniedTools.length > 0 && (
            <p className="text-[11px] font-mono text-ink-700 mt-1 break-all">
              never: {j.deniedTools.join("  ·  ")}
            </p>
          )}
        </>
      )}
    </section>
  );
}
