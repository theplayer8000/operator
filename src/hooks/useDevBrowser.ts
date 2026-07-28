import { useCallback, useEffect, useState } from "react";

export interface RepoMeta {
  branch: string | null;
  commit: string | null;
  subject: string | null;
  committedAt: string | null;
  remote: string | null;
  webUrl: string | null;
}

export interface TreeItem {
  name: string;
  path: string;
  type: "dir" | "file";
  size: number;
}

export interface FileView {
  path: string;
  size: number;
  modified: string;
  content: string;
}

/**
 * Read-only client for the dev browser API. Owns no storage and writes
 * nothing — this is a viewer, and the server has no write route to call.
 * Kept out of remoteStore deliberately: this is transient inspection state,
 * not app data, and it should not end up in the store or an export.
 */
export function useDevBrowser() {
  const [meta, setMeta] = useState<RepoMeta | null>(null);
  const [path, setPath] = useState(".");
  const [items, setItems] = useState<TreeItem[]>([]);
  const [file, setFile] = useState<FileView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/dev/meta")
      .then((r) => r.json())
      .then(setMeta)
      .catch(() => setMeta(null));
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetch(`/api/dev/tree?path=${encodeURIComponent(path)}`)
      .then((r) => r.json())
      .then((body) => {
        if (cancelled) return;
        if (body.error) setError(body.error);
        else setItems(body.items ?? []);
      })
      .catch(() => !cancelled && setError("Storage server unreachable."))
      .finally(() => !cancelled && setLoading(false));

    return () => {
      cancelled = true;
    };
  }, [path]);

  const openFile = useCallback(async (rel: string) => {
    setError(null);
    try {
      const res = await fetch(`/api/dev/file?path=${encodeURIComponent(rel)}`);
      const body = await res.json();
      if (body.error) {
        setError(body.error);
        setFile(null);
      } else {
        setFile(body as FileView);
      }
    } catch {
      setError("Storage server unreachable.");
    }
  }, []);

  const openDir = useCallback((rel: string) => {
    setFile(null);
    setPath(rel || ".");
  }, []);

  /** Breadcrumb segments for the current directory, root first. */
  const crumbs =
    path === "."
      ? []
      : path.split("/").map((name, i, all) => ({ name, path: all.slice(0, i + 1).join("/") }));

  return { meta, path, crumbs, items, file, error, loading, openFile, openDir, setFile };
}
