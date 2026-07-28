import { useEffect, useState } from "react";

export default function EditableField({
  label,
  value,
  onChange,
  multiline = false,
  placeholder,
  rows = 3,
}: {
  label?: string;
  value: string;
  onChange: (v: string) => void;
  multiline?: boolean;
  placeholder?: string;
  rows?: number;
}) {
  const [draft, setDraft] = useState(value);

  useEffect(() => setDraft(value), [value]);

  function commit() {
    if (draft !== value) onChange(draft);
  }

  const shared =
    "w-full bg-base-700/40 border border-base-600 rounded-badge px-3 py-2 text-base sm:text-sm text-ink-300 placeholder:text-ink-700 outline-none focus:border-xp/50 transition-colors";

  return (
    <div>
      {label && (
        <p className="text-xs font-mono uppercase tracking-wide text-ink-700 mb-1.5">{label}</p>
      )}
      {multiline ? (
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          placeholder={placeholder}
          rows={rows}
          className={`${shared} resize-none`}
        />
      ) : (
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          placeholder={placeholder}
          className={shared}
        />
      )}
    </div>
  );
}
