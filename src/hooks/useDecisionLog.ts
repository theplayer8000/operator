import { useCallback, useMemo } from "react";
import { useRemoteStorage } from "./useRemoteStorage";
import { generateId } from "@/lib/id";
import { toDateKey } from "@/lib/time";
import { seedDecisionRecords } from "@/lib/seed";
import type { DecisionRecord, DecisionVerdict } from "@/lib/types";

/**
 * The Decision Log. One namespace: `decisions.records`.
 *
 * The life decision log `MissionDetail`'s "Related Decisions" tab has pointed
 * at with a `ReservedSection` since the Mission Board was built.
 *
 * ## Search stays here, not in `lib/search.ts`
 *
 * `lib/search.ts` is the Search Service boundary ADR 0009 approved BY NAME, and
 * that same ADR warns against extending a permitted boundary because it is
 * already there — "a vault search that can also search missions is a search
 * service that has become a query layer". So this filter lives in the hook: a
 * plain word scan over a log that will hold dozens of entries, not thousands.
 * Cross-entity search is Universal Search's job, designed there.
 *
 * ## Reads matter as much as writes
 *
 * `server/actions.mjs` mirrors these derived views exactly, so a worker asked
 * "what did he decide about X" gets an answer without grepping anything.
 */
export function useDecisionLog() {
  const [records, setRecords] = useRemoteStorage<DecisionRecord[]>(
    "decisions.records",
    seedDecisionRecords,
  );

  /** Everything not archived, most recent decision first. */
  const active = useMemo(
    () =>
      records
        .filter((d) => !d.archived)
        .slice()
        .sort(
          (a, b) =>
            b.decidedOn.localeCompare(a.decidedOn) || b.createdAt.localeCompare(a.createdAt),
        ),
    [records],
  );

  /**
   * Every topic in use, with a count, most used first. Computed, not stored —
   * a stored list needs garbage-collecting the moment a record is edited or
   * archived, and a chip that leads nowhere is worse than a shorter list.
   */
  const topics = useMemo(() => {
    const counts = new Map<string, number>();
    for (const d of active) {
      for (const t of d.topics) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([topic, count]) => ({ topic, count }))
      .sort((a, b) => b.count - a.count || a.topic.localeCompare(b.topic));
  }, [active]);

  const byId = useCallback((id: string) => records.find((d) => d.id === id) ?? null, [records]);

  /**
   * Filter by text. Every term must appear somewhere (title / reasoning /
   * outcome / topic), so two words narrow rather than widen. Order is by
   * recency, not relevance — the log is small enough that "newest matching"
   * is the useful sort.
   */
  const search = useCallback(
    (query: string, { includeArchived = false } = {}): DecisionRecord[] => {
      const pool = includeArchived
        ? records
            .slice()
            .sort((a, b) => b.decidedOn.localeCompare(a.decidedOn))
        : active;
      const terms = query
        .toLowerCase()
        .split(/\s+/)
        .map((t) => t.replace(/[^\p{L}\p{N}_-]/gu, ""))
        .filter(Boolean);
      if (terms.length === 0) return pool;
      return pool.filter((d) => {
        const hay = `${d.title}\n${d.reasoning}\n${d.outcome}\n${d.topics.join(" ")}`.toLowerCase();
        return terms.every((t) => hay.includes(t));
      });
    },
    [records, active],
  );

  /** Decisions attached to a mission — what the Related Decisions tab renders. */
  const forMission = useCallback(
    (missionId: string) => active.filter((d) => d.missions.includes(missionId)),
    [active],
  );

  /*
    Lowercased and trimmed on the way in — same reason as the vault: "Career"
    and "career" as two topics is a topic list that is noise within a month,
    and the capability layer writes here too.
  */
  const cleanTopics = (raw: string[] | undefined) => [
    ...new Set((raw ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean)),
  ];

  const add = useCallback(
    (input: {
      title: string;
      decidedOn?: string;
      reasoning?: string;
      outcome?: string;
      verdict?: DecisionVerdict;
      topics?: string[];
      missions?: string[];
    }): DecisionRecord => {
      const now = new Date().toISOString();
      const record: DecisionRecord = {
        id: generateId(),
        title: input.title.trim(),
        decidedOn: input.decidedOn || toDateKey(new Date()),
        reasoning: input.reasoning ?? "",
        outcome: input.outcome ?? "",
        // Pending by default, and honest: a decision just logged has no
        // outcome yet, and claiming one is the thing this field guards against.
        verdict: input.verdict ?? "pending",
        topics: cleanTopics(input.topics),
        missions: input.missions ?? [],
        createdAt: now,
        updatedAt: now,
      };
      setRecords((prev) => [record, ...prev]);
      return record;
    },
    [setRecords],
  );

  const update = useCallback(
    (id: string, patch: Partial<Omit<DecisionRecord, "id" | "createdAt">>) => {
      setRecords((prev) =>
        prev.map((d) =>
          d.id === id
            ? {
                ...d,
                ...patch,
                ...(patch.topics ? { topics: cleanTopics(patch.topics) } : {}),
                updatedAt: new Date().toISOString(),
              }
            : d,
        ),
      );
    },
    [setRecords],
  );

  /** Attach or detach a decision from a mission. Toggle, like the vault. */
  const toggleMission = useCallback(
    (id: string, missionId: string) => {
      setRecords((prev) =>
        prev.map((d) =>
          d.id === id
            ? {
                ...d,
                missions: d.missions.includes(missionId)
                  ? d.missions.filter((m) => m !== missionId)
                  : [...d.missions, missionId],
                updatedAt: new Date().toISOString(),
              }
            : d,
        ),
      );
    },
    [setRecords],
  );

  /*
    Archive, not delete — OPS-020, the same bargain as a mission and a note.
    A decision and how it turned out is a piece of the owner's history; there
    is no recreating it from anything else in the store.
  */
  const archive = useCallback(
    (id: string, archived = true) => {
      setRecords((prev) =>
        prev.map((d) =>
          d.id === id ? { ...d, archived, updatedAt: new Date().toISOString() } : d,
        ),
      );
    },
    [setRecords],
  );

  return {
    records,
    active,
    topics,
    byId,
    search,
    forMission,
    add,
    update,
    toggleMission,
    archive,
  };
}
