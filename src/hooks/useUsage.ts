import { useCallback, useEffect, useState } from "react";

/**
 * What Operator has spent, and on which accounting basis.
 *
 * ## Why this is its own hook and not part of `useJobs`
 *
 * `useJobs` polls hard — it drives a live conversation and re-fetches on a
 * short interval. Usage changes once per turn and is read on a settings page
 * nobody watches, so hanging it off that poller would mean fetching the whole
 * job list on a screen that shows none of it.
 *
 * ## The shape is not negotiable, and neither is the absence of a total
 *
 * [ADR 0013](docs/decisions/0013-usage-accounting.md): every record carries a
 * `basis`, and **aggregates must not sum across them**. The server deliberately
 * returns no `total` field, and this hook adds none.
 *
 *   billed     real money, charged. A flat-rate provider is billed with a NULL
 *              cost — paid for monthly, no per-turn figure exists.
 *   valuation  what the work WOULD have cost. Claude Code prices tokens at API
 *              list rates while running on the Pro subscription, so this is not
 *              money that was charged and must never be shown as plan usage.
 *   unpriced   tokens spent on a model with no price table entry. Not zero —
 *              unknown. Counting it as $0 is the mistake the ADR exists to stop.
 */

export interface BasisTotals {
  turns: number;
  /** Null means there is no per-turn figure, NOT that it was free. */
  usd: number | null;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning: number;
  };
  durationMs: number;
  /** How many of those turns had a price. */
  priced: number;
  /** How many did not — the honest denominator for `usd`. */
  unknownCost: number;
}

export interface UsageSnapshot {
  usageDay: string;
  priceTableVersion: string;
  today: Record<string, BasisTotals>;
  byProvider: Record<string, { totals: Record<string, BasisTotals> }>;
  quota?: Record<string, { requests?: number; exhausted?: boolean }>;
  ceilings?: Record<string, unknown>;
}

export interface Usage {
  snapshot: UsageSnapshot | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useUsage(): Usage {
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/jobs");
      if (!res.ok) throw new Error(`server said ${res.status}`);
      const body = await res.json();
      /*
        The ledger is spread onto the jobs payload rather than living at its own
        route. Reading it here rather than adding an endpoint keeps the server
        surface where it is — and `/api/jobs` is already the thing that knows
        which workers exist.
      */
      setSnapshot({
        usageDay: body.usageDay,
        priceTableVersion: body.priceTableVersion,
        today: body.today ?? {},
        byProvider: body.byProvider ?? {},
        quota: body.quota,
        ceilings: body.ceilings,
      });
      setError(null);
    } catch (err) {
      setError((err as Error)?.message ?? "Could not read usage.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { snapshot, loading, error, refresh };
}
