import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  dropAll,
  dropKey,
  getStatus,
  hasPendingWrites,
  reload,
  subscribeStatus,
  type StoreStatus,
} from "@/lib/remoteStore";
import { ALL_KNOWN_KEYS, BLANK_VALUES, FEATURE_SLICES } from "@/lib/storageKeys";

export interface StoreHealth {
  ok: boolean;
  schemaVersion: number;
  dataFile: string;
}

/** Shape of the file GET /api/state returns, and that import expects back. */
interface StoreFile {
  schemaVersion?: number;
  updatedAt?: string | null;
  state?: Record<string, unknown>;
}

export type SettingsResult = { ok: true; message: string } | { ok: false; message: string };

/**
 * Settings is the one surface that acts on every namespace rather than owning
 * one, so it talks to the storage API directly instead of going through a
 * feature hook. That is deliberate and is the same sanctioned exception the
 * Activity Log has — it reads and administers, it doesn't model anything.
 */
export function useSettings() {
  const status = useSyncExternalStore<StoreStatus>(subscribeStatus, getStatus, () => "loading");
  const [health, setHealth] = useState<StoreHealth | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<SettingsResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/health", { headers: { accept: "application/json" } });
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as StoreHealth;
        if (!cancelled) setHealth(body);
      } catch {
        if (!cancelled) setHealth(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [status]);

  /**
   * Export reads the server, not the local mirror. The mirror only holds what
   * this browser has loaded, so a mirror-based export from a fresh phone would
   * be a convincing-looking partial backup — the worst kind.
   */
  const exportData = useCallback(async (): Promise<SettingsResult> => {
    setBusy("export");
    try {
      const res = await fetch("/api/state", { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`server returned ${res.status}`);
      const body = (await res.json()) as StoreFile;

      const stamp = new Date()
        .toLocaleString("sv-SE")
        .replace(/[: ]/g, "-")
        .slice(0, 19);
      const blob = new Blob([JSON.stringify(body, null, 2)], { type: "application/json" });

      // Object URL + anchor, not the clipboard or the File System Access API —
      // Operator runs at a bare IP over Tailscale, which is not a secure
      // context, and those APIs are unavailable there. See known-issues.
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `operator-backup-${stamp}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);

      const count = Object.keys(body.state ?? {}).length;
      const out: SettingsResult = { ok: true, message: `Exported ${count} slices.` };
      setResult(out);
      return out;
    } catch (err) {
      const out: SettingsResult = {
        ok: false,
        message: `Export failed: ${(err as Error).message}`,
      };
      setResult(out);
      return out;
    } finally {
      setBusy(null);
    }
  }, []);

  /**
   * Import merges — PUT /api/state is a key-by-key merge, so a slice missing
   * from the backup is left alone rather than wiped. That is the safer default
   * for a restore: a partial backup can add back what it has without deleting
   * everything it doesn't. Say so in the UI, because "import" reads like
   * "replace" to most people.
   */
  const importData = useCallback(async (file: File): Promise<SettingsResult> => {
    setBusy("import");
    try {
      if (hasPendingWrites()) {
        throw new Error(
          "there are unsaved writes queued — reconnect to the server and let them flush first, or they will overwrite the import"
        );
      }

      const text = await file.text();
      let parsed: StoreFile;
      try {
        parsed = JSON.parse(text) as StoreFile;
      } catch {
        throw new Error("that file isn't valid JSON");
      }

      // Accept either a full export ({schemaVersion, state}) or a bare
      // {key: value} map, since the latter is what the API itself takes.
      const state =
        parsed && typeof parsed === "object" && parsed.state && typeof parsed.state === "object"
          ? parsed.state
          : (parsed as unknown as Record<string, unknown>);

      if (!state || typeof state !== "object" || Array.isArray(state)) {
        throw new Error("that doesn't look like an Operator backup");
      }
      const keys = Object.keys(state);
      if (keys.length === 0) throw new Error("that backup is empty");

      const res = await fetch("/api/state", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(state),
      });
      if (!res.ok) throw new Error(`server returned ${res.status}`);

      await reload();
      const out: SettingsResult = { ok: true, message: `Imported ${keys.length} slices.` };
      setResult(out);
      return out;
    } catch (err) {
      const out: SettingsResult = {
        ok: false,
        message: `Import failed: ${(err as Error).message}`,
      };
      setResult(out);
      return out;
    } finally {
      setBusy(null);
    }
  }, []);

  /**
   * Clear writes the empty value rather than deleting the key.
   *
   * Deleting is the intuitive implementation and it is wrong here: an absent
   * key makes `getSnapshot` fall through to the feature's seed, so "clear the
   * Dashboard" would hand back the demo tasks. Writing `[]` leaves the slice
   * present and genuinely empty.
   *
   * Keys with no known blank shape are deleted instead — that only happens for
   * a slice added to the app but not to BLANK_VALUES, where guessing an empty
   * shape would be worse than falling back to its seed.
   */
  const clearOne = async (key: string) => {
    const blank = BLANK_VALUES[key];

    if (blank === undefined) {
      const res = await fetch(`/api/state/${encodeURIComponent(key)}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`server returned ${res.status} for ${key}`);
      // Server delete and mirror delete are one operation — see dropKey.
      dropKey(key);
      return;
    }

    const res = await fetch(`/api/state/${encodeURIComponent(key)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: blank }),
    });
    if (!res.ok) throw new Error(`server returned ${res.status} for ${key}`);
  };

  const clearKeys = useCallback(async (keys: string[], label: string): Promise<SettingsResult> => {
    setBusy(label);
    try {
      for (const key of keys) await clearOne(key);
      // Re-read rather than patching the cache slice by slice — one round trip
      // and no chance of the two drifting.
      await reload();
      const out: SettingsResult = { ok: true, message: `${label} is now empty.` };
      setResult(out);
      return out;
    } catch (err) {
      const out: SettingsResult = {
        ok: false,
        message: `Clear failed: ${(err as Error).message}`,
      };
      setResult(out);
      return out;
    } finally {
      setBusy(null);
    }
  }, []);

  const clearEverything = useCallback(async (): Promise<SettingsResult> => {
    setBusy("everything");
    try {
      // Take the key list from the server, not from FEATURE_SLICES — a slice
      // added since this file was last touched still gets cleared.
      const res = await fetch("/api/state", { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`server returned ${res.status}`);
      const body = (await res.json()) as StoreFile;
      const keys = new Set([...Object.keys(body.state ?? {}), ...ALL_KNOWN_KEYS]);

      for (const key of keys) await clearOne(key);
      dropAll();
      await reload();

      const out: SettingsResult = {
        ok: true,
        message: `Cleared ${keys.size} slices. Everything is empty and ready for your data.`,
      };
      setResult(out);
      return out;
    } catch (err) {
      const out: SettingsResult = {
        ok: false,
        message: `Clear failed: ${(err as Error).message}`,
      };
      setResult(out);
      return out;
    } finally {
      setBusy(null);
    }
  }, []);

  return {
    status,
    health,
    pendingWrites: hasPendingWrites(),
    slices: FEATURE_SLICES,
    busy,
    result,
    clearResult: () => setResult(null),
    exportData,
    importData,
    clearKeys,
    clearEverything,
  };
}
