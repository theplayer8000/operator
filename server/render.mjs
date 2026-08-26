// Render a file to a PNG the agent can actually look at.
//
// ## The gap this closes
//
// A worker could already *hand* a rendered file to the owner and could not
// look at one itself. That asymmetry cost a real session three round trips of
// "does this look right?" over a generated PDF — the output was a valid file
// every time, so no test and no amount of reading the code would have caught
// a graphic in the wrong corner.
//
// ## What was already possible, and is therefore NOT here
//
// **Images and PDFs need nothing from this file.** The Agent SDK's `Read` tool
// takes a `pages` parameter for PDFs and presents images visually, and `Read`
// is bare-pre-allowed for every job (see ALLOWED_TOOLS in jobs.mjs). A worker
// that wants to see `board.pdf` should Read it, not render it. Verified
// against @anthropic-ai/claude-agent-sdk 0.3.220, sdk-tools.d.ts.
//
// The genuine gap was **HTML and SVG**, which have no visual form until
// something lays them out. That is all this module does.
//
// ## Why a browser, and no dependency
//
// Chromium is already on this machine as Edge. Headless Chromium lays out HTML
// exactly as the owner's browser will, which a library would only approximate,
// and it costs `server/` nothing — the no-npm rule of ADR 0012 holds, and there
// is no Python runtime to install.
//
// ## Three things that will bite the next session
//
// All three were measured on 2026-08-26, and the first two are the same lesson
// from different directions: **this browser reports success it has not earned,
// so only the file on disk is evidence.**
//
// 1. **It exits 0 having written nothing.** With a shared profile it hands the
//    URL to an already-running Edge, prints "Opening in existing browser
//    session", returns success and produces no file. The isolated
//    `--user-data-dir` below is what prevents that.
// 2. **The process Node spawns is a launcher, and it exits early.** Checking
//    for the image when it exits found nothing — and the image then appeared a
//    moment later. A render that had worked was reported as a failure. So
//    `runBrowser` waits for the file to exist *and* stop growing, and watches
//    the process only to fail fast when nothing is ever going to arrive.
// 3. **`--screenshot` captures the window, not the document.** There is no
//    full-page flag. A tall page needs a tall `--window-size`; anything below
//    the fold is simply not in the image.
// 4. **A narrow window is NOT a phone.** This is desktop Chromium, which
//    ignores `<meta name="viewport">` entirely; mobile Safari honours it. So
//    `--width 390` renders a 390px-wide *desktop* browser, and the two can
//    disagree. Caught the day this was written: the dashboard clipped at 390
//    and 430 here while being visibly fine on the actual iPhone. Treat narrow
//    renders as approximate, and **check the phone before believing a
//    responsive bug.** Real device emulation needs the DevTools Protocol
//    (`Emulation.setDeviceMetricsOverride`), which no CLI flag covers.
//
// ## No external hosts
//
// Local files and loopback only. A renderer that will fetch any URL is an
// outbound call to a host nobody approved, which is the one rule in CLAUDE.md
// that is never bent — and it would be a quiet way to exfiltrate a page, since
// the fetch happens server-side with the owner's network.

import { spawn } from "node:child_process";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RENDER_DIR = resolve(process.env.OPERATOR_RENDER_DIR ?? join(ROOT, "data", "renders"));
const PROFILE_DIR = join(RENDER_DIR, ".profile");

/** How long a single render may take before the browser is killed. */
const TIMEOUT_MS = Math.max(2000, Number(process.env.OPERATOR_RENDER_TIMEOUT_MS ?? 20000) || 20000);
/** Renders older than this are swept on the next call. */
const KEEP_MS = 24 * 60 * 60 * 1000;

const MAX_DIMENSION = 8000;
const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 900;

/** What a browser can lay out. Anything else is either Read-able already or unsupported. */
const RENDERABLE = new Set([".html", ".htm", ".svg"]);

/*
  Where Chromium lives. Edge first because it ships with Windows and is
  therefore the one that is definitely present; Chrome second for a machine
  that has it instead. OPERATOR_RENDER_BROWSER overrides both — a Linux box
  will need it pointed at chromium or google-chrome.
*/
const BROWSER_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
];

/** The browser this machine will use, or null if there is none. */
export function findBrowser() {
  const override = process.env.OPERATOR_RENDER_BROWSER;
  if (override) return existsSync(override) ? override : null;
  return BROWSER_CANDIDATES.find((p) => existsSync(p)) ?? null;
}

/**
 * What may be rendered.
 *
 * A local path, or a loopback URL so a worker can look at a page the dev
 * server is actually serving — which is the only way to see a React route,
 * since the HTML on disk is an empty div until Vite has run.
 *
 * Everything else is refused. See the header: this must not become a fetcher.
 */
function resolveTarget(target) {
  const value = String(target ?? "").trim();
  if (!value) throw new Error("a file path or loopback URL is required");

  // A Windows drive path is not a URL, however much `C:/x` looks like one.
  // The scheme test below needs two or more characters for exactly this
  // reason — `C:` matched it, and an absolute path was refused as an
  // "unsupported protocol".
  const isDrivePath = /^[a-z]:[\\/]/i.test(value);

  if (!isDrivePath && /^[a-z][a-z0-9+.-]+:/i.test(value) && !/^file:/i.test(value)) {
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`not a valid URL: ${value}`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`unsupported protocol: ${url.protocol}`);
    }
    const host = url.hostname.toLowerCase();
    const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
    if (!loopback) {
      throw new Error(
        `refusing to render ${host} — this renders local files and loopback URLs only. ` +
          `Reaching an external host needs the owner's approval, one host at a time (see CLAUDE.md).`,
      );
    }
    return { url: url.href, label: `${host}${url.pathname}` };
  }

  const path = resolve(value.replace(/^file:\/\/\/?/i, ""));
  const ext = extname(path).toLowerCase();
  // Format before existence, deliberately. Asking to render a PDF is answered
  // the same way whether or not that particular path is there — "Read it
  // instead" — and "no such file" would send the caller off checking the path
  // rather than learning it never needed this.
  if (!RENDERABLE.has(ext)) {
    const hint =
      ext === ".pdf" || /\.(png|jpe?g|gif|webp|bmp)$/i.test(ext)
        ? ` Read it directly instead — the Read tool shows ${ext === ".pdf" ? "PDF pages" : "images"} without rendering.`
        : "";
    throw new Error(`cannot render ${ext || "a file with no extension"}.${hint}`);
  }
  if (!existsSync(path)) throw new Error(`no such file: ${path}`);
  return { url: `file:///${path.replace(/\\/g, "/")}`, label: basename(path) };
}

function clampDimension(value, fallback) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, MAX_DIMENSION);
}

/** Drop renders nobody is going to look at again. Best-effort, never throws. */
async function sweep() {
  try {
    const entries = await readdir(RENDER_DIR, { withFileTypes: true });
    const cutoff = Date.now() - KEEP_MS;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".png")) continue;
      const path = join(RENDER_DIR, entry.name);
      try {
        const info = await stat(path);
        if (info.mtimeMs < cutoff) await rm(path, { force: true });
      } catch {
        /* a file that vanished underneath us needs no sweeping */
      }
    }
  } catch {
    /* no directory yet, or no permission — neither is worth failing a render for */
  }
}

/**
 * Render `target` and return the PNG's path.
 *
 * @param {string} target        local .html/.htm/.svg path, or a loopback URL
 * @param {object} [opts]
 * @param {number} [opts.width]  viewport width  (default 1280)
 * @param {number} [opts.height] viewport height (default 900) — see the header:
 *                               anything below this is NOT in the image
 * @param {number} [opts.wait]   ms of virtual time to let layout and webfonts
 *                               settle before the shot
 */
export async function renderToPng(target, opts = {}) {
  const browser = findBrowser();
  if (!browser) {
    throw new Error(
      "no Chromium-based browser found. Set OPERATOR_RENDER_BROWSER to an Edge, " +
        "Chrome or Chromium executable.",
    );
  }

  const { url, label } = resolveTarget(target);
  const width = clampDimension(opts.width, DEFAULT_WIDTH);
  const height = clampDimension(opts.height, DEFAULT_HEIGHT);
  const wait = Math.min(15000, Math.max(0, Math.floor(Number(opts.wait ?? 1200)) || 0));

  await mkdir(RENDER_DIR, { recursive: true });
  await sweep();

  const slug = label.replace(/[^a-z0-9._-]+/gi, "-").slice(0, 60) || "render";
  const out = join(RENDER_DIR, `${slug}-${randomUUID().slice(0, 8)}.png`);

  const args = [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    // Load-bearing. Without its own profile the browser hands the URL to a
    // running Edge and exits 0 having rendered nothing. See the header.
    `--user-data-dir=${PROFILE_DIR}`,
    `--virtual-time-budget=${wait}`,
    `--window-size=${width},${height}`,
    `--screenshot=${out}`,
    url,
  ];

  const bytes = await runBrowser(browser, args, out, label);
  return { path: out, width, height, bytes, source: url };
}

/*
  Wait for the *image*, not for the process.

  Measured 2026-08-26, and it is the second way this browser reports a render
  it has not finished: the process Node spawns is a launcher that hands the
  work to the real browser and returns immediately. Checking for the file when
  it exits found nothing, then the file appeared a moment later — a render that
  had actually worked was reported as a failure.

  So the loop below polls for the file and, because a screenshot is not written
  atomically, waits for its size to stop changing before calling it done. The
  process is watched only to fail fast: if the launcher has been gone for a
  while and nothing is on disk, no amount of further waiting will help.
*/
function runBrowser(browser, args, out, label) {
  return new Promise((resolveRun, reject) => {
    // argv only, no shell — same rule as terminal.mjs. A path with a space in
    // it is an argument, not a quoting problem.
    const child = spawn(browser, args, { windowsHide: true, stdio: "ignore" });

    const started = Date.now();
    let exitedAt = 0;
    let lastSize = -1;
    let settled = false;
    let timer = null;

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      fn(arg);
    };

    child.on("error", (err) => finish(reject, new Error(`could not start the browser: ${err.message}`)));
    child.on("exit", () => {
      exitedAt = Date.now();
    });

    const poll = async () => {
      if (settled) return;

      let size = -1;
      try {
        size = (await stat(out)).size;
      } catch {
        /* not written yet */
      }

      if (size > 0 && size === lastSize) {
        finish(resolveRun, size);
        return;
      }
      lastSize = size;

      if (Date.now() - started > TIMEOUT_MS) {
        finish(reject, new Error(`render of ${label} timed out after ${TIMEOUT_MS}ms`));
        return;
      }

      // Gone, and still nothing on disk after a grace period for the handoff.
      if (size < 0 && exitedAt && Date.now() - exitedAt > 3000) {
        finish(
          reject,
          new Error(
            `the browser produced no image for ${label}. It reports success when it ` +
              `hands the page to an already-running instance, so this usually means the ` +
              `isolated profile at ${PROFILE_DIR} could not be used.`,
          ),
        );
        return;
      }

      timer = setTimeout(poll, 150);
    };

    timer = setTimeout(poll, 150);
  });
}

export function renderDir() {
  return RENDER_DIR;
}
