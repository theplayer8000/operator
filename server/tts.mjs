// A voice that is Operator's, running on Operator's hardware.
//
// ## What is being replaced, and why the current thing is not good enough
//
// Speech out is browser `SpeechSynthesis` today. `src/hooks/useSpeech.ts` now
// picks the best voice installed rather than the platform default — which was
// genuinely the worst one on the machine, a decades-old formant synthesiser
// sitting next to unused neural voices — and that was the free half of the fix.
// The other half is that a *system* voice belongs to the system: it differs on
// the phone and the desk, it cannot be tuned, and it is nobody's voice in
// particular.
//
// Kokoro is the chosen answer (`docs/handoffs/CURRENT.md`, 2026-09-01): an
// 82M-parameter TTS model that runs on CPU, ships 28 voices, and never sees a
// network. Deepgram and ElevenLabs were refused for the reason iOS
// `SpeechRecognition` was refused — hosted means his words go to a company.
//
// ## Why a spawned Python process rather than a package
//
// `server/` takes no npm dependencies (ADR 0012 bounded the single exception to
// `runner.mjs`), so Kokoro cannot be imported. The precedent for an external
// capability here is a spawned binary with a text interface: headless Edge in
// `render.mjs`, ffmpeg in `listen.mjs`, and — closest of all — the resident
// Whisper in `win/transcribe_server.py`, a long-lived Python process holding a
// model, spawned through `uv`, one line in and one line out.
//
// This is that same shape, and deliberately so: the machine already has `uv`,
// already has a CPython 3.11 it manages, and already has `onnxruntime` and
// `numpy` in its `uv` cache because faster-whisper pulled them in. Kokoro's ONNX
// build needs exactly those. Reusing the pattern costs one small Python file
// rather than a second runtime.
//
// A note on `kokoro-js`, which exists and would have been one npm install: it
// is an npm package, and adding one to `server/` needs an ADR naming it. Python
// is already here under a decision that was already taken.
//
// ## This module NEVER downloads the model
//
// Kokoro's weights (~310 MB) and its voice pack (~26 MB) live on Hugging Face
// or a GitHub release — hosts the owner does not control. Under CLAUDE.md's
// approval rule that is an outbound call needing his explicit, named, advance
// say-so, and "it is only fetching a file the feature needs" is precisely the
// reasoning the rule exists to refuse. So the fetch is a thing he does once, by
// hand, and this module's entire response to a missing model is to say where it
// should be. `available()` returns the reason; no code here opens a socket.
//
// **The Python package is a different matter, and it is not free.** `uv run
// --with kokoro-onnx` resolves against PyPI, so the first `start()` on a given
// machine downloads a package tree even though nothing in this file does. That
// is the precedent `listen.mjs` already set with `--with faster-whisper` and not
// a new decision — but it is a network call, it happens inside the READY window,
// and saying "nothing here reaches the network" would be the kind of confident
// half-truth this project keeps getting bitten by. Measured 2026-09-01: the uv
// cache on this machine holds `onnxruntime` and `numpy` (faster-whisper pulled
// them in) but **no `kokoro-onnx` and no espeak wheels**, so the first run is a
// genuine download and can plausibly consume the whole three-minute timeout.
//
// ## Failure is silence here, not a fallback
//
// If Kokoro cannot run, `synthesize` throws and the caller is expected to leave
// the browser's `SpeechSynthesis` in place — which is what every surface does
// today, so a missing model degrades to exactly the current behaviour. There is
// deliberately no SAPI or `ffplay` fallback path in this file: a second local
// synthesiser wired in "just in case" would be a system voice reintroduced
// under a different name, and the whole point is to stop using one.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

/*
  The weights, and why they default inside `data/`.

  `data/` is gitignored, so a 310 MB model cannot be committed by accident —
  which matters more than it sounds, given this repo has a GitHub remote. And
  `scripts/backup.mjs` copies `operator.json` and nothing else, so the hourly
  job will not quietly start making sixty restore points of a third of a
  gigabyte. Both were checked rather than assumed; a model directory under
  `data/` is only safe while both stay true.
*/
const MODEL_DIR = resolve(process.env.OPERATOR_TTS_DIR ?? join(ROOT, "data", "models", "kokoro"));
const MODEL_PATH = resolve(process.env.OPERATOR_TTS_MODEL ?? join(MODEL_DIR, "kokoro-v1.0.onnx"));
const VOICES_PATH = resolve(process.env.OPERATOR_TTS_VOICES ?? join(MODEL_DIR, "voices-v1.0.bin"));

/*
  British male, because he is British and because the thing he keeps comparing
  this to is. Overridable per call as well as per machine — the voice pack holds
  28 of them and `available()` reports the list, so the picker on the page is a
  read of what the model actually shipped rather than a hardcoded menu that can
  drift from it.
*/
const DEFAULT_VOICE = process.env.OPERATOR_TTS_VOICE || "bm_george";
const DEFAULT_SPEED = Number(process.env.OPERATOR_TTS_SPEED ?? 1) || 1;

/*
  Kokoro's output rate. Fixed by the model, not a preference — but this constant
  is knowledge, not measurement: no audio has ever come out of this path. It is
  the FALLBACK only. What `synthesize` reports is read back out of the WAV the
  helper actually wrote (`rateFromWav`), so a wrong number here is inert rather
  than a lie propagated to whatever plays the clip.
*/
const SAMPLE_RATE = 24000;

const UV = process.env.OPERATOR_UV ?? `${process.env.LOCALAPPDATA ?? ""}\\hermes\\bin\\uv.exe`;
const SCRIPT = join(ROOT, "server", "win", "speak_server.py");

/*
  How long to wait for the model to become resident.

  Three minutes, the same as the transcriber, and for a measured reason rather
  than a generous one: this machine has 15.7 GB of RAM and has been seen with
  0.45 GB free, and under that pressure a cold faster-whisper load took **68
  seconds** against 282 ms warm. A timeout sized for a healthy machine would
  turn ordinary paging into "TTS is broken".
*/
const READY_TIMEOUT_MS = Number(process.env.OPERATOR_TTS_READY_MS ?? 180_000) || 180_000;

/*
  A single synthesis has a deadline, unlike a transcription.

  The difference is who is waiting. A transcription happens after a clap, with
  nothing blocked behind it; a synthesis is on the path of an HTTP request from
  a phone that is holding the connection open. A wedged helper must fail the
  request rather than hang it.

  Hitting this KILLS the helper, which is not tidiness — the protocol is
  positional (see the queue below), so a reply that arrives after its caller
  gave up would be handed to the *next* caller. Killing is the only way to
  abandon a request without desynchronising every request after it.
*/
const SPEAK_TIMEOUT_MS = Number(process.env.OPERATOR_TTS_TIMEOUT_MS ?? 60_000) || 60_000;

/*
  Let the model go after a quiet spell.

  Started lazily and released when unused, both because of the RAM number
  above: an idle 300 MB of ONNX weights on a machine that has been down to 0.45
  GB free is the difference between the *next* thing being fast and the next
  thing paging. The cost is that the first sentence after a long silence pays
  the load again, which is the right trade on this hardware and the wrong one on
  a machine with headroom — hence the env var, and 0 to keep it resident.
*/
/*
  Parsed by hand rather than with the `|| fallback` idiom every other constant
  here uses, because 0 is a MEANING (pin the model resident) and not an absence.
  `Number("15m")` is NaN, NaN is falsy, and `touchIdle` reads a falsy value as
  "pinned" — so a plausible typo in this one variable would silently hold 300 MB
  of ONNX weights on the machine the paragraph above says cannot afford them,
  which is the exact opposite of what the person typing it meant. Measured: of
  `"15m"`, `"abc"`, `""`, `"0"`, `"900000"`, only the last two parse to anything
  a reader would predict. Anything that is not a finite, non-negative number is
  treated as unset — including the empty string, which `??` does not catch and
  `Number("")` turns into 0, so `OPERATOR_TTS_IDLE_MS=` in a launch script would
  otherwise read as the deliberate "pin it resident" rather than as the "I did
  not set this" it plainly is.
*/
const IDLE_RAW = Number(process.env.OPERATOR_TTS_IDLE_MS?.trim() || NaN);
const IDLE_MS = Number.isFinite(IDLE_RAW) && IDLE_RAW >= 0 ? IDLE_RAW : 15 * 60_000;

/*
  A ceiling on how much gets spoken in one go.

  Not a technical limit — the helper chunks long text internally, because
  Kokoro's context is about 510 tokens per pass. It is a behavioural one: a
  worker's reply can be two thousand words, and reading all of it aloud is a
  monologue nobody can interrupt from a phone. The caller is told when this
  bites (`truncated`) so it can say "there's more on screen" rather than simply
  stopping mid-thought.
*/
const MAX_CHARS = Math.max(200, Number(process.env.OPERATOR_TTS_MAX_CHARS ?? 1200) || 1200);

/**
 * What the server knows about its own voice.
 *
 * `synthesizing` is **not** `speaking`, and the distinction is the same one
 * `/api/listen` makes about `SpeechSynthesis` today: the audio is played by
 * whichever device asked for it, so the server knows when it is *making* sound
 * and genuinely does not know when that sound is coming out of a speaker. A
 * `speaking` field here would be a confident lie in an API. The page that plays
 * the clip is the one that can answer that, from its own `<audio>` element.
 */
export const state = {
  ready: false,
  synthesizing: false,
  voice: DEFAULT_VOICE,
  voices: [],
  reason: null,
};

/**
 * Strip what should be heard from what is only meant to be read.
 *
 * Deliberately a copy of `speakableText` in `src/hooks/useSpeech.ts` rather
 * than a shared module: nothing in `server/` imports from `src/` (see the note
 * at the top of `scripts/backup.mjs` — that separation is what lets the server
 * be read end to end without a build step), and the two run in different
 * runtimes. The duplication is the cheaper of the two mistakes. If the rules
 * ever diverge, this one is the one that matters — it is the one that decides
 * what actually reaches a speaker once speech moves server-side.
 */
export function speakableText(markdown) {
  return String(markdown ?? "")
    // Fenced code: announce it rather than dictate a shell command.
    .replace(/```[\s\S]*?```/g, " (code omitted) ")
    .replace(/`[^`]*`/g, " ")
    // Links: say the words, not the URL, which is read out character by
    // character and is never what anyone wanted to hear.
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_{1,2}([^_]+)_{1,2}/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Cut to `MAX_CHARS` at a sentence boundary if there is one nearby.
 *
 * Cutting mid-word sounds like a fault; cutting after a full stop sounds like
 * a decision. Only looks back a fifth of the budget for that boundary — beyond
 * that, dropping a large chunk of what he asked to hear is worse than an
 * inelegant edge.
 *
 * Exported for the same reason `listen.mjs` exports `endpoint`: it is the part
 * of this file that can be checked without the model present, and the model is
 * a manual download that may not be there for a while.
 */
export function trimForSpeech(text) {
  if (text.length <= MAX_CHARS) return { text, truncated: false };
  const head = text.slice(0, MAX_CHARS);
  const stop = Math.max(head.lastIndexOf(". "), head.lastIndexOf("? "), head.lastIndexOf("! "));
  const cut = stop > MAX_CHARS * 0.8 ? head.slice(0, stop + 1) : head;
  return { text: cut.trim(), truncated: true };
}

/**
 * Can this machine speak, and if not, exactly what is missing?
 *
 * Every branch names the specific thing and, where it is a file, where to put
 * it. A caller shows this to the owner — "TTS unavailable" would send him
 * hunting through logs for a fact this function already has.
 *
 * Cheap and synchronous-ish: four `existsSync` calls and no subprocess, so a
 * settings page can poll it without waking the model.
 *
 * Which is also the limit of what `ok: true` means, and a caller should not
 * overstate it. Four files being present does not prove `kokoro-onnx` resolves,
 * that a wheel exists for CPython 3.11 on Windows, or that the phonemiser has a
 * backend — none of which can be known without starting the thing. `warm()` is
 * the honest test and `state.voices` is its receipt: it stays empty until a
 * helper has genuinely reached READY, so a voice picker reading this before
 * anything has been warmed gets an empty list rather than a wrong one.
 */
export function available() {
  if (!existsSync(UV)) {
    return { ok: false, reason: `uv not found at ${UV} — set OPERATOR_UV` };
  }
  if (!existsSync(SCRIPT)) {
    return { ok: false, reason: `the synthesiser helper is missing: ${SCRIPT}` };
  }
  if (!existsSync(MODEL_PATH)) {
    return {
      ok: false,
      reason:
        `no Kokoro model at ${MODEL_PATH}. It is a one-off manual download — ` +
        `Operator does not fetch it, because the host it comes from is not one ` +
        `the owner has approved (see CLAUDE.md). Put kokoro-v1.0.onnx there, or ` +
        `point OPERATOR_TTS_MODEL at it.`,
    };
  }
  if (!existsSync(VOICES_PATH)) {
    return {
      ok: false,
      reason:
        `the model is present but the voice pack is not: ${VOICES_PATH}. ` +
        `voices-v1.0.bin ships alongside the model and holds all 28 voices.`,
    };
  }
  return { ok: true, reason: null, voices: state.voices, voice: state.voice, model: MODEL_PATH };
}

/* ------------------------------------------------------------------------
   The synthesiser, held open.

   Same arrangement as the resident transcriber in `listen.mjs`, for the same
   measured reason: there, three quarters of a five-second transcription was
   `uv` starting, Python importing, and weights loading — paid again on every
   single sentence. TTS has the identical shape and a harsher deadline, because
   a voice that answers a second after it is asked feels alive and one that
   answers four seconds later does not.

   Serialised, one synthesis in flight. The protocol is a line in and a line
   out with nothing correlating them, so two overlapping requests would hand
   each caller the other's audio. Overlap is genuinely possible here in a way it
   is not for capture — the phone and the desk can both ask — so this is a real
   queue rather than a formality, and it is still the right call: there is one
   pair of ears, and two clips generated at once could only be played one after
   the other anyway.
   ------------------------------------------------------------------------ */

/** The live helper: `{ proc, waiting, buffer }`, or null when not running. */
let helper = null;
/** Resolves when the model is resident; rejected (and cleared) if it dies. */
let helperReady = null;
/** Tail of the request chain, so requests run one after another. */
let queue = Promise.resolve();
/** Fires after IDLE_MS of no work and releases the weights. */
let idleTimer = null;

function touchIdle() {
  clearTimeout(idleTimer);
  if (!IDLE_MS) return;
  idleTimer = setTimeout(() => {
    /*
      Never release mid-sentence.

      `synthesize` clears this timer on the way in, so the obvious reading is
      that it cannot fire during a synthesis — but `warm()` also calls
      `touchIdle`, and a caller warming the model while a clip is already being
      made re-arms the release *behind* the request in flight. Measured
      2026-09-01 with the release set to 200ms: the running synthesis was killed
      under it and rejected with "the synthesiser exited (null)". The default of
      fifteen minutes hides this behind the 60s synthesis deadline, which is
      luck, not design — and the whole reason this value is an env var is that
      the RAM-starved case wants it turned down.

      Guarding here rather than in `warm` so it holds for every future caller of
      `touchIdle`, not just the one that exposed it.
    */
    if (state.synthesizing) {
      touchIdle();
      return;
    }
    if (helper) console.log(`[operator] tts idle — releasing the model`);
    stopTts();
  }, IDLE_MS);
}

function start() {
  const proc = spawn(
    UV,
    [
      "run",
      // Pinned to the interpreter `uv` already manages on this machine. The
      // Python on PATH is 3.14, which most of the ONNX/audio wheel ecosystem
      // has not built for yet; 3.11 is what the transcriber runs on and what
      // the cached wheels here were built against.
      "--python",
      "3.11",
      "--with",
      "kokoro-onnx",
      "python",
      // -u disables Python's block buffering on a pipe. WITHOUT IT this hangs
      // forever: the audio is written in milliseconds and the line announcing
      // it sits in a buffer that never flushes, which is indistinguishable
      // from a crash. This exact failure has already cost this project a
      // session once — see the note in listen.mjs.
      "-u",
      SCRIPT,
      MODEL_PATH,
      VOICES_PATH,
    ],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
  );

  const live = { proc, waiting: [], buffer: "", tail: "" };

  proc.stdout.on("data", (chunk) => {
    live.buffer += chunk;
    let index;
    while ((index = live.buffer.indexOf("\n")) >= 0) {
      const line = live.buffer.slice(0, index).replace(/\r$/, "").trim();
      live.buffer = live.buffer.slice(index + 1);
      if (!line) continue;
      const next = live.waiting.shift();
      if (next) next.resolve(line);
    }
  });

  proc.stderr.on("data", (d) => {
    const text = String(d).trim();
    if (!text) return;
    /*
      Kept, not just logged.

      Without this the only thing a caller ever learns about a dead helper is
      "the synthesiser exited (1)" — and on this machine, today, the first run
      resolves `kokoro-onnx` from PyPI and loads an ONNX graph, so the plausible
      first failures are a package that will not resolve, a wheel with no build
      for CPython 3.11, and a missing espeak backend. Those are four different
      fixes wearing the same exit code, and the difference is only ever on
      stderr. The last line is on the API surface via `state.reason`; a person
      reading it should not have to go and find the server log first.
    */
    live.tail = text.slice(-200);
    // `uv` narrates itself while resolving an environment on first run, and
    // onnxruntime prints provider warnings on every start. Neither is a
    // failure, and logging them would bury the one line that is.
    if (/error|traceback/i.test(text)) {
      console.warn(`[operator] tts: ${text.slice(0, 200)}`);
    }
  });

  const die = (why) => {
    for (const w of live.waiting.splice(0)) w.reject(new Error(why));
    if (helper === live) {
      helper = null;
      helperReady = null;
      state.ready = false;
      state.reason = why;
    }
  };
  proc.on("error", (err) => die(err?.message ?? "the synthesiser failed to start"));
  proc.on("exit", (code) =>
    die(live.tail ? `the synthesiser exited (${code}): ${live.tail}` : `the synthesiser exited (${code})`),
  );

  helper = live;
  helperReady = new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("the synthesiser never became ready"));
      /*
        Tear it down, or this is permanent.

        `die` only runs when the process errors or exits, so a helper that
        starts fine and never prints READY leaves `helper` set and
        `helperReady` rejected — and every later call takes the `if (!helper)`
        branch, skips the restart, and awaits the same rejected promise. One
        slow start would mean TTS is dead until the server restarts. Clearing
        it costs a fresh model load on the next attempt, which is the point.
      */
      stopTts();
    }, READY_TIMEOUT_MS);
    live.waiting.push({
      resolve: (line) => {
        clearTimeout(timer);
        // `READY|af_alloy,af_heart,…` — the voice list comes from the pack that
        // was actually loaded, so the picker cannot offer a voice this file
        // does not contain.
        if (line.startsWith("READY")) {
          const names = line.slice(5).replace(/^\|/, "").split(",").map((v) => v.trim());
          state.voices = names.filter(Boolean);
          state.ready = true;
          state.reason = null;
          resolveReady();
        } else {
          reject(new Error(line.startsWith("ERR|") ? line.slice(4) : `unexpected: ${line}`));
        }
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    });
  });
  helperReady.catch(() => {});
  return live;
}

/**
 * The rate the helper ACTUALLY wrote, taken from the RIFF header.
 *
 * Everything about Kokoro's output format in this file came from documentation
 * rather than from a clip, and 24000 is one of the guesses. The bytes are not a
 * guess: a canonical WAV carries its own rate at offset 24, so reading it costs
 * nothing and removes one unverified number from the API. Falls back to the
 * constant only if the header is not one this can recognise — a caller that has
 * a playable WAV should never be handed an error over a field it can ignore.
 */
function rateFromWav(buf) {
  if (buf.length < 28) return SAMPLE_RATE;
  const riff = buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WAVE";
  if (!riff || buf.toString("latin1", 12, 16) !== "fmt ") return SAMPLE_RATE;
  const rate = buf.readUInt32LE(24);
  return rate > 0 ? rate : SAMPLE_RATE;
}

/**
 * Turn text into audio.
 *
 * Returns the WAV **in memory**, not a path. Deliberate: the file exists for
 * the few milliseconds it takes Python to write it and Node to read it, then it
 * is gone. Audio of Operator talking is far less sensitive than audio of him
 * talking, but the same principle from `listen.mjs` applies — nothing about a
 * conversation should accumulate in a temp directory because someone forgot to
 * write the sweep.
 *
 * @param {string} text        markdown or plain prose; markdown is stripped
 * @param {object} [opts]
 * @param {string} [opts.voice] one of `state.voices`
 * @param {number} [opts.speed] 0.5–2.0, 1 is the model's natural pace
 * @returns {Promise<{audio: Buffer, mime: string, ms: number, voice: string,
 *                    sampleRate: number, truncated: boolean, chars: number}>}
 */
export function synthesize(text, opts = {}) {
  const run = async () => {
    /*
      Text first, availability second. A reply that reduces to nothing once the
      markdown is stripped — a bare code block, a lone link — is not a TTS
      problem, and answering it with "no Kokoro model at …" sends the caller
      off installing something it did not need.
    */
    const clean = speakableText(text);
    if (!clean) throw new Error("nothing to say");
    const { text: body, truncated } = trimForSpeech(clean);

    const check = available();
    if (!check.ok) throw new Error(check.reason);

    const voice = String(opts.voice || DEFAULT_VOICE);
    // Clamped rather than validated: a speed of 12 from a mistyped setting
    // should sound wrong, not fail the request the owner is waiting on.
    const speed = Math.min(2, Math.max(0.5, Number(opts.speed ?? DEFAULT_SPEED) || 1));
    const out = join(tmpdir(), `operator-voice-${randomUUID().slice(0, 8)}.wav`);

    clearTimeout(idleTimer);
    state.synthesizing = true;
    const startedAt = Date.now();

    try {
      if (!helper) start();
      await helperReady;
      const live = helper;
      if (!live) throw new Error("the synthesiser went away");

      /*
        JSON in, because the text is arbitrary and a delimiter-separated line
        cannot survive it. The transcriber gets away with a bare path per line;
        a sentence containing a pipe, a newline or a BOM is a different problem,
        and `json.loads` on the far side is the one place it is already solved.
      */
      const request = JSON.stringify({ text: body, voice, speed, out });

      const line = await new Promise((resolveLine, reject) => {
        const timer = setTimeout(() => {
          /*
            Kill rather than wait. See SPEAK_TIMEOUT_MS: the reply for an
            abandoned request would be handed to whoever asked next, so the
            process has to go with it. It restarts lazily on the following
            call, paying the load again — the correct price for not serving
            one person's sentence to another.
          */
          const why = `synthesis timed out after ${SPEAK_TIMEOUT_MS}ms`;
          reject(new Error(why));
          stopTts();
          // After stopTts the helper is already unhooked, so `die` will not
          // record this — and a status poll would otherwise show a healthy
          // idle voice that had just failed.
          state.reason = why;
        }, SPEAK_TIMEOUT_MS);
        const settle = (fn) => (value) => {
          clearTimeout(timer);
          fn(value);
        };
        live.waiting.push({ resolve: settle(resolveLine), reject: settle(reject) });
        live.proc.stdin.write(`${request}\n`, (err) => {
          if (err) {
            clearTimeout(timer);
            reject(err);
          }
        });
      });

      if (line.startsWith("ERR|")) throw new Error(line.slice(4));
      if (!line.startsWith("OK|")) throw new Error(`the synthesiser said: ${line.slice(0, 120)}`);

      const audio = await readFile(out);
      return {
        audio,
        mime: "audio/wav",
        ms: Date.now() - startedAt,
        voice,
        sampleRate: rateFromWav(audio),
        truncated,
        chars: body.length,
      };
    } finally {
      state.synthesizing = false;
      touchIdle();
      // Always, including on failure. A half-written clip left behind is the
      // one thing the in-memory return is arranged to avoid.
      await rm(out, { force: true }).catch(() => {});
    }
  };

  // Chain onto the queue so only one synthesis is in flight, whichever device
  // asked. `catch` on the tail so one failure does not poison every request
  // after it — the queue is for ordering, not for propagating errors.
  const result = queue.then(run, run);
  queue = result.catch(() => {});
  return result;
}

/**
 * Warm the model without asking it to say anything.
 *
 * For a caller that knows a reply is coming — a job that has started streaming,
 * a wake gesture — so the load is paid during the thinking rather than added to
 * it. Resolves false rather than throwing: warming is an optimisation, and a
 * missing model must not fail whatever was actually being done.
 */
export async function warm() {
  if (!available().ok) return false;
  try {
    if (!helper) start();
    await helperReady;
    touchIdle();
    return true;
  } catch (err) {
    state.reason = String(err?.message ?? err);
    return false;
  }
}

/** Release the model. Called on idle, on a timeout, and at shutdown. */
export function stopTts() {
  clearTimeout(idleTimer);
  idleTimer = null;
  state.ready = false;
  const live = helper;
  helper = null;
  helperReady = null;
  if (!live) return;
  try {
    // QUIT first so Python can close the ONNX session cleanly; the kill is the
    // backstop for a process that is wedged and will not read its stdin.
    live.proc.stdin.write("QUIT\n", () => {});
    live.proc.kill();
  } catch {
    /* already gone */
  }
}
