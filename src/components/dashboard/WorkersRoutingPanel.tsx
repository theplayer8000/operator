import { Cpu } from "lucide-react";
import type { JobProvider } from "@/hooks/useJobs";

/**
 * WORKERS & ROUTING — pulled out of OperatorControl.tsx (2026-09-09) so the
 * new mobile Control dock can mount the same panel instead of a second copy
 * of it. Pure presentation: every value already comes from whichever
 * `useJobs()` call the parent (desktop's OperatorControl, or the new mobile
 * dock) owns — this component owns no state of its own.
 */
export default function WorkersRoutingPanel({
  providers,
  defaultModel,
  spentUsd,
  budgetUsd,
}: {
  providers: JobProvider[];
  defaultModel: string | undefined;
  spentUsd: number;
  budgetUsd: number | null;
}) {
  return (
    <div className="h-full min-h-0 overflow-y-auto p-2.5">
      <header className="mb-1.5 flex items-center gap-1.5">
        <Cpu size={11} className="shrink-0 text-ink-600" />
        <h2 className="font-mono text-[10px] uppercase tracking-wide text-ink-500">Workers &amp; routing</h2>
      </header>
      <p className="truncate text-[10px] text-ink-700">
        {providers.length > 0 ? providers.map((p) => p.label).join(", ") : "No providers"}
      </p>
      <dl className="mt-1.5 grid grid-cols-2 gap-x-2 gap-y-1 text-[11px]">
        <div>
          <dt className="text-[9px] text-ink-700">Default</dt>
          <dd className="truncate font-mono text-ink-200">{defaultModel || "—"}</dd>
        </div>
        <div>
          <dt className="text-[9px] text-ink-700">Budget</dt>
          <dd className="truncate font-mono text-ink-400">
            {typeof budgetUsd === "number" && budgetUsd > 0 ? `$${spentUsd.toFixed(2)}/$${budgetUsd.toFixed(2)}` : "—"}
          </dd>
        </div>
      </dl>
    </div>
  );
}
