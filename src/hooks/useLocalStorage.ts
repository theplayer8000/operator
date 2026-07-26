import { useEffect, useState } from "react";
import { readStorage, writeStorage } from "@/lib/storage";

/**
 * Drop-in replacement for useState that persists to localStorage.
 * Every editable piece of dashboard data (tasks, notes, missions...) uses this,
 * so "everything should be editable" holds true with zero backend.
 */
export function useLocalStorage<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => readStorage<T>(key, initial));

  useEffect(() => {
    writeStorage(key, value);
  }, [key, value]);

  return [value, setValue] as const;
}
