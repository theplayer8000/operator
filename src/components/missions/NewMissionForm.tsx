import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, X } from "lucide-react";
import type { MissionCategory, MissionDifficulty } from "@/lib/types";
import { DIFFICULTY_OPTIONS, DIFFICULTY_META } from "./MissionBadges";

const CATEGORY_OPTIONS: MissionCategory[] = [
  "server",
  "homelab",
  "darams",
  "ai",
  "learning",
  "career",
  "gym",
  "forex",
  "custom",
];

export default function NewMissionForm({
  onCreate,
}: {
  onCreate: (input: {
    name: string;
    description: string;
    category: MissionCategory;
    difficulty: MissionDifficulty;
  }) => string;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<MissionCategory>("custom");
  const [difficulty, setDifficulty] = useState<MissionDifficulty>("moderate");
  const navigate = useNavigate();

  function submit() {
    if (!name.trim()) return;
    const id = onCreate({ name: name.trim(), description: description.trim(), category, difficulty });
    setOpen(false);
    setName("");
    setDescription("");
    navigate(`/missions/${id}`);
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 px-3.5 min-h-[44px] rounded-badge bg-xp/15 border border-xp/30 text-xp text-sm hover:bg-xp/25 transition-colors"
      >
        <Plus size={15} />
        New Mission
      </button>
    );
  }

  return (
    <div className="card-base p-5 mb-5 animate-fade-up">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-display text-sm text-ink-100">New Mission</h3>
        <button onClick={() => setOpen(false)} className="text-ink-700 hover:text-ink-300">
          <X size={16} />
        </button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Mission name"
          className="bg-base-700/40 border border-base-600 rounded-badge px-3 py-2 text-base sm:text-sm text-ink-100 placeholder:text-ink-700 outline-none focus:border-xp/50 sm:col-span-2"
        />
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What is this mission, in one or two sentences?"
          rows={2}
          className="bg-base-700/40 border border-base-600 rounded-badge px-3 py-2 text-base sm:text-sm text-ink-100 placeholder:text-ink-700 outline-none focus:border-xp/50 sm:col-span-2 resize-none"
        />
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value as MissionCategory)}
          className="bg-base-700/40 border border-base-600 rounded-badge px-3 min-h-[44px] text-base sm:text-sm text-ink-300 outline-none focus:border-xp/50"
        >
          {CATEGORY_OPTIONS.map((c) => (
            <option key={c} value={c}>
              {c[0].toUpperCase() + c.slice(1)}
            </option>
          ))}
        </select>
        <select
          value={difficulty}
          onChange={(e) => setDifficulty(e.target.value as MissionDifficulty)}
          className="bg-base-700/40 border border-base-600 rounded-badge px-3 min-h-[44px] text-base sm:text-sm text-ink-300 outline-none focus:border-xp/50"
        >
          {DIFFICULTY_OPTIONS.map((d) => (
            <option key={d} value={d}>
              {DIFFICULTY_META[d].label}
            </option>
          ))}
        </select>
      </div>
      <button
        onClick={submit}
        className="w-full sm:w-auto px-4 min-h-[44px] rounded-badge bg-xp text-base-950 text-sm font-medium hover:bg-xp-bright transition-colors"
      >
        Create mission
      </button>
    </div>
  );
}
