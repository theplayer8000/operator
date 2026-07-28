// Starts the storage server and the Vite dev server together.
//
// Deliberately a plain Node script rather than a dependency like `concurrently`
// — the stack is fixed (CLAUDE.md) and this needs nothing that isn't already
// installed. Passes any extra args through to Vite, so `npm run dev -- --host`
// still works exactly as documented.

import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const viteArgs = process.argv.slice(2);
const children = [];

function start(label, command, args) {
  const child = spawn(command, args, {
    cwd: ROOT,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  child.on("exit", (code) => {
    if (code !== 0 && code !== null) console.error(`[${label}] exited with code ${code}`);
    shutdown();
  });
  children.push(child);
  return child;
}

let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  children.forEach((c) => {
    if (!c.killed) c.kill();
  });
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

start("api", process.execPath, [join(ROOT, "server", "index.mjs")]);
start("vite", "npx", ["vite", ...viteArgs]);
