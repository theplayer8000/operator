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
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveExecutable } from "./terminal.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** A single reply can be long; this is a ceiling, not an expectation. */
const MAX_REPLY_BYTES = 400_000;
const TIMEOUT_MS = Number(process.env.OPERATOR_CHAT_TIMEOUT_MS ?? 10 * 60_000) || 10 * 60_000;
/** Transcript kept per conversation. Older turns stay in Claude Code's own history. */
const MAX_MESSAGES = 200;

/**
 * One conversation at a time.
 *
 * The owner is one person on a phone; a conversation list would be scaffolding
 * for a problem he does not have yet. "New chat" replaces this rather than
 * adding to a list. The previous `session_id` is not destroyed — Claude Code
 * still holds it on disk — so nothing is truly lost.
 */
let conversation = newConversation();
let messageSeq = 0;

function newConversation() {
  return {
    provider: "claude-code",
    sessionId: null,
    messages: [],
    busy: false,
    startedAt: Date.now(),
    turns: 0,
    lastError: null,
    proc: null,
  };
}

export function reset(identity) {
  if (conversation.proc) conversation.proc.kill();
  conversation = newConversation();
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
      conversation.turns += 1;

      const reply = typeof parsed.result === "string" ? parsed.result : "";
      if (parsed.is_error || reply === "") {
        conversation.lastError = parsed.is_error ? "Claude reported an error" : "empty reply";
        push("assistant", reply || (stderr.trim() || "Claude returned nothing."), { error: true });
      } else {
        push("assistant", reply, {
          costUsd: typeof parsed.total_cost_usd === "number" ? parsed.total_cost_usd : null,
          durationMs: typeof parsed.duration_api_ms === "number" ? parsed.duration_api_ms : null,
        });
      }
      resolveTurn(state());
    }

    proc.on("error", (err) => finish(null, `couldn't start Claude Code: ${err.message}`));
    proc.on("close", (code) => finish(code, null));
  });
}
