import { useCallback, useMemo } from "react";
import { useRemoteStorage } from "./useRemoteStorage";
import { generateId } from "@/lib/id";
import { seedKnowledgeNotes } from "@/lib/seed";
import { searchNotes, backlinks, type SearchHit } from "@/lib/search";
import type { KnowledgeConfidence, KnowledgeKind, KnowledgeNote } from "@/lib/types";

/**
 * The Knowledge Vault. One namespace: `knowledge.notes`.
 *
 * The wiki `MissionDetail`'s "Related Knowledge" tab has been pointing at since
 * the Mission Board was built, where it has held a free-text field and a
 * reserved-section placeholder ever since.
 *
 * ## Reads are as important as writes here
 *
 * `server/actions.mjs` says a new feature needs a READ action, not just writes,
 * because without one a worker greps source to answer a question — which cost
 * $0.92 and two minutes the one time it happened. That applies harder to this
 * feature than to any other: a vault nothing can query is a folder.
 *
 * So the derived views live here rather than in the page, and the capability
 * actions mirror them exactly.
 */
export function useKnowledge() {
  const [notes, setNotes] = useRemoteStorage<KnowledgeNote[]>(
    "knowledge.notes",
    seedKnowledgeNotes,
  );

  /** Everything not archived, newest first. */
  const active = useMemo(
    () =>
      notes
        .filter((n) => !n.archived)
        .slice()
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [notes],
  );

  /**
   * Every topic in use, with how many notes carry it, most used first.
   *
   * Computed rather than stored. A stored topic list needs garbage collection
   * the moment a note is edited or archived, and a vault that shows you a
   * topic leading to nothing is worse than one that shows fewer topics.
   */
  const topics = useMemo(() => {
    const counts = new Map<string, number>();
    for (const note of active) {
      for (const topic of note.topics) counts.set(topic, (counts.get(topic) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([topic, count]) => ({ topic, count }))
      .sort((a, b) => b.count - a.count || a.topic.localeCompare(b.topic));
  }, [active]);

  const byId = useCallback((id: string) => notes.find((n) => n.id === id) ?? null, [notes]);

  /**
   * Search, through the boundary rather than around it.
   *
   * `lib/search.ts` is the Search Service ADR 0009 approved by name, and the
   * whole value of it is that this call site does not change when the scan
   * becomes an embedding lookup.
   */
  const search = useCallback(
    (query: string, { includeArchived = false } = {}): SearchHit[] =>
      searchNotes(includeArchived ? notes : active, query),
    [notes, active],
  );

  const linkedFrom = useCallback((id: string) => backlinks(notes, id), [notes]);

  /** Notes attached to a mission — what the Related Knowledge tab renders. */
  const forMission = useCallback(
    (missionId: string) => active.filter((n) => n.missions.includes(missionId)),
    [active],
  );

  /*
    Lowercased and trimmed on the way in.

    A vault where "Docker", "docker" and " docker" are three topics is a vault
    whose topic list is noise within a month, and the fix has to be at the
    write rather than at every read — the capability layer writes here too, and
    a model will absolutely capitalise a proper noun.
  */
  const cleanTopics = (raw: string[] | undefined) => [
    ...new Set((raw ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean)),
  ];

  const add = useCallback(
    (input: {
      title: string;
      body?: string;
      kind?: KnowledgeKind;
      confidence?: KnowledgeConfidence;
      topics?: string[];
      links?: string[];
      missions?: string[];
      source?: string;
    }): KnowledgeNote => {
      const now = new Date().toISOString();
      const note: KnowledgeNote = {
        id: generateId(),
        title: input.title.trim(),
        body: input.body ?? "",
        kind: input.kind ?? "note",
        // Unverified by default, and that is the honest default: something just
        // written down has by definition not been checked since.
        confidence: input.confidence ?? "unverified",
        topics: cleanTopics(input.topics),
        links: input.links ?? [],
        missions: input.missions ?? [],
        ...(input.source ? { source: input.source } : {}),
        createdAt: now,
        updatedAt: now,
      };
      setNotes((prev) => [note, ...prev]);
      return note;
    },
    [setNotes],
  );

  const update = useCallback(
    (id: string, patch: Partial<Omit<KnowledgeNote, "id" | "createdAt">>) => {
      setNotes((prev) =>
        prev.map((n) =>
          n.id === id
            ? {
                ...n,
                ...patch,
                ...(patch.topics ? { topics: cleanTopics(patch.topics) } : {}),
                updatedAt: new Date().toISOString(),
              }
            : n,
        ),
      );
    },
    [setNotes],
  );

  /**
   * Link or unlink two notes. Calling it again with the same pair removes it,
   * the same shape as `mission_set_dependency`.
   *
   * Self-links are refused rather than silently dropped: a note that links to
   * itself renders as its own backlink, which looks like a bug in the graph
   * rather than in the data.
   */
  const toggleLink = useCallback(
    (id: string, otherId: string) => {
      if (id === otherId) return;
      setNotes((prev) =>
        prev.map((n) =>
          n.id === id
            ? {
                ...n,
                links: n.links.includes(otherId)
                  ? n.links.filter((l) => l !== otherId)
                  : [...n.links, otherId],
                updatedAt: new Date().toISOString(),
              }
            : n,
        ),
      );
    },
    [setNotes],
  );

  /** Attach or detach a note from a mission. Same toggle shape. */
  const toggleMission = useCallback(
    (id: string, missionId: string) => {
      setNotes((prev) =>
        prev.map((n) =>
          n.id === id
            ? {
                ...n,
                missions: n.missions.includes(missionId)
                  ? n.missions.filter((m) => m !== missionId)
                  : [...n.missions, missionId],
                updatedAt: new Date().toISOString(),
              }
            : n,
        ),
      );
    },
    [setNotes],
  );

  /*
    Archive, not delete — the Mission Board's bargain, for the same reason.

    There is no undo anywhere in Operator (OPS-020), and a note is the least
    recoverable thing in the store: a mission can be described again from the
    work, a gym session from the programme, but something you worked out once
    and wrote down is gone.
  */
  const archive = useCallback(
    (id: string, archived = true) => {
      setNotes((prev) =>
        prev.map((n) =>
          n.id === id ? { ...n, archived, updatedAt: new Date().toISOString() } : n,
        ),
      );
    },
    [setNotes],
  );

  /**
   * Permanently remove a note, and every reference to it.
   *
   * The cleanup is the point: a dangling id in another note's `links` renders
   * as a link to nothing, and because backlinks are DERIVED there is no second
   * place to fix it — but the forward edge still has to go.
   */
  const remove = useCallback(
    (id: string) => {
      setNotes((prev) =>
        prev
          .filter((n) => n.id !== id)
          .map((n) => (n.links.includes(id) ? { ...n, links: n.links.filter((l) => l !== id) } : n)),
      );
    },
    [setNotes],
  );

  return {
    notes,
    active,
    topics,
    byId,
    search,
    linkedFrom,
    forMission,
    add,
    update,
    toggleLink,
    toggleMission,
    archive,
    remove,
  };
}
