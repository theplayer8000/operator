import { useState } from "react";
import { Swords } from "lucide-react";
import type { DecisionRecord, MissionRecord } from "@/lib/types";
import { VERDICT_META, VERDICT_ORDER } from "./decisionMeta";

/**
 * Editing one decision, in place.
 *
 * ## Everything saves as you type — no Save button
 *
 * The rest of Operator works this way (`EditableField`, `NoteEditor`), and the
 * reason holds here too: you log a decision in the moment, and a Save button
 * is one more thing to forget.
 *
 * ## Reasoning and outcome are two boxes, on purpose
 *
 * They are written at different times — reasoning now, outcome months later —
 * and keeping them apart is what lets the log show the gap between a decision
 * and its consequence rather than blur them into one paragraph.
 */
export default function DecisionEditor({
  record,
  missions,
  onChange,
  onToggleMission,
}: {
  record: DecisionRecord;
  missions: MissionRecord[];
  onChange: (patch: Partial<DecisionRecord>) => void;
  onToggleMission: (missionId: string) => void;
}) {
  const [showMissions, setShowMissions] = useState(false);

  return (
    <div className="space-y-4">
      <input
        value={record.title}
        onChange={(e) => onChange({ title: e.target.value })}
        placeholder="What did you decide?"
        // text-base on small screens, or iOS zooms the page on focus.
        className="w-full bg-transparent font-display text-xl text-ink-100 placeholder:text-ink-700 focus:outline-none"
      />

      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2">
          <span className="text-[11px] font-mono uppercase tracking-wider text-ink-700">Decided</span>
          <input
            type="date"
            value={record.decidedOn}
            onChange={(e) => onChange({ decidedOn: e.target.value })}
            className="h-9 px-2 rounded-badge bg-base-800 border border-base-600 text-base sm:text-sm text-ink-300 font-mono focus:outline-none focus:ring-2 focus:ring-xp/30"
          />
        </label>
      </div>

      {/* Verdict, as chips rather than a select — a native select on iOS is a
          full-screen wheel for four options. */}
      <div className="flex flex-wrap gap-2">
        {VERDICT_ORDER.map((v) => (
          <button
            key={v}
            onClick={() => onChange({ verdict: v })}
            title={VERDICT_META[v].help}
            className={`h-9 px-3 rounded-badge border text-[11px] font-mono transition-colors ${
              record.verdict === v
                ? VERDICT_META[v].className
                : "border-base-600 bg-base-800 text-ink-700 hover:text-ink-300"
            }`}
          >
            {VERDICT_META[v].label}
          </button>
        ))}
      </div>

      <label className="block">
        <span className="text-[11px] font-mono uppercase tracking-wider text-ink-700">
          Reasoning — the thinking at the time
        </span>
        <textarea
          value={record.reasoning}
          onChange={(e) => onChange({ reasoning: e.target.value })}
          rows={7}
          placeholder="Why this call, and what you knew when you made it. Markdown is fine."
          className="mt-1 w-full rounded-badge bg-base-900/60 border border-base-600 px-3 py-2.5 text-base sm:text-sm text-ink-300 placeholder:text-ink-700 font-mono leading-relaxed resize-y focus:outline-none focus:ring-2 focus:ring-xp/30"
        />
      </label>

      <label className="block">
        <span className="text-[11px] font-mono uppercase tracking-wider text-ink-700">
          Outcome — how it actually went (fill in later)
        </span>
        <textarea
          value={record.outcome}
          onChange={(e) => onChange({ outcome: e.target.value })}
          rows={5}
          placeholder="Left empty until you know. Come back and write what happened, then set the verdict."
          className="mt-1 w-full rounded-badge bg-base-900/60 border border-base-600 px-3 py-2.5 text-base sm:text-sm text-ink-300 placeholder:text-ink-700 font-mono leading-relaxed resize-y focus:outline-none focus:ring-2 focus:ring-xp/30"
        />
      </label>

      <label className="block">
        <span className="text-[11px] font-mono uppercase tracking-wider text-ink-700">Topics</span>
        <input
          // Stored as an array, edited as a comma list. Lowercasing is in the
          // hook so the capability layer gets it too.
          value={record.topics.join(", ")}
          onChange={(e) => onChange({ topics: e.target.value.split(",") })}
          placeholder="career, finance, health"
          className="mt-1 w-full h-11 px-3 rounded-badge bg-base-800 border border-base-600 text-base sm:text-sm text-ink-300 placeholder:text-ink-700 font-mono focus:outline-none focus:ring-2 focus:ring-xp/30"
        />
      </label>

      {/* --- missions --------------------------------------------------- */}
      <section className="pt-4 border-t border-base-600">
        <h3 className="text-xs font-mono uppercase tracking-wider text-ink-700 mb-2 flex items-center gap-1.5">
          <Swords size={13} /> Bears on
        </h3>
        <div className="flex flex-wrap gap-2">
          {missions
            .filter((m) => record.missions.includes(m.id) || showMissions)
            .map((m) => (
              <button
                key={m.id}
                onClick={() => onToggleMission(m.id)}
                className={`h-9 px-3 rounded-badge border text-[11px] transition-colors ${
                  record.missions.includes(m.id)
                    ? "border-xp/45 bg-xp/10 text-xp"
                    : "border-base-600 bg-base-800 text-ink-700 hover:text-ink-300"
                }`}
              >
                {m.name}
              </button>
            ))}
          <button
            onClick={() => setShowMissions(!showMissions)}
            className="h-9 px-3 rounded-badge border border-base-600 bg-base-800 text-[11px] text-ink-700 hover:text-ink-300 transition-colors"
          >
            {showMissions ? "done" : "attach…"}
          </button>
        </div>
      </section>
    </div>
  );
}
