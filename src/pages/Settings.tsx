import { useRef } from "react";
import {
  SlidersHorizontal,
  Download,
  Upload,
  Database,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  RotateCcw,
} from "lucide-react";
import { useSettings } from "@/hooks/useSettings";
import { usePush } from "@/hooks/usePush";
import ConfirmButton from "@/components/ui/ConfirmButton";

const STATUS_META = {
  loading: { label: "Connecting…", dot: "bg-ink-700", text: "text-ink-500" },
  online: { label: "Online", dot: "bg-vital-up ring-2 ring-vital-up/20", text: "text-ink-300" },
  offline: { label: "Offline — using local mirror", dot: "bg-vital-down", text: "text-vital-down" },
  // Refused, not down — see the note in StorageStatus.tsx.
  unauthorised: {
    label: "Not authorised — use the Tailscale address",
    dot: "bg-xp",
    text: "text-xp",
  },
} as const;

export default function Settings() {
  const {
    status,
    health,
    pendingWrites,
    slices,
    busy,
    result,
    clearResult,
    exportData,
    importData,
    clearKeys,
    clearEverything,
  } = useSettings();

  const push = usePush();
  const fileInput = useRef<HTMLInputElement>(null);
  const meta = STATUS_META[status];

  return (
    <div className="max-w-3xl mx-auto lg:mx-0">
      <div className="flex items-center gap-3 mb-5">
        <div className="w-10 h-10 rounded-badge bg-xp/10 border border-xp/25 flex items-center justify-center text-xp">
          <SlidersHorizontal size={18} />
        </div>
        <div>
          <h1 className="font-display text-lg text-ink-100 leading-tight">Settings</h1>
          <p className="text-xs text-ink-500">Storage, backup and reset</p>
        </div>
      </div>

      {result && (
        <div
          className={`flex items-start gap-2 p-3 mb-5 rounded-badge border text-sm ${
            result.ok
              ? "border-vital-up/40 bg-vital-up/10 text-ink-300"
              : "border-vital-down/40 bg-vital-down/10 text-ink-300"
          }`}
        >
          {result.ok ? (
            <CheckCircle2 size={16} className="text-vital-up shrink-0 mt-0.5" />
          ) : (
            <XCircle size={16} className="text-vital-down shrink-0 mt-0.5" />
          )}
          <p className="flex-1 min-w-0">{result.message}</p>
          <button
            onClick={clearResult}
            className="text-xs text-ink-700 hover:text-ink-300 shrink-0 min-h-[24px] px-1"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* --- Storage --- */}
      <section className="card-base p-4 sm:p-5 mb-5 animate-fade-up">
        <header className="flex items-center gap-2 mb-4">
          <Database size={15} className="text-ink-500" />
          <h2 className="font-display text-sm font-medium text-ink-300">Storage</h2>
        </header>

        <div className="flex items-center gap-2 mb-3">
          <span className={`w-2 h-2 rounded-full shrink-0 ${meta.dot}`} aria-hidden />
          <span className={`text-sm ${meta.text}`}>{meta.label}</span>
        </div>

        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
          <div>
            <dt className="text-ink-700 mb-1">Data file</dt>
            <dd className="font-mono text-ink-300 break-all">{health?.dataFile ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-ink-700 mb-1">Schema version</dt>
            <dd className="font-mono text-ink-300">{health?.schemaVersion ?? "—"}</dd>
          </div>
        </dl>

        {pendingWrites && (
          <p className="flex items-start gap-1.5 text-xs text-ink-300 mt-3 pt-3 border-t border-base-600">
            <AlertTriangle size={13} className="text-xp shrink-0 mt-0.5" />
            There are writes the server hasn't accepted yet. They'll flush on the next successful
            write — don't import until they have, or the import will be overwritten.
          </p>
        )}
      </section>

      {/* --- Backup --- */}
      {/*
        Notifications, as a card rather than a prompt on load.

        iOS refuses `Notification.requestPermission()` outside a real tap, and
        only from the HOME-SCREEN app rather than a Safari tab — so this has to
        be a button he presses, and the copy has to be able to say which of
        those two rules is currently in the way.
      */}
      <section className="card-base p-4 sm:p-5 mb-5 animate-fade-up">
        <header className="mb-1">
          <h2 className="font-display text-sm font-medium text-ink-300">Notifications</h2>
        </header>
        <p className="text-xs text-ink-700 mb-4 leading-relaxed">
          Operator tells this device when a turn needs an answer, or when something changed that
          you did not do. Delivered by your phone's push service, which carries an{" "}
          <span className="text-ink-500">encrypted</span> payload — it can see that a notification
          happened, never what it said.
        </p>

        <div className="flex items-center gap-3 flex-wrap">
          <span
            className={`inline-flex items-center gap-2 text-xs font-mono ${
              push.state === "on" ? "text-vital-up" : "text-ink-600"
            }`}
          >
            <span
              className={`w-2 h-2 rounded-full ${
                push.state === "on" ? "bg-vital-up" : "bg-base-500"
              }`}
            />
            {push.state === "on" ? "on for this device" : "off for this device"}
          </span>

          {push.state === "on" ? (
            <button
              onClick={() => void push.unsubscribe()}
              disabled={push.busy}
              className="px-3 min-h-[44px] rounded-badge border border-base-600 text-sm text-ink-300 hover:bg-base-700/60 transition-colors disabled:opacity-50"
            >
              {push.busy ? "Working..." : "Turn off"}
            </button>
          ) : (
            <button
              onClick={() => void push.subscribe()}
              disabled={push.busy || push.state === "unsupported" || push.state === "not-installed"}
              className="px-3 min-h-[44px] rounded-badge bg-xp/90 text-base-950 text-sm font-medium hover:bg-xp transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {push.busy ? "Working..." : "Turn on"}
            </button>
          )}
        </div>

        {push.detail && (
          <p className="text-xs text-ink-600 mt-3 leading-relaxed">{push.detail}</p>
        )}
      </section>

      <section className="card-base p-4 sm:p-5 mb-5 animate-fade-up">
        <header className="mb-1">
          <h2 className="font-display text-sm font-medium text-ink-300">Backup</h2>
        </header>
        <p className="text-xs text-ink-700 mb-4 leading-relaxed">
          <span className="text-ink-500">{"data/operator.json"}</span> is gitignored, so git is not
          a backup. Until there's a scheduled copy job, this is the only way to get your data off
          this machine — take one before anything risky.
        </p>

        <div className="flex flex-col sm:flex-row gap-2">
          <button
            onClick={() => void exportData()}
            disabled={busy !== null}
            className="inline-flex items-center justify-center gap-2 px-4 min-h-[44px] rounded-badge bg-xp text-base-950 text-sm font-medium hover:bg-xp-bright disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <Download size={15} />
            {busy === "export" ? "Exporting…" : "Export backup"}
          </button>

          <button
            onClick={() => fileInput.current?.click()}
            disabled={busy !== null}
            className="inline-flex items-center justify-center gap-2 px-4 min-h-[44px] rounded-badge border border-base-600 text-sm text-ink-300 hover:text-ink-100 hover:border-base-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <Upload size={15} />
            {busy === "import" ? "Importing…" : "Import backup"}
          </button>

          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              // Reset the input so re-picking the same file fires onChange again.
              e.target.value = "";
              if (file) void importData(file);
            }}
          />
        </div>

        <p className="text-[11px] text-ink-700 mt-3 leading-relaxed">
          Import <span className="text-ink-500">merges</span> — a slice missing from the backup is
          left as-is rather than deleted. So export, edit the JSON however you like, and import it
          back to load your own data. To start from nothing first, clear below, then import.
        </p>
      </section>

      {/* --- Reset --- */}
      <section className="card-base p-4 sm:p-5 animate-fade-up">
        <header className="mb-1">
          <h2 className="font-display text-sm font-medium text-ink-300">Clear</h2>
        </header>
        <p className="text-xs text-ink-700 mb-4 leading-relaxed">
          Empties a feature so you can fill it with your own data. This does{" "}
          <span className="text-ink-500">not</span> restore the demo content — cleared means empty.
          There is no undo, so export first.
        </p>

        <ul className="space-y-2 mb-5">
          {slices.map((slice) => (
            <li
              key={slice.label}
              className="flex items-center gap-3 p-3 rounded-badge border border-base-600 bg-base-700/30"
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm text-ink-300">{slice.label}</p>
                <p className="text-xs text-ink-700 leading-relaxed">{slice.description}</p>
              </div>
              {/*
                The full phrase is the accessible name, not decoration:
                ConfirmButton is icon-only, so `label` is all a screen reader
                gets. "Clear" alone would be six identical buttons.
              */}
              <ConfirmButton
                label={`Clear ${slice.label}`}
                onConfirm={() => void clearKeys(slice.keys, slice.label)}
              />
            </li>
          ))}
        </ul>

        <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:justify-between pt-4 border-t border-base-600">
          <div className="min-w-0">
            <p className="text-sm text-vital-down">Clear everything</p>
            <p className="text-xs text-ink-700 leading-relaxed">
              Empties every slice on the server, including any this page doesn't list. You'll be
              left with a blank Operator.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <RotateCcw size={14} className="text-ink-700" />
            <ConfirmButton label="Clear everything" onConfirm={() => void clearEverything()} />
          </div>
        </div>
      </section>
    </div>
  );
}
