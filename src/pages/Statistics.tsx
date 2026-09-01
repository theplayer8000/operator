import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { BarChart3, ArrowUpRight, TrendingUp, TrendingDown, Minus } from "lucide-react";
import { useStatistics, type DayCount } from "@/hooks/useStatistics";
import type { MissionStatus } from "@/lib/types";

/**
 * What Operator knows about itself, counted.
 *
 * ## The register
 *
 * `design-system.md` says a new top-level feature has to decide which register
 * it sits in, and this one takes the map's: dark ground, gold accent, glowing
 * numerals, mono for anything numeric. Not the Mission Board's calm — the
 * owner asked for "a new live reface" and this is the proving ground for it,
 * so the direction gets tested on one page before it is rolled anywhere else.
 *
 * ## Honest about thin data
 *
 * The changelog holds five weeks of dated entries and carries the page. Gym
 * and routine hold two days each, because the seed data was cleared for real
 * use. Those say so rather than drawing a confident trend line through two
 * points — a statistic that overstates its evidence is worse than no
 * statistic, because it gets believed.
 */

const STATUS_META: Record<MissionStatus, { label: string; colour: string }> = {
  in_progress: { label: "In progress", colour: "#8D7FE0" },
  complete: { label: "Complete", colour: "#4ED88A" },
  blocked: { label: "Blocked", colour: "#E05A5A" },
  not_started: { label: "Not started", colour: "#5A6272" },
};

/** A big number with its label, in the map's voice. */
function Figure({
  value,
  label,
  hint,
  accent = false,
  to,
}: {
  value: string | number;
  label: string;
  hint?: string;
  accent?: boolean;
  /**
   * Where this number comes from.
   *
   * The owner asked for it "more interfaceable", and the honest reading is
   * that a statistic is a question — "twelve in progress" immediately raises
   * "which twelve". A figure that can answer that should be the way through to
   * the answer rather than a dead end you then navigate to by hand.
   *
   * Only where there genuinely is a destination. A link that lands on a page
   * which cannot show what you clicked is worse than no link.
   */
  to?: string;
}) {
  const body = (
    <>
      <p
        className="font-mono text-2xl sm:text-3xl leading-none tabular-nums"
        style={
          accent
            ? { color: "#E8B04D", textShadow: "0 0 18px rgba(232,176,77,0.35)" }
            : { color: "#E9EDF5" }
        }
      >
        {value}
      </p>
      <p className="text-xs text-ink-500 mt-2">{label}</p>
      {hint && <p className="text-[11px] text-ink-700 mt-0.5">{hint}</p>}
    </>
  );

  const shell = "card-base p-4 min-w-0 block";
  return to ? (
    <Link
      to={to}
      className={`${shell} transition-colors hover:border-base-500 hover:bg-base-700/30`}
    >
      {body}
    </Link>
  ) : (
    <div className={shell}>{body}</div>
  );
}

/**
 * Shipping, day by day.
 *
 * Hand-drawn SVG rather than Recharts, which is in the stack and used
 * elsewhere: this needs a glow on the bars and a zero-day that still reads as
 * a day, and fighting a charting library's defaults for both costs more than
 * forty lines of rects. Recharts stays the right answer for anything with
 * axes, legends and tooltips to earn its weight.
 */
function ShippedChart({ days }: { days: DayCount[] }) {
  const [hover, setHover] = useState<DayCount | null>(null);

  const { max, width, height, barW } = useMemo(() => {
    const w = 700;
    const h = 120;
    return {
      max: Math.max(1, ...days.map((d) => d.count)),
      width: w,
      height: h,
      barW: days.length ? w / days.length : w,
    };
  }, [days]);

  if (days.length === 0) {
    return <p className="text-sm text-ink-700">Nothing logged yet.</p>;
  }

  return (
    <div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full h-auto"
        preserveAspectRatio="none"
        role="img"
        aria-label={`Updates shipped per day across ${days.length} days`}
      >
        <defs>
          <linearGradient id="stat-bar" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#E8B04D" stopOpacity="0.95" />
            <stop offset="100%" stopColor="#E8B04D" stopOpacity="0.35" />
          </linearGradient>
        </defs>
        {days.map((d, i) => {
          const h = d.count === 0 ? 1.5 : Math.max(3, (d.count / max) * (height - 8));
          return (
            <rect
              key={d.date}
              x={i * barW + barW * 0.15}
              y={height - h}
              width={Math.max(1, barW * 0.7)}
              height={h}
              rx={barW > 6 ? 1.5 : 0}
              /*
                A day with nothing shipped still draws a sliver. A gap that
                renders as literally nothing is indistinguishable from the
                chart ending, and "he did not work that day" is information.
              */
              fill={d.count === 0 ? "#2A303C" : "url(#stat-bar)"}
              onMouseEnter={() => setHover(d)}
              onMouseLeave={() => setHover(null)}
            />
          );
        })}
      </svg>

      <p className="font-mono text-[11px] text-ink-700 mt-2 h-4">
        {hover
          ? `${new Date(`${hover.date}T12:00:00`).toLocaleDateString("en-GB", {
              day: "numeric",
              month: "short",
            })} — ${hover.count} ${hover.count === 1 ? "entry" : "entries"}`
          : `${days[0]?.date} → ${days[days.length - 1]?.date}`}
      </p>
    </div>
  );
}

function Trend({ now, before }: { now: number; before: number }) {
  const delta = now - before;
  const Icon = delta > 0 ? TrendingUp : delta < 0 ? TrendingDown : Minus;
  const colour = delta > 0 ? "text-vital-up" : delta < 0 ? "text-ink-600" : "text-ink-700";
  return (
    <span className={`inline-flex items-center gap-1 font-mono text-[11px] ${colour}`}>
      <Icon size={12} />
      {delta === 0 ? "level" : `${delta > 0 ? "+" : ""}${delta} vs previous 7`}
    </span>
  );
}

export default function Statistics() {
  const s = useStatistics();

  return (
    <div className="max-w-4xl mx-auto lg:mx-0">
      <div className="flex items-center gap-3 mb-5">
        <div className="w-10 h-10 shrink-0 rounded-badge bg-xp/10 border border-xp/25 flex items-center justify-center text-xp">
          <BarChart3 size={18} />
        </div>
        <div className="min-w-0">
          <h1 className="font-display text-lg text-ink-100 leading-tight">Statistics</h1>
          <p className="text-xs text-ink-500">
            Everything counted from what the features already hold. Nothing stored here.
          </p>
        </div>
      </div>

      {/* --- shipping ------------------------------------------------- */}
      <section className="card-base p-4 sm:p-5 mb-5 animate-fade-up overflow-hidden">
        <header className="flex items-baseline justify-between gap-3 mb-3">
          <h2 className="font-display text-sm text-ink-100">Shipped</h2>
          <Trend now={s.shipped.last7} before={s.shipped.previous7} />
        </header>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
          <Figure value={s.shipped.total} label="entries logged" accent to="/updates" />
          <Figure value={s.shipped.last7} label="last 7 days" to="/updates" />
          <Figure value={s.spanDays} label="days of history" />
          <Figure
            value={s.shipped.busiestDay?.count ?? 0}
            label="busiest day"
            hint={
              s.shipped.busiestDay
                ? new Date(`${s.shipped.busiestDay.date}T12:00:00`).toLocaleDateString("en-GB", {
                    day: "numeric",
                    month: "short",
                  })
                : undefined
            }
          />
        </div>

        <ShippedChart days={s.shipped.perDay} />
      </section>

      {/* --- missions ------------------------------------------------- */}
      <section className="card-base p-4 sm:p-5 mb-5 animate-fade-up">
        <header className="flex items-baseline justify-between gap-3 mb-3">
          <h2 className="font-display text-sm text-ink-100">Missions</h2>
          <Link
            to="/missions"
            className="flex items-center gap-1 text-[11px] text-ink-500 hover:text-ink-100 transition-colors"
          >
            Board <ArrowUpRight size={12} />
          </Link>
        </header>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          <Figure value={s.missions.total} label="active missions" to="/missions" />
          <Figure value={`${s.missions.averageProgress}%`} label="average progress" accent to="/" />
          <Figure value={s.missions.byStatus.in_progress} label="in progress" to="/missions" />
          <Figure value={s.missions.byStatus.complete} label="complete" to="/missions" />
        </div>

        {/* One bar, proportioned by status. */}
        {s.missions.total > 0 && (
          <>
            <div className="flex h-2 rounded-full overflow-hidden mb-2">
              {(Object.keys(STATUS_META) as MissionStatus[]).map((k) =>
                s.missions.byStatus[k] > 0 ? (
                  <div
                    key={k}
                    style={{
                      width: `${(s.missions.byStatus[k] / s.missions.total) * 100}%`,
                      background: STATUS_META[k].colour,
                    }}
                    title={`${STATUS_META[k].label}: ${s.missions.byStatus[k]}`}
                  />
                ) : null,
              )}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 mb-4">
              {(Object.keys(STATUS_META) as MissionStatus[]).map((k) => (
                <span key={k} className="inline-flex items-center gap-1.5 text-[11px] text-ink-600">
                  <span
                    className="w-1.5 h-1.5 rounded-full"
                    style={{ background: STATUS_META[k].colour }}
                  />
                  {STATUS_META[k].label} {s.missions.byStatus[k]}
                </span>
              ))}
            </div>
          </>
        )}

        {/*
          What is holding things up. The board has stored `dependsOn` since it
          was built and nothing has ever counted it — the map draws the edges,
          this says which one to clear first.
        */}
        {s.missions.blocking.length > 0 && (
          <div className="pt-3 border-t border-base-600">
            <p className="text-xs text-ink-500 mb-2">Most depended on</p>
            <ul className="space-y-1">
              {s.missions.blocking.map((b) => (
                <li key={b.id}>
                  <Link
                    to={`/missions/${b.id}`}
                    className="flex items-center justify-between gap-3 text-sm px-2 -mx-2 py-2 min-h-[44px] rounded-badge hover:bg-base-700/50 transition-colors"
                  >
                    <span className="text-ink-300 truncate">{b.name}</span>
                    <span className="font-mono text-[11px] text-xp shrink-0">
                      {b.waiting} waiting
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {/* --- the thin ones, stated honestly --------------------------- */}
      <div className="grid gap-5 sm:grid-cols-2">
        <section className="card-base p-4 sm:p-5 animate-fade-up">
          <h2 className="font-display text-sm text-ink-100 mb-3">Training</h2>
          <div className="grid grid-cols-3 gap-3">
            <Figure value={s.gym.daysTrained} label="days logged" to="/gym" />
            <Figure value={s.gym.exercisesLogged} label="exercises" to="/gym" />
            <Figure value={s.gym.daysSkipped} label="skipped" to="/gym" />
          </div>
          {s.gym.daysTrained < 7 && (
            <p className="text-[11px] text-ink-700 mt-3 leading-relaxed">
              Too few days to show a trend yet — a line through {s.gym.daysTrained}{" "}
              {s.gym.daysTrained === 1 ? "point" : "points"} would be decoration, not evidence.
            </p>
          )}
        </section>

        <section className="card-base p-4 sm:p-5 animate-fade-up">
          <h2 className="font-display text-sm text-ink-100 mb-3">Routine &amp; calendar</h2>
          <div className="grid grid-cols-3 gap-3">
            <Figure value={s.routine.daysLogged} label="days ticked" to="/routine" />
            <Figure value={s.routine.stepsTicked} label="steps" to="/routine" />
            <Figure value={s.calendar.upcoming} label="upcoming" to="/calendar" />
          </div>
          {s.calendar.byKind.length > 0 && (
            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3 pt-3 border-t border-base-600">
              {s.calendar.byKind.map((k) => (
                <span key={k.kind} className="text-[11px] text-ink-600">
                  {k.kind} <span className="font-mono text-ink-500">{k.count}</span>
                </span>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
