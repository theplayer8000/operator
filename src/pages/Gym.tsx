import { useState } from "react";
import { Dumbbell, ChevronLeft, ChevronRight, RotateCcw, CalendarDays } from "lucide-react";
import { Link } from "react-router-dom";
import { useGym } from "@/hooks/useGym";
import ConfirmButton from "@/components/ui/ConfirmButton";
import { fromDateKey, relativeDay, toDateKey } from "@/lib/time";

/**
 * Today's session, tickable. The thing you actually hold at the gym.
 *
 * Register is closer to Daily Routine than Mission Board — a checklist you
 * work down, not a record you browse. Rows are deliberately large: this gets
 * used one-handed, between sets, with a phone that may be on a bench.
 */
export default function Gym() {
  const { todayKey, sessionOn, isDone, toggleExercise, clearDay, progressOn } = useGym();
  const [dateKey, setDateKey] = useState(todayKey);

  const session = sessionOn(dateKey);
  const progress = progressOn(dateKey);
  const date = fromDateKey(dateKey);

  function shiftDay(delta: number) {
    const d = fromDateKey(dateKey);
    if (!d) return;
    d.setDate(d.getDate() + delta);
    setDateKey(toDateKey(d));
  }

  return (
    <div className="max-w-2xl mx-auto lg:mx-0">
      <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-badge bg-xp/10 border border-xp/25 flex items-center justify-center text-xp">
            <Dumbbell size={18} />
          </div>
          <div>
            <h1 className="font-display text-lg text-ink-100 leading-tight">Gym</h1>
            <p className="text-xs text-ink-500">
              {session ? session.name : "Rest day"}
              {progress && ` · ${progress.done}/${progress.total}`}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1">
          <button
            onClick={() => shiftDay(-1)}
            aria-label="Previous day"
            className="w-11 h-11 rounded-badge border border-base-600 flex items-center justify-center text-ink-500 hover:text-ink-100 hover:border-base-500 transition-colors"
          >
            <ChevronLeft size={16} />
          </button>
          <button
            onClick={() => setDateKey(todayKey)}
            className="px-3 min-h-[44px] rounded-badge border border-base-600 text-xs text-ink-300 hover:text-ink-100 hover:border-base-500 transition-colors"
          >
            Today
          </button>
          <button
            onClick={() => shiftDay(1)}
            aria-label="Next day"
            className="w-11 h-11 rounded-badge border border-base-600 flex items-center justify-center text-ink-500 hover:text-ink-100 hover:border-base-500 transition-colors"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>

      <p className="text-xs text-ink-700 mb-4">
        {date?.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}
        {" · "}
        {relativeDay(dateKey)}
        {session && ` · ${session.time}`}
      </p>

      {!session ? (
        <div className="card-base p-5 sm:p-6 animate-fade-up text-center">
          <p className="text-sm text-ink-300 mb-1">Rest day</p>
          <p className="text-xs text-ink-700 leading-relaxed">
            Nothing scheduled. Rest days are Monday and Thursday — both sit before a Darams
            morning, so they're the nights to get a long sleep.
          </p>
        </div>
      ) : (
        <>
          {progress && (
            <div className="card-base p-4 mb-4 animate-fade-up">
              <div className="flex items-baseline justify-between mb-2">
                <span className="font-display text-sm text-ink-100">{session.name}</span>
                <span className="font-mono text-sm text-ink-300">{progress.percent}%</span>
              </div>
              <div className="h-1.5 bg-base-700 rounded-full overflow-hidden">
                <div
                  className="h-full bg-xp rounded-full transition-all duration-500"
                  style={{ width: `${progress.percent}%` }}
                />
              </div>
            </div>
          )}

          <ul className="space-y-2 mb-5">
            {session.exercises.map((exercise) => {
              const done = isDone(dateKey, exercise.id);
              return (
                <li key={exercise.id}>
                  <button
                    onClick={() => toggleExercise(dateKey, exercise.id)}
                    className={`w-full flex items-start gap-3 p-3 rounded-badge border text-left transition-colors min-h-[44px] ${
                      done
                        ? "border-xp/30 bg-xp/5"
                        : "border-base-600 bg-base-700/30 hover:border-base-500"
                    }`}
                  >
                    <span
                      className={`w-5 h-5 mt-0.5 rounded-[6px] border flex items-center justify-center shrink-0 transition-colors ${
                        done ? "bg-xp border-xp" : "border-base-500"
                      }`}
                    >
                      {done && <span className="w-2 h-2 bg-base-950 rounded-[2px]" />}
                    </span>
                    <span className="flex-1 min-w-0">
                      <span
                        className={`block text-sm ${
                          done ? "text-ink-700 line-through" : "text-ink-100"
                        }`}
                      >
                        {exercise.name}
                      </span>
                      <span className="block font-mono text-[11px] text-ink-500 mt-0.5">
                        {exercise.sets}
                      </span>
                      {exercise.cue && !done && (
                        <span className="block text-[11px] text-ink-700 leading-relaxed mt-1">
                          {exercise.cue}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:justify-between">
            <Link
              to="/calendar"
              className="inline-flex items-center gap-2 text-xs text-ink-500 hover:text-ink-300 transition-colors"
            >
              <CalendarDays size={13} /> See it on the calendar
            </Link>
            {progress && progress.done > 0 && (
              <div className="flex items-center gap-2">
                <RotateCcw size={13} className="text-ink-700" />
                <ConfirmButton
                  label="Clear today's ticks"
                  onConfirm={() => clearDay(dateKey)}
                  compact
                />
              </div>
            )}
          </div>
        </>
      )}

      <p className="text-[11px] text-ink-700 mt-6 leading-relaxed">
        Ticks are stored per date, so each session's are its own and nothing needs resetting.
        The full programme — phases, percentages, deloads, nutrition — lives in{" "}
        <span className="font-mono text-ink-500">reference/gym-programme.md</span>.
      </p>
    </div>
  );
}
