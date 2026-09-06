// Roblox Studio, through the official Studio MCP server
// (github.com/Roblox/studio-rust-mcp-server — installs mcp.bat into
// %LOCALAPPDATA%\Roblox and is the piece that actually lets an AI build a
// game: explore the data model, read/edit Luau scripts, run code in the open
// Studio session).
//
// ## Why this module exists
//
// The Open Cloud action (roblox.mjs) talks to Roblox's *cloud* — datastores,
// users, universe configuration. It can never edit a script, because the
// cloud API has no code surface. Building a game needs a live Studio session,
// and the official way for an AI to drive one is the Studio MCP server: a
// stdio process that speaks MCP (Model Context Protocol — newline-delimited
// JSON-RPC over stdin/stdout) and forwards tool calls into whatever place is
// open in Studio on this machine.
//
// So, like roblox.mjs, this is a deliberate passthrough — one action that can
// reach any tool the MCP server exposes — with walls:
//
//   1. The binary is fixed server-side: %LOCALAPPDATA%\Roblox\mcp.bat. A
//      caller cannot pick an executable or pass arguments; the spawn is
//      constructed here and only here.
//   2. No secrets are involved — the MCP server authenticates against Studio
//      locally, and nothing a caller sends can leak or override a key (there
//      is none to leak).
//   3. `tool` is validated against the server's own tool list (tools/list at
//      connect time), so a caller cannot reach an arbitrary method — only the
//      tools Studio actually offers.
//
// What this module does NOT do: it deliberately does not hardcode tool names
// (run_code, get_lua_script_content, …). The rust server's toolset has been
// changing every few months and the schema is discoverable — so discover it
// and pass through. Call `tools_list` first, then call by the real name.
//
// ## The honest caveat
//
// The MCP handshake and framing (initialize -> notifications/initialized ->
// tools/list -> tools/call, one JSON-RPC message per line) come from the MCP
// spec (modelcontextprotocol.io) rather than from a call that succeeded — the
// server had not been reached from Operator when this was written. Errors
// quote whatever comes back, so a wrong assumption is diagnosable rather than
// generic. First real call with Studio open is the test.
//
// One more thing to know: running code in Studio changes the owner's place.
// That is the point of the action (AI building games), but every call is a
// mutation of a real open project — nothing here is sandboxed.
//
// The child process is spawned lazily on first call and kept for the life of
// the server; it dies when Operator's server exits. No dependencies beyond
// Node's own modules.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const env = (name) => (process.env[name] ?? "").replace(/^\uFEFF/, "").trim();

const MCP_DIR = env("LOCALAPPDATA") ? join(env("LOCALAPPDATA"), "Roblox") : "";
const MCP_BAT = MCP_DIR ? join(MCP_DIR, "mcp.bat") : "";

// Gate for the actions.mjs registration. Checked once at import: if the MCP
// server is installed later, a code reload (Dev page Restart) picks it up.
export const configured = Boolean(MCP_BAT && existsSync(MCP_BAT));

const CONNECT_TIMEOUT_MS = 15_000; // handshake + tools/list
const DEFAULT_CALL_TIMEOUT_MS = 60_000; // a long run_code can take a while
const MAX_CALL_TIMEOUT_MS = 300_000;
const PROTOCOL_VERSION = "2025-06-18"; // the server may answer with its own; we just proceed

export class StudioError extends Error {}

let session = null; // { proc, nextId, pending, buf, stderr, tools, handshake, protocolVersion }

function requireConfigured() {
  if (!configured) {
    throw new StudioError(
      "mcp.bat not found at %LOCALAPPDATA%\\Roblox\\mcp.bat — install Roblox's Studio MCP server (studio-rust-mcp-server) first, then reload Operator.",
    );
  }
}

function stderrTail(s) {
  return s.stderr.join("").trim().slice(-300);
}

function die(s, message) {
  const tail = stderrTail(s);
  const finalMsg = tail ? `${message} Server said: ${tail}` : message;
  if (session === s) session = null;
  if (s.handshakeReject) {
    const r = s.handshakeReject;
    s.handshakeReject = null;
    r(new StudioError(finalMsg));
  }
  for (const p of s.pending.values()) p.reject(new StudioError(finalMsg));
  s.pending.clear();
  try {
    s.proc?.kill();
  } catch {
    // already gone
  }
}

function write(s, msg) {
  s.proc.stdin.write(JSON.stringify(msg) + "\n");
}

function drain(s) {
  let i;
  while ((i = s.buf.indexOf("\n")) >= 0) {
    const line = s.buf.slice(0, i).replace(/\r$/, "");
    s.buf = s.buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // startup banner / non-JSON chatter — ignore
    }
    if (msg?.jsonrpc !== "2.0" || msg.id === undefined) continue; // server notification
    const p = s.pending.get(msg.id);
    if (!p) continue;
    s.pending.delete(msg.id);
    if (msg.error) p.reject(new StudioError(`MCP ${msg.error.code}: ${msg.error.message}`));
    else p.resolve(msg.result);
  }
}

function request(s, method, params, timeoutMs = CONNECT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const id = s.nextId++;
    const t = setTimeout(() => {
      s.pending.delete(id);
      reject(new StudioError(`${method} did not answer within ${timeoutMs / 1000}s`));
    }, timeoutMs);
    s.pending.set(id, {
      resolve: (res) => {
        clearTimeout(t);
        resolve(res);
      },
      reject: (err) => {
        clearTimeout(t);
        reject(err);
      },
    });
    write(s, { jsonrpc: "2.0", id, method, params });
  });
}

async function handshake(s) {
  const init = await request(s, "initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "operator-roblox-studio", version: "0.1.0" },
  });
  write(s, { jsonrpc: "2.0", method: "notifications/initialized" });
  const list = await request(s, "tools/list", {});
  s.tools = Array.isArray(list?.tools) ? list.tools : [];
  s.protocolVersion = init?.protocolVersion ?? PROTOCOL_VERSION;
  if (s.handshakeReject) s.handshakeReject = null;
  return s;
}

function spawnSession() {
  let proc;
  try {
    proc = spawn("cmd.exe", ["/d", "/c", ".\\mcp.bat"], {
      cwd: MCP_DIR,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    throw new StudioError(`could not start the Studio MCP server: ${err?.message ?? err}`);
  }
  const s = {
    proc,
    nextId: 1,
    pending: new Map(),
    buf: "",
    stderr: [],
    tools: [],
    handshake: null,
    handshakeReject: null,
    protocolVersion: PROTOCOL_VERSION,
  };
  proc.stdout.setEncoding("utf8");
  proc.stderr.setEncoding("utf8");
  proc.stdout.on("data", (chunk) => {
    s.buf += chunk;
    drain(s);
  });
  proc.stderr.on("data", (chunk) => {
    s.stderr.push(String(chunk));
    if (s.stderr.length > 20) s.stderr.shift();
  });
  proc.on("error", (err) =>
    die(s, `could not start the Studio MCP server: ${err?.message ?? err}`),
  );
  proc.on("exit", (code) =>
    die(
      s,
      `the Studio MCP server exited (code ${code ?? "?"}) — is Roblox Studio open with the MCP side connected?`,
    ),
  );
  return s;
}

async function ensure() {
  requireConfigured();
  if (!session) {
    const s = spawnSession();
    session = s;
    s.handshake = handshake(s);
  }
  const awaited = session;
  try {
    return await awaited.handshake;
  } catch (err) {
    if (session === awaited) session = null;
    throw err;
  }
}

/**
 * One Studio MCP call. `tool` is the name of a tool the connected server
 * exposes — call it with "tools_list" first to discover the current set and
 * their argument schemas. `args` is a JSON object of that tool's arguments.
 */
export async function call({ tool, args = {}, timeoutMs } = {}) {
  const t = String(tool ?? "").trim();
  if (!t) {
    throw new StudioError('tool is required — call with tool "tools_list" to discover what the connected Studio session offers.');
  }
  const squeak = Math.min(Math.max(Number(timeoutMs) || DEFAULT_CALL_TIMEOUT_MS, 1_000), MAX_CALL_TIMEOUT_MS);

  const s = await ensure();

  if (t === "tools_list" || t === "tools/list" || t === "_list") {
    return {
      tools: s.tools.map(({ name, description, inputSchema }) => ({
        name,
        description: description ?? "",
        inputSchema: inputSchema ?? null,
      })),
      protocolVersion: s.protocolVersion,
    };
  }

  const toolDef = s.tools.find((x) => x.name === t);
  if (!toolDef) {
    const names = s.tools.map((x) => x.name).join(", ") || "(none — is Roblox Studio open?)";
    throw new StudioError(`no tool "${t}" on the connected Studio MCP server. Available: ${names}. Call "tools_list" for schemas.`);
  }

  let result;
  try {
    result = await request(s, "tools/call", { name: t, arguments: args ?? {} }, squeak);
  } catch (err) {
    if (err instanceof StudioError && /did not answer/.test(err.message)) {
      die(s, `${t} timed out`);
      throw new StudioError(
        `the MCP call to ${t} did not answer within ${squeak / 1000}s — the MCP session was reset. If it was a long run_code it may still be finishing in Studio; give it a moment, then retry.`,
      );
    }
    throw err;
  }

  const content = Array.isArray(result?.content) ? result.content : [];
  const output = content
    .map((c) => (c?.type === "text" ? c.text : JSON.stringify(c ?? null)))
    .filter((x) => x !== "")
    .join("\n");
  return { tool: t, output, isError: result?.isError === true, protocolVersion: s.protocolVersion };
}
