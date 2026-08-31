// Listening for a clap, on the machine rather than in a browser tab.
//
// ## Why this moved off the page
//
// The browser version worked and kept not working in the one case that
// matters: while another window was in front. Two separate mechanisms fight it
// there, and fixing either alone leaves it broken — `requestAnimationFrame` is
// throttled to about 1fps in a background window, and Chromium *suspends* an
// AudioContext outright when it decides the page is occluded. Both were
// patched; both are the browser correctly protecting a machine from a page
// that should not be busy when nobody is looking at it.
//
// The page was the wrong place to argue with that. "Clap to summon" is by
// definition something you do while looking at something else, so the listener
// has to be a thing the machine runs, not a thing a tab does.
//
// Moving it here also removes every constraint the browser version carried:
// no secure-context requirement, no per-tab microphone permission, no
// dependence on Operator being open at all. Clap while playing a game and it
// still works.
//
// ## How
//
// ffmpeg captures the microphone and writes raw signed 16-bit PCM to stdout;
// this reads that stream and looks for two sharp transients close together.
// Spawned argv-only with no shell, and no npm package — the same precedent
// `render.mjs` set with Edge, and the one the camera work was already going to
// use. `server/` keeps its one dependency.
//
// ## The posture change, and how it is gated
//
// **This holds the microphone open for as long as Operator runs.** Nothing is
// recorded, nothing is written to disk, and nothing leaves the machine — the
// stream is read in fixed-size chunks, reduced to one number per chunk, and
// discarded. But an always-open microphone is a decision, not a setting, so it
// is **off unless `OPERATOR_LISTEN` names a device** and it is environment-only
// for the same reason `OPERATOR_TERMINAL_DEVICES` is: a worker has `Write`
// across the tree, and a listener it could switch on by editing a file is one
// it could switch on.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

/*
  The device name as ffmpeg's dshow enumerator reports it, e.g.
  "Headset (Tosin's Headphones)". Absent means the listener does not run.

  `ffmpeg -list_devices true -f dshow -i dummy` prints the names.
*/
const DEVICE = process.env.OPERATOR_LISTEN ?? "";

const FFMPEG_CANDIDATES = [
  process.env.OPERATOR_FFMPEG,
  `${process.env.LOCALAPPDATA ?? ""}\\Microsoft\\WinGet\\Links\\ffmpeg.exe`,
  "C:\\ffmpeg\\bin\\ffmpeg.exe",
  "ffmpeg",
].filter(Boolean);

const RATE = 16000;
/** ~16ms of audio. Small enough to time a clap, big enough not to thrash. */
const CHUNK_SAMPLES = 256;

/*
  How loud a transient has to be, RELATIVE to the room.

  A fixed threshold was guessed twice and wrong twice. Measured 2026-08-31 on
  the owner's wired headset: a clap peaks at **0.081** and the room sits at
  **0.001**. The guess was 0.18 — more than double what that microphone can
  produce — so it could never have fired, on any number of claps, in either the
  browser version or this one. Two evenings of "it doesn't work" were one
  unmeasured constant.

  The ratio is the stable thing across microphones, not the absolute: a clap is
  loud *compared to the room*, whatever the gain. So the floor tracks ambient
  and the bar sits well above it, with a hard minimum so silence does not make
  a cough qualify.

  Both ends still overridable, because the next microphone will be different
  again and nobody should need a rebuild to find out.
*/
const AMBIENT_MULTIPLE = Number(process.env.OPERATOR_LISTEN_MULTIPLE ?? 12) || 12;
const MIN_THRESHOLD = Number(process.env.OPERATOR_LISTEN_MIN ?? 0.02) || 0.02;
/** Set this to pin the threshold and ignore the room entirely. */
const FIXED_THRESHOLD = Number(process.env.OPERATOR_LISTEN_THRESHOLD ?? 0) || 0;
/** A clap is over fast; sustained loudness is speech or music. */
const MAX_CLAP_MS = 160;
const MIN_GAP_MS = 90;
const MAX_GAP_MS = 700;
/** One gesture fires once. */
const COOLDOWN_MS = 1500;
/** Ignore everything for this long after Operator itself makes a noise. */
const SELF_MUTE_MS = 1200;

let child = null;
let stopping = false;
let mutedUntil = 0;
let restarts = 0;

/** Latest peak, so the UI can show a meter without the browser holding a mic. */
export const state = { listening: false, device: DEVICE || null, level: 0, threshold: 0, claps: 0, reason: null };

function findFfmpeg() {
  for (const candidate of FFMPEG_CANDIDATES) {
    if (candidate === "ffmpeg") return candidate; // let PATH resolve it
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Stop listening for a moment.
 *
 * Called when Operator speaks: its own voice through the speakers is exactly
 * the kind of transient this is looking for, and a detector that triggers on
 * itself would summon the window every time it finished a sentence.
 */
export function muteBriefly(ms = SELF_MUTE_MS) {
  mutedUntil = Date.now() + ms;
}

/**
 * @param onDoubleClap called on the SECOND clap. Deliberately not after any
 *   view change, so a caller can start capturing speech immediately.
 */
export function startListening(onDoubleClap) {
  if (!DEVICE) {
    state.reason = "OPERATOR_LISTEN is not set — no microphone named";
    return false;
  }
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) {
    state.reason = "ffmpeg not found — set OPERATOR_FFMPEG";
    return false;
  }

  const spawnOnce = () => {
    if (stopping) return;
    child = spawn(
      ffmpeg,
      [
        "-hide_banner",
        "-loglevel", "error",
        "-f", "dshow",
        "-audio_buffer_size", "50",
        "-i", `audio=${DEVICE}`,
        "-ac", "1",
        "-ar", String(RATE),
        "-f", "s16le",
        "-",
      ],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );

    state.listening = true;
    state.reason = null;

    let aboveSince = 0;
    let lastClapAt = 0;
    let firstClapAt = 0;
    let cooldownUntil = 0;
    let carry = Buffer.alloc(0);
    // Seeded low so the bar starts at its minimum rather than wide open.
    let ambient = 0.001;

    child.stdout.on("data", (buf) => {
      // Samples are 2 bytes; a chunk boundary can split one, so keep the odd
      // byte for next time rather than reading a sample that is half of two.
      const data = carry.length ? Buffer.concat([carry, buf]) : buf;
      const usable = data.length - (data.length % 2);
      carry = usable === data.length ? Buffer.alloc(0) : data.subarray(usable);

      for (let offset = 0; offset + CHUNK_SAMPLES * 2 <= usable; offset += CHUNK_SAMPLES * 2) {
        let peak = 0;
        for (let i = 0; i < CHUNK_SAMPLES; i++) {
          const v = Math.abs(data.readInt16LE(offset + i * 2)) / 32768;
          if (v > peak) peak = v;
        }
        state.level = peak;

        /*
          Track the quiet floor, and only the quiet.

          Updated from chunks BELOW the current bar, so a clap does not raise
          the threshold that is meant to catch it — otherwise a run of claps
          would steadily deafen the detector. Slow (1%) because the room's
          level is a background fact, not something to chase.
        */
        const bar = FIXED_THRESHOLD || Math.max(MIN_THRESHOLD, ambient * AMBIENT_MULTIPLE);
        if (peak < bar) ambient = ambient * 0.99 + peak * 0.01;
        state.threshold = bar;

        const now = Date.now();
        if (now < mutedUntil || now < cooldownUntil) continue;

        if (peak >= bar) {
          if (!aboveSince) aboveSince = now;
          continue;
        }
        if (!aboveSince) continue;
        const duration = now - aboveSince;
        aboveSince = 0;
        if (duration > MAX_CLAP_MS) continue;

        state.claps += 1;
        const sinceLast = now - lastClapAt;
        lastClapAt = now;

        if (firstClapAt && sinceLast >= MIN_GAP_MS && sinceLast <= MAX_GAP_MS) {
          firstClapAt = 0;
          cooldownUntil = now + COOLDOWN_MS;
          try {
            onDoubleClap();
          } catch (err) {
            console.warn(`[operator] clap handler failed: ${err?.message ?? err}`);
          }
          continue;
        }
        firstClapAt = now;
      }
    });

    child.stderr.on("data", (d) => {
      const text = String(d).trim();
      if (text) console.warn(`[operator] listen: ${text.slice(0, 200)}`);
    });

    child.on("exit", (code) => {
      child = null;
      state.listening = false;
      if (stopping) return;
      /*
        ffmpeg exits when the device disappears — a headset unplugged, a
        Bluetooth link dropping. Retried with a ceiling rather than forever: a
        device that is genuinely gone should stop being asked for, or this
        respawns a failing process every second until someone notices the log.
      */
      restarts += 1;
      if (restarts > 8) {
        state.reason = `listener stopped after repeated failures (last exit ${code})`;
        console.warn(`[operator] listen: giving up after ${restarts} restarts`);
        return;
      }
      setTimeout(spawnOnce, Math.min(10_000, 500 * restarts));
    });
  };

  spawnOnce();
  return true;
}

export function stopListening() {
  stopping = true;
  state.listening = false;
  try {
    child?.kill();
  } catch {
    /* already gone */
  }
  child = null;
}
