// Read-only project browser for the Dev page.
//
// This is the only part of Operator that touches the filesystem beyond the
// data file, so it is deliberately narrow:
//   - reads only, no write/delete route exists
//   - every path is resolved and checked to still sit inside the repo root,
//     so "../../.." cannot escape
//   - node_modules / .git / dist / data are never listed or served
//     (data has its own API and holds personal content)
//   - text only, with a size cap
//
// The tailnet is the security boundary (ADR 0006). This adds no authentication
// and should never be exposed beyond it.

import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { join, resolve, sep, extname, relative } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const DENY = new Set(["node_modules", ".git", "dist", "data", ".vite"]);
const MAX_BYTES = 400_000;

const TEXT_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".css",
  ".html", ".yml", ".yaml", ".txt", ".gitignore", ".env.example", "",
]);

/** Resolve a repo-relative path, refusing anything that escapes the root. */
function safeResolve(root, rel) {
  const target = resolve(root, rel || ".");
  if (target !== root && !target.startsWith(root + sep)) return null;
  const parts = relative(root, target).split(sep).filter(Boolean);
  if (parts.some((p) => DENY.has(p))) return null;
  return target;
}

export async function listTree(root, rel = ".") {
  const dir = safeResolve(root, rel);
  if (!dir || !existsSync(dir)) return null;

  const entries = await readdir(dir, { withFileTypes: true });
  const items = [];

  for (const e of entries) {
    if (DENY.has(e.name)) continue;
    const child = join(dir, e.name);
    let size = 0;
    if (e.isFile()) {
      try {
        size = (await stat(child)).size;
      } catch {
        continue;
      }
    }
    items.push({
      name: e.name,
      path: relative(root, child).split(sep).join("/"),
      type: e.isDirectory() ? "dir" : "file",
      size,
    });
  }

  items.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1
  );

  return { path: relative(root, dir).split(sep).join("/") || ".", items };
}

export async function readTextFile(root, rel) {
  const file = safeResolve(root, rel);
  if (!file || !existsSync(file)) return { error: "not found" };

  const info = await stat(file);
  if (info.isDirectory()) return { error: "that is a directory" };
  if (info.size > MAX_BYTES) {
    return { error: `too large to display (${Math.round(info.size / 1024)} KB)` };
  }
  if (!TEXT_EXT.has(extname(file).toLowerCase())) {
    return { error: "not a text file" };
  }

  return {
    path: relative(root, file).split(sep).join("/"),
    size: info.size,
    modified: info.mtime.toISOString(),
    content: await readFile(file, "utf8"),
  };
}

/** Branch, short SHA, subject and remote URL — enough to build a GitHub link. */
export async function repoMeta(root) {
  async function git(...args) {
    try {
      const { stdout } = await run("git", args, { cwd: root });
      return stdout.trim();
    } catch {
      return null;
    }
  }

  const remote = await git("config", "--get", "remote.origin.url");
  let webUrl = null;
  if (remote) {
    webUrl = remote
      .replace(/^git@([^:]+):/, "https://$1/")
      .replace(/\.git$/, "");
  }

  return {
    branch: await git("rev-parse", "--abbrev-ref", "HEAD"),
    commit: await git("rev-parse", "--short", "HEAD"),
    subject: await git("log", "-1", "--pretty=%s"),
    committedAt: await git("log", "-1", "--pretty=%cI"),
    remote,
    webUrl,
  };
}
