import { useMemo } from "react";
import { useRemoteStorage } from "./useRemoteStorage";
import { generateId } from "@/lib/id";
import { seedUpdates } from "@/lib/seed";
import { toDateKey } from "@/lib/time";
import type { UpdateEntry, UpdateStatus } from "@/lib/types";

/**
 * Owns `updates.entries` — a running log of what's changed in Operator, plus
 * what's queued, reviewable in the app rather than in git history. Distinct
 * from the Activity Log, which is about the owner's own task/mission activity;
 * this one is about the app's own development.
 */
export function useUpdates() {
  const [entries, setEntries] = useRemoteStorage<UpdateEntry[]>("updates.entries", seedUpdates);

  const pending = useMemo(() => entries.filter((e) => e.status === "pending"), [entries]);

  const done = useMemo(
    () =>
      entries
        .filter((e) => e.status === "done")
        .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "")),
    [entries]
  );

  function addEntry(input: { title: string; detail?: string; status?: UpdateStatus }) {
    if (!input.title.trim()) return;
    const status = input.status ?? "pending";
    const record: UpdateEntry = {
      id: generateId(),
      title: input.title.trim(),
      detail: input.detail?.trim() ?? "",
      status,
      // A pending entry has nothing to date yet — the key is omitted, not set
      // to undefined, since there's no existing value here to overwrite.
      ...(status === "done" ? { date: toDateKey(new Date()) } : {}),
    };
    setEntries((prev) => [record, ...prev]);
  }

  function updateEntry(id: string, patch: Partial<UpdateEntry>) {
    setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  }

  function markDone(id: string) {
    updateEntry(id, { status: "done", date: toDateKey(new Date()) });
  }

  function markPending(id: string) {
    // Explicit undefined, not an omitted key — this clears a date that was
    // already set, which is the overwrite case the spread trap is for.
    updateEntry(id, { status: "pending", date: undefined });
  }

  function deleteEntry(id: string) {
    setEntries((prev) => prev.filter((e) => e.id !== id));
  }

  return {
    entries,
    pending,
    done,
    addEntry,
    updateEntry,
    markDone,
    markPending,
    deleteEntry,
  };
}
