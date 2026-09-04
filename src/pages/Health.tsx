import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  HelpCircle,
  RefreshCw,
  XCircle,
} from "lucide-react";

/**
 * The verification pass, read from `/api/health/checks` (server/health.mjs).
 *
 * Not `/api/health` — that is the cheap liveness-and-`updatedAt` poll
 * `remoteStore` runs on a timer, and it must stay cheap.
 *
 * A read-only aggregator like the Activity Log and Statistics — it owns no
 * storage and has no hook, because there is no feature namespace behind it.
 * Everything on this page is measured at request time by the server.
 *
 * Infra register, same as Homelab and the Dev page's Builds card. **A check
 * being green is not an achievement**, so there is nothing congratulatory here
 * and nothing that celebrates a clean pass. The only thing allowed to draw the
 * eye is a row that wants a command run.
 *
 * State is encoded in FORM as well as colour — a word, an icon and a severity
 * stripe on every row — so the page still reads at a glance in daylight on a
 * phone, or to anyone who does not separate the gold from the red.
 */

type Severity = "ok" | "warn" | "fail" | "unknown";

interface EnvVar {
  name: string;
  process: boolean;
  registry: boolean | null;
}

interface PathTiming {
  path: string;
  n: number;
  mean: number;
  max: number;
}

interface Slice {
  key: string;
  bytes: number;
}

interface Check {
  id: string;
  severity: Severity;
  label: string;
  detail: string;
  hint?: string;
  at?: string | null;
  since?: string | null;
  vars?: EnvVar[];
  missing?: string[];
  slowest?: PathTiming[];
  largest?: Slice[];
}

interface Group {
  id: string;
  title: string;
  subtitle: string;
  worst: Severity;
  checks: Check[];
}

interface Report {
  checkedAt: string;
  tookMs: number;
  ageMs?: number;
  summary: {
    ok: number;
    warn: number;
    fail: number;
    unknown: number;
    worst: Severity;
    headline: string;
  };
  groups: Group[];
}

/**
 * One vocabulary for every severity, used by the pill, the stripe and the
 * summary counters — so the word, the shape and the colour can never disagree
 * with each other on the same row.
 */
const TONE: Record<
  Severity,
  { word: string; stripe: string; ring: string; Icon: typeof CheckCircle2 }
> = {
  fail: {
    word: "broken",
    stripe: "bg-vital-down",
    ring: "border-vital-down/40 bg-vital-down/10 text-vital-down",
    Icon: XCircle,
  },
  warn: {
    word: "attention",
    stripe: "bg-xp",
    ring: "border-xp/40 bg-xp/10 text-xp",
    Icon: AlertTriangle,
  },
  unknown: {
    word: "unchecked",
    stripe: "bg-ink-700",
    ring: "border-base-500 bg-base-700 text-ink-500",
    Icon: HelpCircle,
  },
  /*
    `ok` is deliberately the quietest row on the page — base border, faint ink,
    no accent. A check passing is not an achievement (Homelab's register, not
    the Dashboard's), and giving green the same weight as red is how a page of
    thirty rows stops being readable at a glance.
  */
  ok: {
    word: "clear",
    stripe: "bg-base-500",
    ring: "border-base-600 bg-base-800 text-ink-700",
    Icon: CheckCircle2,
  },
};

/** Worst first, so a summary lists what needs doing before what does not. */
const ORDER: Severity[] = ["fail", "warn", "unknown", "ok"];

function ago(iso: string | null | undefined): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

function kb(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

function Pill({ severity }: { severity: Severity }) {
  const tone = TONE[severity];
  return (
    <span
      className={`shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-badge border font-mono text-[10px] ${tone.ring}`}
    >
      <tone.Icon size={11} strokeWidth={2.2} />
      {tone.word}
    </span>
  );
}

/**
 * The exact thing to run, as a selectable line rather than prose.
 *
 * A hint that has to be retyped from a sentence is a hint that gets retyped
 * wrong — and half of these are paths with backslashes in them.
 */
function Hint({ text }: { text: string }) {
  return (
    <p className="mt-2 font-mono text-[11px] text-ink-300 bg-base-950 border border-base-600 rounded-badge px-2.5 py-2 overflow-x-auto whitespace-pre">
      {text}
    </p>
  );
}

function CheckRow({ check }: { check: Check }) {
  const tone = TONE[check.severity];
  return (
    <li className="flex gap-3">
      {/* The stripe carries severity without needing the pill to be read. */}
      <span className={`w-[3px] rounded-full shrink-0 ${tone.stripe}`} aria-hidden />
      <div className="min-w-0 flex-1 py-0.5">
        <div className="flex items-start justify-between gap-2">
          <p className={`text-sm ${check.severity === "ok" ? "text-ink-300" : "text-ink-100"}`}>
            {check.label}
          </p>
          <Pill severity={check.severity} />
        </div>
        <p className="text-xs text-ink-500 leading-relaxed mt-0.5">{check.detail}</p>

        {check.at && (
          <p className="text-[11px] font-mono text-ink-700 mt-1">
            {ago(check.at)}
            {check.since && ` · source changed ${ago(check.since)}`}
          </p>
        )}

        {check.hint && <Hint text={check.hint} />}

        {check.largest && check.largest.length > 0 && (
          <ul className="mt-2 space-y-1">
            {check.largest.map((slice) => (
              <li key={slice.key} className="flex items-center gap-2 text-[11px] font-mono text-ink-700">
                <span className="truncate">{slice.key}</span>
                <span className="flex-1 h-px bg-base-600" />
                <span className="shrink-0">{kb(slice.bytes)}</span>
              </li>
            ))}
          </ul>
        )}

        {check.slowest && check.slowest.length > 0 && (
          <ul className="mt-2 space-y-1">
            {check.slowest.map((row) => (
              <li key={row.path} className="flex items-center gap-2 text-[11px] font-mono text-ink-700">
                <span className="truncate">{row.path}</span>
                <span className="flex-1 h-px bg-base-600" />
                <span className="shrink-0">
                  {row.mean.toFixed(0)}ms avg · {row.max.toFixed(0)}ms max · {row.n}
                </span>
              </li>
            ))}
          </ul>
        )}

        {check.vars && check.vars.length > 0 && <EnvList vars={check.vars} />}
      </div>
    </li>
  );
}

/**
 * Names and two booleans. **Never a value** — the server does not read one, and
 * this could not show one if it wanted to.
 *
 * Collapsed by default because it is a list of thirty names and the answer most
 * days is "all present"; the row above already says the count.
 */
function EnvList({ vars }: { vars: EnvVar[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 px-2.5 min-h-[44px] -ml-2.5 rounded-badge text-xs text-ink-500 hover:text-ink-300 transition-colors"
      >
        <ChevronDown size={13} className={`transition-transform ${open ? "rotate-180" : ""}`} />
        {open ? "Hide" : "Show"} the {vars.length} names
      </button>
      {open && (
        <ul className="space-y-1 mt-1">
          {vars.map((v) => (
            <li key={v.name} className="flex items-center gap-2 text-[11px] font-mono text-ink-700">
              <span className="truncate">{v.name}</span>
              <span className="flex-1 h-px bg-base-600" />
              <span className="shrink-0 text-ink-500">
                process
                {v.registry === null ? "" : v.registry ? " + registry" : " only"}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-[11px] text-ink-700 mt-1">
        Presence only. No value is read by the server, so none can reach this page.
      </p>
    </div>
  );
}

function GroupCard({ group }: { group: Group }) {
  return (
    <section className="card-base p-4 sm:p-5 mb-4 animate-fade-up">
      <header className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <h2 className="font-display text-sm font-medium text-ink-300">{group.title}</h2>
          <p className="text-xs text-ink-700">{group.subtitle}</p>
        </div>
        <Pill severity={group.worst} />
      </header>
      <ul className="space-y-3">
        {group.checks.map((check) => (
          <CheckRow key={check.id} check={check} />
        ))}
      </ul>
    </section>
  );
}

export default function Health() {
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const refresh = useCallback(async (fresh = false) => {
    setChecking(true);
    try {
      const res = await fetch(`/api/health/checks${fresh ? "?fresh=1" : ""}`, {
        headers: { accept: "application/json" },
      });
      if (!res.ok) throw new Error(`server returned ${res.status}`);
      setReport((await res.json()) as Report);
      setError(null);
    } catch (err) {
      /*
        The page says it could not check, and keeps whatever it last had on
        screen. A health page that white-screens when the thing it monitors is
        unreachable has answered its own question in the least useful way.
      */
      setError((err as Error).message);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    // The server caches for 15s and shares one computation between callers, so
    // a minute is generous. Nothing here is expensive enough to poll faster
    // and nothing here changes faster than a build.
    const timer = window.setInterval(() => void refresh(), 60_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  /*
    Summary before detail. The groups below are in a fixed order — reordering
    them by severity on every poll would make the page move under a finger —
    so what needs attention is lifted out and named here instead.
  */
  const attention = (report?.groups ?? [])
    .flatMap((g) => g.checks.map((c) => ({ group: g.title, check: c })))
    .filter(({ check }) => check.severity !== "ok")
    .sort((a, b) => ORDER.indexOf(a.check.severity) - ORDER.indexOf(b.check.severity));

  const counts: { severity: Severity; n: number }[] = report
    ? ORDER.map((severity) => ({ severity, n: report.summary[severity] }))
    : [];

  return (
    <div className="max-w-3xl mx-auto lg:mx-0">
      <div className="flex items-start justify-between gap-3 mb-5 flex-wrap">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 shrink-0 rounded-badge bg-xp/10 border border-xp/25 flex items-center justify-center text-xp">
            <Activity size={18} />
          </div>
          <div className="min-w-0">
            <h1 className="font-display text-lg text-ink-100 leading-tight">Health</h1>
            <p className="text-xs text-ink-500">
              {report ? report.summary.headline : "Checking…"}
              {report && (
                <span className="font-mono text-ink-700">
                  {" "}
                  · {ago(report.checkedAt)} · {report.tookMs}ms
                </span>
              )}
            </p>
          </div>
        </div>
        <button
          onClick={() => void refresh(true)}
          aria-label="Run the checks again"
          title="Run again"
          className="w-11 h-11 shrink-0 rounded-badge border border-base-600 flex items-center justify-center text-ink-500 hover:text-ink-100 hover:border-base-500 transition-colors"
        >
          <RefreshCw size={15} className={checking ? "animate-spin" : ""} />
        </button>
      </div>

      {error && (
        <p className="text-sm text-vital-down mb-4">
          Couldn't reach the check: {error}
          {report && " — showing the last result below."}
        </p>
      )}

      {report && (
        <>
          {/* Counters. Ordered worst-first, and each carries its own word. */}
          <div className="flex flex-wrap gap-2 mb-4">
            {counts.map(({ severity, n }) => (
              <span
                key={severity}
                className={`inline-flex items-center gap-1.5 px-3 min-h-[38px] rounded-badge border font-mono text-xs ${
                  n === 0 ? "border-base-600 bg-base-800 text-ink-700" : TONE[severity].ring
                }`}
              >
                {n} {TONE[severity].word}
              </span>
            ))}
          </div>

          {attention.length > 0 && (
            <section className="card-base p-4 sm:p-5 mb-5 animate-fade-up">
              <h2 className="font-display text-sm font-medium text-ink-300 mb-1">Needs attention</h2>
              <p className="text-xs text-ink-700 mb-3">
                Every check here is a failure this project has actually had. The detail is in the
                group below.
              </p>
              <ul className="space-y-2">
                {attention.map(({ group, check }) => (
                  <li key={check.id} className="flex items-start gap-2.5">
                    <span
                      className={`w-[3px] self-stretch rounded-full shrink-0 ${TONE[check.severity].stripe}`}
                      aria-hidden
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-ink-100">
                        {check.label}
                        <span className="font-mono text-[11px] text-ink-700"> · {group}</span>
                      </p>
                      <p className="text-xs text-ink-500 leading-relaxed">{check.detail}</p>
                    </div>
                    <Pill severity={check.severity} />
                  </li>
                ))}
              </ul>
            </section>
          )}

          {report.groups.map((group) => (
            <GroupCard key={group.id} group={group} />
          ))}
        </>
      )}

      <p className="text-xs text-ink-700 mt-6 leading-relaxed max-w-2xl">
        These are the ways Operator has broken before, asked on demand — not a proof that it is
        working. A check that cannot run says so and is counted as unchecked; it never reports a
        failure it did not find. Nothing here reaches the network: the git rows compare against the
        last fetch rather than performing one.
      </p>
    </div>
  );
}
