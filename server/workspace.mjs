// A conversation with Claude Code, from Operator.
//
// The terminal next door runs one-shot commands. This is the other half of the
// Embedded Claude Workspace: a conversation that *remembers*, so the owner can
// hand off from a session at his desk and carry on from his phone.
//
// ## Why this needed building rather than "just run claude -p"
//
// Every `claude -p` is a fresh session. Verified:
//
//     claude -p "remember my lucky number is 47"   → noted
//     claude -p "what is my lucky number?"         → "I don't know"
//     claude -c -p "what is my lucky number?"      → "Unknown."
//
// Even `-c` (continue) did not carry it. What does work is asking for JSON,
// keeping the `session_id` it returns, and passing it back:
//
//     claude -p "…" --output-format json           → session_id: 1e6947c9-…
//     claude -p --resume 1e6947c9-… "what is my lucky number?"  → 47
//
// So a conversation here is exactly that: a stored `session_id` plus the
// transcript we have shown the user. Claude Code owns the real history on disk;
// this module owns the thread of it Operator is displaying.
//
// ## Same security gate as the terminal, deliberately
//
// `claude -p` has tool access — it reads files and runs commands. Chatting to it
// is therefore arbitrary execution by another route, so it sits behind the same
// armed-plus-listed-device gate rather than a softer one. A future session must
// not "relax it because it's only chat". It is not only chat.
//
// ## Shaped for a second provider, not built for one
//
// The owner's plan is a single chat page that picks a model per task, behind the
// AI Provider Manager. So a conversation records which `provider` produced it,
// and message handling is provider-agnostic. That is as far as it goes on
// purpose — ADR 0009 permits an infrastructure boundary with **one**
// implementation and forbids speculative second ones. When a real second
// provider arrives, it implements `send()` and the rest of this file does not
// move.

import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveExecutable } from "./terminal.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** A single reply can be long; this is a ceiling, not an expectation. */
const MAX_REPLY_BYTES = 400_000;
const TIMEOUT_MS = Number(process.env.OPERATOR_CHAT_TIMEOUT_MS ?? 10 * 60_000) || 10 * 60_000;
/** Transcript kept per conversation. Older turns stay in Claude Code's own history. */
const MAX_MESSAGES = 200;

// --- permissions ----------------------------------------------------------
//
// Print mode cannot stop and ask. When Claude wants a tool it is not allowed to
// use, the turn simply ends with a polite "needs your approval" and a
// `permission_denials` entry — and from a phone that is a dead end, because the
// approval prompt it refers to only exists in an interactive terminal.
//
// So instead of pretending to be interactive, this reports **what** was wanted
// and **the exact rule that would allow it**, and offers to write that rule to
// `.claude/settings.local.json` — the same file the interactive prompt writes
// to when you approve something at the desk.
//
// Granting a Claude permission is strictly less powerful than what an authorised
// device can already do through the terminal, so this sits behind the same gate
// and adds no new capability. It is a shortcut, not a hole.

const SETTINGS_FILE = join(ROOT, ".claude", "settings.local.json");

/**
 * Turn a raw denial into something showable, plus the rule that would permit it.
 *
 * Rules are generated **exact**, not wildcarded: `Bash(git push --dry-run)`
 * rather than `Bash(git push:*)`. An exact rule allows the thing that was
 * actually asked for and nothing else; broadening it is a decision the owner can
 * make by editing the file, and should not be made for him by a button on a
 * phone.
 */
function describeDenial(d) {
  const tool = d?.tool_name ?? d?.tool ?? null;
  if (!tool) return null;
  const input = d?.tool_input ?? {};
  // Bash is the common case and its `command` is what the rule keys on. Other
  // tools key on a path, so fall back to whichever identifying field exists.
  const isCommand = typeof input.command === "string";
  const rawSubject = isCommand
    ? input.command
    : typeof input.file_path === "string"
      ? input.file_path
      : typeof input.path === "string"
        ? input.path
        : "";

  /*
    A path-based rule has to be written the way the matcher reads it, or the
    grant silently does nothing.

    Claude Code matches file tools (Write, Edit, Read…) against gitignore-style
    paths — forward slashes, relative to the project. `tool_input.file_path`
    on Windows is neither: it arrives as `D:\Projects\Operator\server\jobs.mjs`.
    Writing that verbatim produced a rule that looked right in
    `.claude/settings.local.json`, sat in the allow list, and never fired. The
    owner granted the same write three times and watched it be denied three
    times, because each grant added another rule that could not match.

    Bash is unaffected — its rule keys on the command string as typed, which is
    why that half worked from the start and hid this.
  */
  const subject = isCommand ? rawSubject : toRulePath(rawSubject);

  return {
    tool,
    subject,
    description: typeof input.description === "string" ? input.description : "",
    rule: subject ? `${tool}(${subject})` : tool,
  };
}

/** Absolute Windows path → the forward-slash, project-relative form rules use. */
function toRulePath(raw) {
  if (!raw) return "";
  const slashed = raw.replace(/\\/g, "/");
  const root = ROOT.replace(/\\/g, "/").replace(/\/$/, "");
  // Case-insensitive because Windows paths are, and the drive letter's case
  // varies depending on which tool reported it.
  if (slashed.toLowerCase().startsWith(root.toLowerCase() + "/")) {
    return slashed.slice(root.length + 1);
  }
  return slashed;
}

/** Rules currently allowed, so the UI can avoid offering one that already exists. */
async function readSettings() {
  if (!existsSync(SETTINGS_FILE)) return { permissions: { allow: [] } };
  try {
    const parsed = JSON.parse(await readFile(SETTINGS_FILE, "utf8"));
    if (!parsed.permissions) parsed.permissions = {};
    if (!Array.isArray(parsed.permissions.allow)) parsed.permissions.allow = [];
    return parsed;
  } catch (err) {
    // Never overwrite a file we could not parse — the owner has hand-edited
    // this one and losing it would be worse than refusing.
    throw new Error(`.claude/settings.local.json is unreadable: ${err.message}`);
  }
}

/** Append one rule to the allow list. Idempotent. */
export async function allowRule(rule, identity) {
  const clean = String(rule ?? "").trim();
  if (!clean) throw new Error("no rule given");
  if (clean.length > 2000) throw new Error("rule is implausibly long");

  const settings = await readSettings();
  if (settings.permissions.allow.includes(clean)) {
    return { added: false, rule: clean, reason: "already allowed" };
  }
  settings.permissions.allow.push(clean);

  await mkdir(dirname(SETTINGS_FILE), { recursive: true });
  const tmp = `${SETTINGS_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(settings, null, 2), "utf8");
  const { rename } = await import("node:fs/promises");
  await rename(tmp, SETTINGS_FILE);

  console.log(`[operator] permission allowed by ${identity?.device ?? "unknown"}: ${clean}`);
  return { added: true, rule: clean };
}

/**
 * One conversation at a time.
 *
 * The owner is one person on a phone; a conversation list would be scaffolding
 * for a problem he does not have yet. "New chat" replaces this rather than
 * adding to a list. The previous `session_id` is not destroyed — Claude Code
 * still holds it on disk — so nothing is truly lost.
 */
/**
 * Models the chat may use. Claude Code takes `--model`, verified returning
 * `modelUsage: ["claude-opus-5"]`, so this is a real switch rather than a label.
 * Opus 5 is the default because the owner asked for it; the cheaper option is
 * there for quick questions where the difference does not earn its latency.
 */
export const MODELS = [
  { id: "claude-opus-5", label: "Opus 5" },
  { id: "claude-sonnet-5", label: "Sonnet 5" },
];
const DEFAULT_MODEL = MODELS[0].id;

/*
  The conversation survives a server restart, on disk beside the store.

  It used to live only in memory, which made the feature quietly dishonest: the
  page said the chat remembers, and a restart wiped both the transcript *and*
  the `session_id`. So the history vanished and Claude genuinely forgot — while
  the UI still claimed memory. Losing the transcript was the visible half;
  losing the session id was the half that mattered.

  Its own file rather than a slice of `operator.json`, because this is the
  server's state and not the app's: the client never edits it, and a transcript
  measured in hundreds of KB does not belong in a document that every device
  fetches whole on load.

  Written with temp-file-then-rename, same as the store, so a crash mid-write
  cannot leave a truncated file that fails to parse on the way back up.
*/
const CHAT_FILE = process.env.OPERATOR_CHAT_FILE ?? join(ROOT, "data", "chat.json");

let conversation = newConversation();
let messageSeq = 0;

async function persist() {
  try {
    await mkdir(dirname(CHAT_FILE), { recursive: true });
    const tmp = `${CHAT_FILE}.tmp`;
    await writeFile(
      tmp,
      JSON.stringify(
        {
          provider: conversation.provider,
          model: conversation.model,
          sessionId: conversation.sessionId,
          messages: conversation.messages,
          startedAt: conversation.startedAt,
          turns: conversation.turns,
        },
        null,
        2
      ),
      "utf8"
    );
    await rename(tmp, CHAT_FILE);
  } catch (err) {
    // A conversation that can't be saved is still a conversation worth having.
    console.warn("[operator] could not save the chat transcript:", err.message);
  }
}

async function restore() {
  try {
    if (!existsSync(CHAT_FILE)) return;
    const saved = JSON.parse(await readFile(CHAT_FILE, "utf8"));
    if (!Array.isArray(saved?.messages)) return;
    conversation.provider = saved.provider ?? conversation.provider;
    conversation.model = saved.model ?? conversation.model;
    conversation.sessionId = saved.sessionId ?? null;
    conversation.messages = saved.messages;
    conversation.startedAt = saved.startedAt ?? Date.now();
    conversation.turns = saved.turns ?? 0;
    // Ids must keep climbing or the client's `since` polling would re-show
    // everything it has already rendered.
    messageSeq = conversation.messages.reduce(
      (top, m) => Math.max(top, Number(m.id) || 0),
      0
    );
    console.log(`[operator] chat restored — ${conversation.messages.length} messages`);
  } catch (err) {
    console.warn("[operator] could not read the saved chat, starting fresh:", err.message);
  }
}

await restore();


function newConversation() {
  return {
    provider: "claude-code",
    model: DEFAULT_MODEL,
    sessionId: null,
    messages: [],
    busy: false,
    startedAt: Date.now(),
    turns: 0,
    lastError: null,
    proc: null,
  };
}

export function setModel(id) {
  const found = MODELS.find((m) => m.id === id);
  if (found) conversation.model = found.id;
  return conversation.model;
}

export function reset(identity) {
  const keepModel = conversation.model;
  if (conversation.proc) conversation.proc.kill();
  conversation = newConversation();
  conversation.model = keepModel;
  // Deliberately deleted, not just forgotten in memory. Clearing the chat is
  // how the owner ends a piece of work — the transcript for a shipped patch is
  // not something he wants kept, and a "cleared" chat that reappears after a
  // restart would be a worse lie than not persisting at all.
  rm(CHAT_FILE, { force: true }).catch(() => {});
  console.log(`[operator] chat reset by ${identity?.device ?? "unknown"}`);
  return state();
}

function push(role, text, extra = {}) {
  conversation.messages.push({
    id: String(++messageSeq),
    role,
    text,
    at: new Date().toISOString(),
    ...extra,
  });
  if (conversation.messages.length > MAX_MESSAGES) {
    conversation.messages.splice(0, conversation.messages.length - MAX_MESSAGES);
  }
  // Save after every message rather than on a timer: the case worth surviving
  // is the server dying, and a timer is exactly the thing that doesn't run then.
  persist();
}

/**
 * Serialisable view. `since` returns only messages newer than that id, so the
 * client can poll cheaply without re-rendering the whole transcript — the same
 * offset trick the terminal's output endpoint uses, and for the same reason:
 * polling is what actually works on the owner's phone.
 */
export function state(since = 0) {
  const from = Number.isFinite(since) && since > 0 ? since : 0;
  return {
    provider: conversation.provider,
    model: conversation.model,
    models: MODELS,
    sessionId: conversation.sessionId,
    busy: conversation.busy,
    turns: conversation.turns,
    lastError: conversation.lastError,
    cwd: ROOT,
    latest: messageSeq,
    messages: conversation.messages.filter((m) => Number(m.id) > from),
  };
}

/**
 * Send one message and wait for the reply.
 *
 * Resolves when the turn finishes. The caller returns immediately and the client
 * polls `state()` — a reply can take a minute, which is far past any sensible
 * HTTP timeout on a phone.
 */
export async function send(text, identity) {
  const prompt = String(text ?? "").trim();
  if (!prompt) throw new Error("nothing to send");
  if (conversation.busy) throw new Error("still working on the previous message");

  const resolved = await resolveExecutable("claude");
  if (!resolved) {
    throw new Error("couldn't find Claude Code on this machine — set OPERATOR_TERMINAL_BIN_CLAUDE");
  }

  push("user", prompt);
  conversation.busy = true;
  conversation.lastError = null;

  // `--resume` only on later turns: passing it with no prior session errors.
  const args = [
    ...resolved.prefixArgs,
    "-p",
    ...(conversation.sessionId ? ["--resume", conversation.sessionId] : []),
    prompt,
    "--model",
    conversation.model,
    "--output-format",
    "json",
  ];

  console.log(
    `[operator] chat turn ${conversation.turns + 1} by ${identity?.device ?? "unknown"}` +
      `${conversation.sessionId ? ` (resuming ${conversation.sessionId.slice(0, 8)})` : " (new session)"}`
  );

  return new Promise((resolveTurn) => {
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let settled = false;

    const proc = spawn(resolved.exe, args, {
      cwd: ROOT,
      shell: false,
      windowsHide: true,
      // No stdin, for the same reason as the terminal: an open pipe nobody
      // writes to makes anything that reads stdin wait for the timeout.
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    });
    conversation.proc = proc;

    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (d) => {
      if (bytes < MAX_REPLY_BYTES) {
        stdout += d;
        bytes += Buffer.byteLength(d, "utf8");
      }
    });
    proc.stderr.on("data", (d) => {
      stderr += d;
    });

    const timer = setTimeout(() => {
      if (!settled) {
        proc.kill();
        finish(null, "timed out");
      }
    }, TIMEOUT_MS);
    timer.unref?.();

    function finish(code, failure) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conversation.busy = false;
      conversation.proc = null;

      if (failure) {
        conversation.lastError = failure;
        push("assistant", failure, { error: true });
        return resolveTurn(state());
      }

      // The JSON envelope carries the reply *and* the session id we need for the
      // next turn. Parsing failure is reported rather than swallowed — a silent
      // empty reply is the thing that makes a chat feel broken.
      let parsed = null;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        const detail = (stderr || stdout).trim().slice(0, 600);
        conversation.lastError = "couldn't read Claude's reply";
        push("assistant", detail || `Claude exited ${code} with no output.`, { error: true });
        return resolveTurn(state());
      }

      if (parsed.session_id) conversation.sessionId = parsed.session_id;
      // The session id is the memory. Saving it late is how a crash loses it.
      persist();
      conversation.turns += 1;

      const reply = typeof parsed.result === "string" ? parsed.result : "";
      if (parsed.is_error || reply === "") {
        conversation.lastError = parsed.is_error ? "Claude reported an error" : "empty reply";
        push("assistant", reply || (stderr.trim() || "Claude returned nothing."), { error: true });
      } else {
        push("assistant", reply, {
          // Reported by Claude Code as the API-equivalent cost. On a
          // subscription login (no ANTHROPIC_API_KEY set) this is plan usage,
          // not a charge — the UI must not render it as money.
          costUsd: typeof parsed.total_cost_usd === "number" ? parsed.total_cost_usd : null,
          durationMs: typeof parsed.duration_api_ms === "number" ? parsed.duration_api_ms : null,
          model: conversation.model,
          // What Claude wanted to do and was not allowed to. Print mode cannot
          // stop and ask, so without surfacing this the refusal is invisible.
          denials: Array.isArray(parsed.permission_denials)
            ? parsed.permission_denials.map(describeDenial).filter(Boolean)
            : [],
        });
      }
      resolveTurn(state());
    }

    proc.on("error", (err) => finish(null, `couldn't start Claude Code: ${err.message}`));
    proc.on("close", (code) => finish(code, null));
  });
}
