import { useState } from "react";
import type { HomelabService } from "@/lib/types";

const INPUT =
  "w-full bg-base-700/40 border border-base-600 rounded-badge px-3 min-h-[44px] text-base sm:text-sm text-ink-100 placeholder:text-ink-700 outline-none focus:border-xp/50 transition-colors";
const LABEL = "text-xs font-mono uppercase tracking-wide text-ink-700 mb-1.5 block";

const EMPTY: Omit<HomelabService, "id"> = {
  name: "",
  description: "",
  host: "localhost",
  port: 3000,
  path: "/",
  protocol: "http",
  stack: "",
};

/**
 * One form for both add and edit — the fields are identical and a service is
 * small enough that a separate edit surface would just be the same six inputs
 * with a different heading.
 */
export default function ServiceForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial?: HomelabService;
  submitLabel: string;
  onSubmit: (value: Omit<HomelabService, "id">) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<Omit<HomelabService, "id">>(
    initial ? { ...initial } : { ...EMPTY }
  );
  const [portText, setPortText] = useState(String(initial?.port ?? EMPTY.port));

  const port = Number(portText);
  const portValid = Number.isInteger(port) && port > 0 && port < 65536;
  const valid = form.name.trim().length > 0 && form.host.trim().length > 0 && portValid;

  function set<K extends keyof Omit<HomelabService, "id">>(
    key: K,
    value: Omit<HomelabService, "id">[K]
  ) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function submit() {
    if (!valid) return;
    onSubmit({
      ...form,
      name: form.name.trim(),
      host: form.host.trim(),
      port,
      path: form.path.trim() || "/",
      stack: form.stack.trim(),
      description: form.description.trim(),
    });
  }

  return (
    <div className="card-base p-4 sm:p-5 mb-5 animate-fade-up">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
        <div className="sm:col-span-2">
          <label className={LABEL} htmlFor="svc-name">
            Name
          </label>
          <input
            id="svc-name"
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="Darams CRM"
            className={INPUT}
          />
        </div>

        <div className="sm:col-span-2">
          <label className={LABEL} htmlFor="svc-desc">
            Description
          </label>
          <input
            id="svc-desc"
            value={form.description}
            onChange={(e) => set("description", e.target.value)}
            placeholder="What it's for"
            className={INPUT}
          />
        </div>

        <div>
          <label className={LABEL} htmlFor="svc-host">
            Host
          </label>
          <input
            id="svc-host"
            value={form.host}
            onChange={(e) => set("host", e.target.value)}
            placeholder="localhost"
            className={INPUT}
          />
          <p className="text-[11px] text-ink-700 mt-1">
            Leave as <span className="font-mono">localhost</span> for anything on this box — links
            follow whatever address you reached Operator on.
          </p>
        </div>

        <div>
          <label className={LABEL} htmlFor="svc-port">
            Port
          </label>
          <input
            id="svc-port"
            value={portText}
            onChange={(e) => setPortText(e.target.value)}
            inputMode="numeric"
            placeholder="5000"
            className={`${INPUT} font-mono ${
              portText !== "" && !portValid ? "border-vital-down/60" : ""
            }`}
          />
          {portText !== "" && !portValid && (
            <p className="text-[11px] text-vital-down mt-1">Must be a number between 1 and 65535.</p>
          )}
        </div>

        <div>
          <label className={LABEL} htmlFor="svc-path">
            Path
          </label>
          <input
            id="svc-path"
            value={form.path}
            onChange={(e) => set("path", e.target.value)}
            placeholder="/"
            className={`${INPUT} font-mono`}
          />
        </div>

        <div>
          <label className={LABEL} htmlFor="svc-protocol">
            Protocol
          </label>
          <select
            id="svc-protocol"
            value={form.protocol}
            onChange={(e) => set("protocol", e.target.value as HomelabService["protocol"])}
            className={INPUT}
          >
            <option value="http">http</option>
            <option value="https">https</option>
          </select>
        </div>

        <div className="sm:col-span-2">
          <label className={LABEL} htmlFor="svc-stack">
            Stack
          </label>
          <input
            id="svc-stack"
            value={form.stack}
            onChange={(e) => set("stack", e.target.value)}
            placeholder="Flask · SQLite"
            className={INPUT}
          />
        </div>
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={submit}
          disabled={!valid}
          className="px-4 min-h-[44px] rounded-badge bg-xp text-base-950 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed hover:bg-xp-bright transition-colors"
        >
          {submitLabel}
        </button>
        <button
          onClick={onCancel}
          className="px-4 min-h-[44px] rounded-badge border border-base-600 text-sm text-ink-300 hover:text-ink-100 transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
