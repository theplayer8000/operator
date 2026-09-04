// A filesystem for a worker that has no harness of its own.
//
// ## Why this exists
//
// The owner, 2026-09-04: *"airouter should have that too please because when
// claude is down ai router is the second most capable worker."*
//
// That is the whole case. Claude Code gets its filesystem from the Agent SDK —
// Read, Write, Edit, Bash, the pre-allow list, the permission callback. AI
// Router gets an OpenAI-shaped `chat/completions` endpoint and nothing else, so
// until now "the fallback worker" could talk about the code and never touch it.
// When Claude hit a limit mid-job the reroute landed on a worker that could
// answer questions and not do the work.
//
// This is the missing half: file tools, declared to any OpenAI-compatible
// worker, executed here under boundaries that are not the model's to choose.
//
// ## Deliberately NOT a capability action
//
// `actions.mjs` is Operator's own DATA — gym, missions, calendar, the vault.
// Editing source is not that, and putting file writes in the capability
// catalogue would hand them to every worker including the 3B local model and
// the routing classifier. This is a worker CAPABILITY, granted per provider in
// `providers.mjs`, which is the same distinction `delegate.mjs` draws when it
// refuses to be an action.
//
// ## The four boundaries, and why each one is where it is
//
// **1. Reads are scoped to the project. Writes are scoped to the job's own
// checkout.** Reads may span the agent worktree and the main checkout, because
// reading main is how a worker learns what shipped. Writes may only land in
// `cwd` — the agent worktree — so AI Router's mistakes are exactly as isolated
// as Claude's are, and become visible only when a human merges the branch.
//
// **2. A deny-list INSIDE the roots, which is the new thing.** `delegate.mjs`
// checks roots and stops there, and it can afford to: the CALLER names the
// files. Here the MODEL names them, and a model that can read anything under
// the repository root can read `data/operator.json` — his gym log, his
// calendar, his missions, everything Operator holds — and `data/subscriptions.json`,
// which carries a per-device push secret, and `data/serve.log`, which is the
// terminal's command audit. All of it would leave for `api.airouter.ch`.
// Everything under `data/` is therefore refused, and the refusal names the
// capability action that answers the question properly.
//
// **3. Writes ask, using the mechanism that already exists.** `jobs.mjs` passes
// `onPermission` into EVERY provider's turn, not just Claude's — it was simply
// never called by anything but the SDK path. So a write here suspends the turn
// and puts the same Allow / No / Allow-and-stop-asking card on his phone, and
// the same turn carries on when he taps. No new mechanism, no second permission
// model to keep in step with the first.
//
// **4. Commands are named, never a shell.** `run_check` takes the NAME of a
// check and runs a fixed argv. This is `apps.mjs`'s bargain — "a caller picks
// WHICH app and never what runs" — and it is the difference between a worker
// that can verify its own work and a worker with arbitrary execution as the
// owner on a machine `threat-model.md` says has no sandbox.
//
// No dependencies. Node built-ins only.

import { readFile, writeFile, readdir, stat, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, relative, isAbsolute, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);

/** Off with `OPERATOR_WORKER_FILES=0`; on wherever a worker declares it. */
export const enabled = (process.env.OPERATOR_WORKER_FILES ?? "1").trim() !== "0";

/*
  Caps. Each one is a limit on a MISTAKE rather than on the model.

  AI Router's window is 262K tokens, so none of these is near a capability
  limit — they are there because a loop that reads a 40MB log into a prompt is
  a bill and a hang, and because a cap that reports itself is better than one
  that silently drops the interesting half.
*/
const MAX_READ_CHARS = 200_000;
const MAX_WRITE_CHARS = 500_000;
const MAX_LIST = 400;
const MAX_MATCHES = 120;
const CHECK_TIMEOUT_MS = 10 * 60_000;

/**
 * Where a worker may look.
 *
 * Same shape as `delegate.mjs`'s roots(), deliberately — two places that answer
 * "is this Operator's own source" should not drift apart.
 */
function roots(cwd) {
  const here = dirname(dirname(fileURLToPath(import.meta.url)));
  const list = [cwd, process.env.OPERATOR_JOB_CWD, process.env.OPERATOR_REPO, here, process.cwd()];
  return [...new Set(list.filter(Boolean).map((p) => resolve(p)))];
}

function within(root, target) {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/*
  What is refused even inside a root.

  Every entry here is a specific thing that would otherwise leave the machine or
  hand a worker a lever on its own permissions:

  - `data/`      the store, the push subscriptions' per-device secrets, the
                 usage ledger and the terminal's command audit log. Reads have
                 capability actions; this is not the route.
  - `.env`       keys, by the only convention that matters.
  - `.git/`      object store and credential helpers — reading it is reading
                 every version of everything, including files deleted for cause.
  - `.claude/`   settings, including the permission rules. A worker able to
                 write here could widen what the OTHER worker is allowed to do,
                 which is the same escalation `OPERATOR_TERMINAL_DEVICES` being
                 environment-only exists to prevent.
  - build output and dependencies: enormous, generated, and never the answer.
*/
const DENIED = [
  { test: (rel) => rel === "data" || rel.startsWith(`data${sep}`), why: "the store and its secrets live here — use a capability action (`node scripts/operator-action.mjs list`) to read Operator's data" },
  { test: (rel) => /(^|[\\/])\.env(\.|$)/i.test(rel), why: "environment files hold API keys" },
  { test: (rel) => rel === ".git" || rel.startsWith(`.git${sep}`), why: "the git object store is every version of every file, including ones deleted deliberately" },
  { test: (rel) => rel === ".claude" || rel.startsWith(`.claude${sep}`), why: "these are permission rules — a worker that can edit them can widen its own reach" },
  { test: (rel) => rel.startsWith(`node_modules${sep}`) || rel === "node_modules", why: "dependencies — read the source, not the package" },
  { test: (rel) => rel === "dist" || rel.startsWith(`dist${sep}`), why: "build output; read src/ instead" },
  { test: (rel) => rel.startsWith(join("src-tauri", "target")), why: "Rust build output" },
  { test: (rel) => /\.log$/i.test(rel), why: "logs carry command audit lines and can be enormous" },
];

export class WorkspaceError extends Error {}

/**
 * Resolve a model-supplied path, or refuse with a reason it can act on.
 *
 * `mode` is "read" or "write", and the difference is the point: reads may reach
 * any project root, writes may only reach the job's own checkout.
 */
function resolvePath(path, { cwd, mode }) {
  if (!path || typeof path !== "string") throw new WorkspaceError("path is required");
  const base = resolve(cwd || process.cwd());
  const target = isAbsolute(path) ? resolve(path) : resolve(base, path);

  const allowed = mode === "write" ? [base] : roots(cwd);
  if (!allowed.some((root) => within(root, target))) {
    throw new WorkspaceError(
      mode === "write"
        ? `"${path}" is outside this job's checkout (${base}). A worker writes into its own worktree only — that is what keeps unfinished work off the running app.`
        : `"${path}" is outside the project. A worker reads Operator's source, not the disk.`,
    );
  }

  // The deny-list is relative to whichever root actually contains it, so
  // `data/` is refused in the worktree and in main alike.
  for (const root of allowed) {
    if (!within(root, target)) continue;
    const rel = relative(resolve(root), target);
    for (const rule of DENIED) {
      if (rule.test(rel)) {
        // Name the verb that was refused. "not readable" on a WRITE reads as a
        // different failure and sends the model looking for the wrong fix.
        throw new WorkspaceError(
          `"${path}" is not ${mode === "write" ? "writable" : "readable"} by a worker: ${rule.why}`,
        );
      }
    }
  }
  return target;
}

/** A path the model can quote back, rather than a machine-specific absolute. */
function display(target, cwd) {
  const rel = relative(resolve(cwd || process.cwd()), target);
  return rel && !rel.startsWith("..") ? rel.split(sep).join("/") : target;
}

/**
 * Suspend the turn and ask, exactly as the SDK path does.
 *
 * `onPermission` is already handed to every provider by `jobs.mjs`; nothing but
 * the Claude path had ever called it. When it is absent — a delegated sub-task,
 * a test — the answer is NO rather than yes: a write that cannot be asked about
 * is a write nobody agreed to.
 */
async function permit({ onPermission, signal }, tool, subject) {
  if (typeof onPermission !== "function") {
    throw new WorkspaceError(
      `${tool} needs the owner's approval and this turn has no way to ask him — it is running without a permission channel`,
    );
  }
  const allowed = await onPermission({ tool, subject, input: { subject }, title: "", description: "", signal });
  if (!allowed) throw new WorkspaceError(`${tool} was refused by the owner`);
  return true;
}

// --- the tools --------------------------------------------------------------

async function readFileTool({ path, offset, limit }, ctx) {
  const target = resolvePath(path, { cwd: ctx.cwd, mode: "read" });
  let body;
  try {
    body = await readFile(target, "utf8");
  } catch (err) {
    throw new WorkspaceError(`cannot read "${path}": ${err?.code === "ENOENT" ? "no such file" : err?.message}`);
  }
  const lines = body.split("\n");
  const from = Math.max(0, Number(offset) || 0);
  const count = limit ? Math.max(1, Number(limit)) : lines.length;
  let text = lines.slice(from, from + count).join("\n");
  let truncated = false;
  if (text.length > MAX_READ_CHARS) {
    text = text.slice(0, MAX_READ_CHARS);
    truncated = true;
  }
  return {
    path: display(target, ctx.cwd),
    lines: lines.length,
    from: from + 1,
    text,
    ...(truncated ? { truncated: `stopped at ${MAX_READ_CHARS} characters — read a line range instead` } : {}),
  };
}

async function listFilesTool({ path = ".", depth = 2 }, ctx) {
  const target = resolvePath(path, { cwd: ctx.cwd, mode: "read" });
  const out = [];
  const maxDepth = Math.max(1, Math.min(Number(depth) || 2, 6));

  async function walk(dir, level) {
    if (out.length >= MAX_LIST || level > maxDepth) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= MAX_LIST) return;
      const full = join(dir, entry.name);
      try {
        resolvePath(full, { cwd: ctx.cwd, mode: "read" });
      } catch {
        // Denied paths are skipped rather than reported per-entry: a listing
        // of `.` should not be half refusal messages.
        continue;
      }
      if (entry.isDirectory()) {
        out.push(`${display(full, ctx.cwd)}/`);
        await walk(full, level + 1);
      } else {
        out.push(display(full, ctx.cwd));
      }
    }
  }

  await walk(target, 1);
  return {
    path: display(target, ctx.cwd),
    count: out.length,
    entries: out,
    ...(out.length >= MAX_LIST ? { truncated: `stopped at ${MAX_LIST} entries — narrow the path` } : {}),
  };
}

async function searchFilesTool({ query, path = ".", glob }, ctx) {
  if (!query) throw new WorkspaceError("query is required");
  const target = resolvePath(path, { cwd: ctx.cwd, mode: "read" });
  let re;
  try {
    re = new RegExp(query, "i");
  } catch (err) {
    throw new WorkspaceError(`"${query}" is not a valid regular expression: ${err?.message}`);
  }
  const suffix = typeof glob === "string" && glob.trim() ? glob.trim().replace(/^\*/, "") : null;
  const matches = [];

  async function walk(dir, level) {
    if (matches.length >= MAX_MATCHES || level > 8) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (matches.length >= MAX_MATCHES) return;
      const full = join(dir, entry.name);
      try {
        resolvePath(full, { cwd: ctx.cwd, mode: "read" });
      } catch {
        continue;
      }
      if (entry.isDirectory()) {
        await walk(full, level + 1);
        continue;
      }
      if (suffix && !entry.name.endsWith(suffix)) continue;
      let body;
      try {
        const info = await stat(full);
        if (info.size > MAX_READ_CHARS * 4) continue;
        body = await readFile(full, "utf8");
      } catch {
        continue;
      }
      const lines = body.split("\n");
      for (let i = 0; i < lines.length && matches.length < MAX_MATCHES; i += 1) {
        if (re.test(lines[i])) {
          matches.push({ path: display(full, ctx.cwd), line: i + 1, text: lines[i].trim().slice(0, 240) });
        }
      }
    }
  }

  await walk(target, 1);
  return {
    query,
    count: matches.length,
    matches,
    ...(matches.length >= MAX_MATCHES ? { truncated: `stopped at ${MAX_MATCHES} matches` } : {}),
  };
}

async function writeFileTool({ path, content }, ctx) {
  const target = resolvePath(path, { cwd: ctx.cwd, mode: "write" });
  const body = String(content ?? "");
  if (body.length > MAX_WRITE_CHARS) {
    throw new WorkspaceError(`content is ${body.length} characters; the cap is ${MAX_WRITE_CHARS}`);
  }
  const shown = display(target, ctx.cwd);
  await permit(ctx, "Write", shown);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, body, "utf8");
  return { wrote: shown, chars: body.length };
}

/**
 * Replace one exact string, and only when it appears exactly once.
 *
 * The uniqueness requirement is the safety property. A find/replace that hits
 * three places when the model meant one is a silent corruption of the other
 * two, and this worker has no diff review between it and the file.
 */
async function editFileTool({ path, find, replace }, ctx) {
  const target = resolvePath(path, { cwd: ctx.cwd, mode: "write" });
  if (typeof find !== "string" || find === "") throw new WorkspaceError("find is required");
  if (typeof replace !== "string") throw new WorkspaceError("replace is required (use \"\" to delete)");

  let body;
  try {
    body = await readFile(target, "utf8");
  } catch (err) {
    throw new WorkspaceError(`cannot read "${path}": ${err?.code === "ENOENT" ? "no such file" : err?.message}`);
  }
  const hits = body.split(find).length - 1;
  if (hits === 0) throw new WorkspaceError(`"find" does not appear in ${path} — read the file and copy the exact text, whitespace included`);
  if (hits > 1) throw new WorkspaceError(`"find" appears ${hits} times in ${path}; it must match exactly once — include more surrounding lines`);

  const shown = display(target, ctx.cwd);
  await permit(ctx, "Edit", shown);
  await writeFile(target, body.replace(find, replace), "utf8");
  return { edited: shown, replaced: 1 };
}

/*
  The named checks.

  Fixed argv, `shell: false`, no path or flag taken from the model — it picks
  WHICH check, never what runs.

  **Everything routes through `process.execPath`, never `npm` or `npx`.** Two
  reasons, and the second one is a live bug elsewhere in this repo: the `node`
  on PATH here is a broken shim that exits 0 having run nothing (CLAUDE.md says
  so), and Node 24 refuses to spawn a `.cmd` without a shell — `execFile("npm.cmd", …)`
  throws EINVAL, which is exactly the trap CLAUDE.md warns about and exactly
  what `scripts/land.mjs` walked into. Calling the JS entry points directly
  sidesteps both.
*/
const CHECKS = {
  typecheck: { argv: ["node_modules/typescript/bin/tsc", "-b"], what: "npx tsc -b — the type checker, the project's only automated gate" },
  build: { argv: ["node_modules/vite/bin/vite.js", "build"], what: "npx vite build — must be clean before anything is considered done" },
  syntax: { argv: [], what: "node --check across server/*.mjs and scripts/*.mjs — the gate tsc and vite do NOT cover, because neither reads a .mjs file" },
};

const GIT_CHECKS = {
  git_status: ["status", "--short"],
  git_diff: ["diff", "--stat"],
  git_log: ["log", "--oneline", "-15"],
};

async function runCheckTool({ name }, ctx) {
  const key = String(name ?? "").trim();
  if (GIT_CHECKS[key]) {
    const { stdout } = await run("git", GIT_CHECKS[key], { cwd: ctx.cwd, timeout: 30_000, maxBuffer: 4 << 20 }).catch((err) => ({
      stdout: String(err?.stdout ?? err?.message ?? err),
    }));
    return { check: key, ok: true, output: String(stdout).slice(0, 20_000) };
  }

  const check = CHECKS[key];
  if (!check) {
    throw new WorkspaceError(
      `no check called "${name}". Available: ${[...Object.keys(CHECKS), ...Object.keys(GIT_CHECKS)].join(", ")}`,
    );
  }

  if (key === "syntax") {
    const bad = [];
    let checked = 0;
    for (const dir of ["server", "scripts"]) {
      let entries;
      try {
        entries = await readdir(join(ctx.cwd, dir));
      } catch {
        continue;
      }
      for (const name of entries.filter((n) => n.endsWith(".mjs"))) {
        checked += 1;
        try {
          await run(process.execPath, ["--check", join(dir, name)], { cwd: ctx.cwd, timeout: 30_000 });
        } catch (err) {
          bad.push(`${dir}/${name}: ${String(err?.stderr ?? err?.message ?? err).split("\n")[0]}`);
        }
      }
    }
    return { check: key, ok: bad.length === 0, checked, failures: bad, what: check.what };
  }

  try {
    const { stdout, stderr } = await run(process.execPath, check.argv, {
      cwd: ctx.cwd,
      timeout: CHECK_TIMEOUT_MS,
      maxBuffer: 16 << 20,
    });
    return { check: key, ok: true, output: `${stdout}${stderr}`.trim().slice(-8_000), what: check.what };
  } catch (err) {
    return {
      check: key,
      ok: false,
      // A failing check is DATA, not an error: the model's next move is to read
      // the output and fix the code, which it cannot do if the turn ends here.
      output: `${String(err?.stdout ?? "")}${String(err?.stderr ?? "")}`.trim().slice(-8_000) || String(err?.message ?? err),
      what: check.what,
    };
  }
}

// --- declarations -----------------------------------------------------------

const HANDLERS = {
  read_file: readFileTool,
  list_files: listFilesTool,
  search_files: searchFilesTool,
  write_file: writeFileTool,
  edit_file: editFileTool,
  run_check: runCheckTool,
};

/**
 * OpenAI-shaped declarations, to concatenate with the capability actions.
 *
 * Real nested schemas rather than `actions.mjs`'s single JSON-string parameter.
 * That convention exists because models produce a JSON blob more reliably than
 * a deep schema — but these have two or three flat, differently-typed
 * parameters, and `content` in particular is a whole file that would have to
 * survive being embedded in a JSON string inside a JSON string.
 */
export const TOOLS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read a file from Operator's source. Use this before changing anything. Reads reach the whole project; Operator's DATA (data/) is not here — it has capability actions.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative to the checkout, e.g. server/jobs.mjs" },
          offset: { type: "number", description: "First line (0-based). Optional." },
          limit: { type: "number", description: "How many lines. Optional." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List files and folders under a path.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Defaults to the checkout root." },
          depth: { type: "number", description: "How deep to walk, 1-6. Default 2." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description: "Search file contents with a regular expression. Faster than reading files to find where something is.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "A JavaScript regular expression, case-insensitive." },
          path: { type: "string", description: "Where to search. Defaults to the checkout root." },
          glob: { type: "string", description: "A file suffix to restrict to, e.g. .mjs or .tsx" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Create or replace a file. ASKS THE OWNER first and waits for his answer. Writes land in this job's own checkout, so they are invisible to the running app until a human merges the branch.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string", description: "The whole file." },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Replace one exact string in a file. The text must appear EXACTLY ONCE — include surrounding lines to make it unique. Asks the owner first. Prefer this over write_file for a change to an existing file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          find: { type: "string", description: "Exact text to replace, whitespace included." },
          replace: { type: "string", description: "What to put there. Empty string deletes it." },
        },
        required: ["path", "find", "replace"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_check",
      description:
        "Run one named check. VERIFY YOUR OWN WORK before saying it is done: 'typecheck' and 'build' are the project's gates, and 'syntax' is the one they do not cover because neither reads a .mjs file. Also: git_status, git_diff, git_log. You cannot run arbitrary commands.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "typecheck | build | syntax | git_status | git_diff | git_log",
          },
        },
        required: ["name"],
      },
    },
  },
];

export const TOOL_NAMES = new Set(Object.keys(HANDLERS));

/** Run one file tool. Throws WorkspaceError for anything the model can fix. */
export async function runWorkspaceTool(name, params = {}, ctx = {}) {
  const handler = HANDLERS[name];
  if (!handler) throw new WorkspaceError(`no such tool: ${name}`);
  if (!enabled) throw new WorkspaceError("file tools are disabled (OPERATOR_WORKER_FILES=0)");
  if (!ctx.cwd) throw new WorkspaceError("this turn has no working directory, so it cannot reach the filesystem");
  return handler(params ?? {}, ctx);
}
