import { useCallback, useEffect, useSyncExternalStore } from "react";
import { getSnapshot, load, set, subscribe } from "@/lib/remoteStore";

/**
 * Drop-in replacement for useLocalStorage, backed by the storage server.
 *
 * Same signature as before — `[value, setValue]`, setter accepts a value or an
 * updater — so feature hooks did not have to change when storage moved off the
 * browser. The difference is that state now lives in one shared module-level
 * cache rather than one useState per call site, so every component sees the
 * same data and writes are never lost to an unmount.
 */
export function useRemoteStorage<T>(key: string, initial: T) {
  useEffect(() => {
    void load();
  }, []);

  const value = useSyncExternalStore(
    (fn) => subscribe(key, fn),
    () => getSnapshot<T>(key, initial),
    () => initial
  );

  const setValue = useCallback(
    (next: T | ((prev: T) => T)) => {
      const resolved =
        typeof next === "function"
          ? (next as (prev: T) => T)(getSnapshot<T>(key, initial))
          : next;
      set(key, resolved);
    },
    // `initial` is a stable seed reference from lib/seed.ts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key]
  );

  return [value, setValue] as const;
}
