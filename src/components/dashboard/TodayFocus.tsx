import { useState } from "react";
import { Target, Check, Pencil } from "lucide-react";
import Card from "@/components/ui/Card";

const QUOTES = [
  "Small missions, stacked daily, become the build.",
  "Progress you can see is progress you keep making.",
  "Ship the boring 60% — the last 10% takes care of itself.",
  "Every streak was once a single day one.",
];
const quote = QUOTES[new Date().getDate() % QUOTES.length];

export default function TodayFocus({
  focus,
  onChange,
}: {
  focus: string;
  onChange: (v: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(focus);

  function commit() {
    onChange(draft);
    setEditing(false);
  }

  return (
    <Card title="Today's Focus" icon={<Target size={15} />} span={2}>
      {editing ? (
        <div className="flex items-center gap-2">
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && commit()}
            className="flex-1 min-w-0 bg-base-700 border border-base-500 rounded-badge px-3 py-2 text-base sm:text-sm text-ink-100 outline-none focus:border-xp/60"
          />
          <button
            onClick={commit}
            className="w-9 h-9 rounded-badge bg-xp/15 border border-xp/30 text-xp flex items-center justify-center hover:bg-xp/25 transition-colors"
          >
            <Check size={16} />
          </button>
        </div>
      ) : (
        <button
          onClick={() => {
            setDraft(focus);
            setEditing(true);
          }}
          className="group w-full text-left flex items-start justify-between gap-3"
        >
          <p className="font-display text-lg sm:text-xl text-ink-100 leading-snug">{focus}</p>
          <Pencil
            size={14}
            className="text-ink-700 group-hover:text-ink-500 shrink-0 mt-1.5 transition-colors"
          />
        </button>
      )}
      <p className="text-xs text-ink-700 mt-3 italic">"{quote}"</p>
    </Card>
  );
}
