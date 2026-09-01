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

/*
  Gain applied to the captured stream, in dB. Zero is off.

  Needed because a microphone level set too low is invisible from here and
  fatal to speech: a clap clears a bad level, a voice does not. 30dB is about
  31x, which lifts this machine's measured 0.0009 speech peak to roughly 0.028
  - inside the range Whisper works in.
*/
const GAIN_DB = Number(process.env.OPERATOR_LISTEN_GAIN ?? 0) || 0;

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

/*
  The running estimate of room noise.

  Module scope rather than inside the spawn closure because the endpointer
  below needs it too: "is he still talking" is the same question as "is this
  above the floor", and the floor is only meaningful relative to this room.
  Seeded low so the clap bar starts at its minimum rather than wide open.
*/
let ambient = 0.001;


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
        /*
          Software gain, because the microphone's own level is not something
          this can set.

          Measured 2026-08-31 on the owner's headset: speech peaks at 0.0009
          against a room floor of 0.0007 — barely distinguishable — while a
          clap on the SAME microphone reaches 0.352. A clap is loud enough to
          clear a badly-set input level and a voice is not, which is exactly
          why claps worked for hours while speech never did.

          Applied to the whole stream, so ambient and transients scale
          together and the clap detector's ratio-to-ambient threshold is
          unaffected. It amplifies noise as well as speech — Whisper's VAD is
          what stops that becoming invented words, and it is the reason that
          filter is not optional.
        */
        ...(GAIN_DB ? ["-af", `volume=${GAIN_DB}dB`] : []),
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

    child.stdout.on("data", (buf) => {
      /*
        Audio is flowing, so this attempt genuinely worked — clear the failure
        count. Without this `restarts` only ever climbs, and after one bad
        patch the listener would sit on 60-second retries for the rest of the
        process's life even while the microphone was working perfectly.

        Reset here rather than on spawn: ffmpeg starts happily against a
        disconnected Bluetooth device and only fails a moment later, so a
        successful spawn proves nothing. A byte of PCM does.
      */
      if (restarts) restarts = 0;
      rememberAudio(buf);
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
      /*
        Back off to a slow retry — do NOT stop.

        This used to give up permanently after eight failures, which is wrong
        for the microphone this actually runs on: a Bluetooth headset drops
        every time it idles or the owner walks away, so the listener would be
        dead within thirty seconds of him taking it off and stay dead until
        someone restarted the server. The clap gesture would then silently not
        work, which is indistinguishable from it being broken.

        The original concern was respawning a failing process every second
        forever, and a minute between attempts answers that: a device that is
        genuinely gone costs one spawn a minute, and one that comes back is
        picked up without anyone doing anything.
      */
      const giveUp = restarts > 8;
      if (giveUp) {
        state.reason = `microphone unavailable — retrying every minute (last exit ${code})`;
        if (restarts === 9) console.warn(`[operator] listen: backing off to 60s retries`);
        setTimeout(spawnOnce, 60_000);
        return;
      }
      /*
        Say so WHILE retrying, not only after giving up.

        Between the first failure and the ninth this used to report
        `listening: false, reason: null` — indistinguishable from a listener
        that was never asked to start, for up to about a minute. Anything
        reading this state then has to choose between calling a broken
        microphone idle or calling an idle one broken, and both are wrong.
      */
      state.reason = `microphone unavailable — retrying (${restarts}/8, last exit ${code})`;
      setTimeout(spawnOnce, Math.min(10_000, 500 * restarts));
    });
  };

  spawnOnce();
  return true;
}

/**
 * Record a few seconds from the same microphone and transcribe it.
 *
 * ## Why capture goes through ffmpeg rather than a speech API
 *
 * Windows' own recogniser transcribes from the *default* recording device and
 * cannot target a named one. This machine has three active microphones, so
 * "default" is a coin toss — which is what an unexplained NOSPEECH turned out
 * to be. ffmpeg is already capturing a named device two functions up, reliably,
 * so the audio problem is solved and only the transcription is new.
 *
 * ## Recorded to a file, then deleted
 *
 * Whisper wants a file rather than a stream. It goes to the OS temp directory,
 * never `data/`, and is removed as soon as it has been read — the point of the
 * whole design is that audio does not accumulate anywhere.
 *
 * @param seconds how long to record. The clap fires this, so it starts while
 *   the window is still coming forward — anything said during the transition is
 *   caught rather than clipped.
 */
export async function captureAndTranscribe(seconds = 6) {
  if (!DEVICE) throw new Error("no microphone configured (OPERATOR_LISTEN)");
  if (!state.listening) throw new Error("the listener is not running, so there is no audio to take");

  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { rm, writeFile } = await import("node:fs/promises");
  const { randomUUID } = await import("node:crypto");

  const wav = join(tmpdir(), `operator-speech-${randomUUID().slice(0, 8)}.wav`);

  /*
    Pause clap detection while recording.

    The clap that triggered this is still echoing, and the detector would
    otherwise hear it — and hear the next one — mid-capture. Same self-trigger
    problem `muteBriefly` exists for, over a longer window.
  */
  muteBriefly((seconds + 1) * 1000);

  try {
    /*
      Take the audio from the stream ALREADY OPEN, rather than starting a
      second one.

      Measured 2026-08-31: a second ffmpeg opening the same dshow device
      records digital silence — -90dB across all three microphones on this
      machine, which looked exactly like three broken microphones and was one
      held device. The clap listener owns it, by design, permanently.

      Buffering the live stream is also simply better: the recording starts
      BEFORE the clap rather than after it, so the beginning of a sentence is
      not clipped while a window comes forward. The rolling buffer is what
      makes "clap and start talking" work instead of "clap, wait, talk".
    */
    const pcm = await collectAudio(seconds);
    console.log(`[operator] capture: ${pcm.length} bytes, preRoll had ${preRoll.length} chunks / ${preRollBytes} bytes`);
    await writeFile(wav, wavFromPcm(pcm));
    /*
      Measure what was captured. An empty transcript has two very different
      causes - nothing was said, or whisper could not make it out - and only
      the peak tells them apart.
    */
    let audioPeak = 0;
    let voiced = 0;
    for (let i = 0; i + 1 < pcm.length; i += 2) {
      const v = Math.abs(pcm.readInt16LE(i)) / 32768;
      if (v > audioPeak) audioPeak = v;
      if (v > 0.015) voiced++;
    }
    const voicedPct = pcm.length ? (voiced / (pcm.length / 2)) * 100 : 0;

    const out = await transcribeFile(wav);

    if (out === "NOSPEECH") return { text: "", confidence: 0, peak: audioPeak, voicedPct };
    if (out.startsWith("ERR|")) throw new Error(out.slice(4));
    const [, confidence, ...rest] = out.split("|");
    return { text: rest.join("|"), confidence: Number(confidence) || 0, peak: audioPeak, voicedPct };
  } finally {
    // Always, including on failure — a half-recorded utterance left in temp is
    // the one thing this whole design is arranged to avoid.
    await rm(wav, { force: true }).catch(() => {});
  }
}

/* ------------------------------------------------------------------------
   The transcriber, held open.

   Measured 2026-08-31, three seconds of audio through the old spawn-per-call
   path:

       uv + python startup      1240 ms
       import faster_whisper     863 ms
       load base.en (int8)      1611 ms
       actually transcribing    1290 ms
       -------------------------------
       total                    ~5000 ms

   Three quarters of it was setup, paid again on every sentence. Holding the
   process open: 3941 ms once, then 48-235 ms per utterance. The same finding
   as ollama.mjs's keep-alive, where 21.3 of 24.4 seconds was loading weights.

   Serialised deliberately — one file in flight at a time. The protocol is a
   line in and a line out with nothing correlating them, so two overlapping
   requests would hand each caller the other's transcript. Captures are already
   one-at-a-time (`muteBriefly` covers the recording window), so a queue costs
   nothing real and removes the whole class of bug.
   ------------------------------------------------------------------------ */

const UV = process.env.OPERATOR_UV ?? `${process.env.LOCALAPPDATA ?? ""}\\hermes\\bin\\uv.exe`;
const scriptPath = (name) =>
  new URL(`./win/${name}`, import.meta.url).pathname.replace(/^\//, "");

/** The live helper: `{ proc, lines, waiting }`, or null when not started. */
let transcriber = null;
/** Resolves when the model is loaded; rejected (and cleared) if it dies. */
let transcriberReady = null;
/** Tail of the current request chain, so requests run one after another. */
let transcribeQueue = Promise.resolve();

function startTranscriber() {
  const proc = spawn(
    UV,
    [
      "run",
      "--python",
      "3.11",
      "--with",
      "faster-whisper",
      "python",
      // -u disables Python's block buffering on a pipe. WITHOUT IT this hangs
      // forever: the answer is computed in milliseconds and then sits in a
      // buffer that never flushes, which is indistinguishable from a crash.
      // The script also flushes by hand; both, because this failure mode has
      // already cost this project a session once.
      "-u",
      scriptPath("transcribe_server.py"),
    ],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
  );

  const state = { proc, waiting: [], buffer: "" };

  proc.stdout.on("data", (chunk) => {
    state.buffer += chunk;
    let index;
    while ((index = state.buffer.indexOf("\n")) >= 0) {
      const line = state.buffer.slice(0, index).replace(/\r$/, "").trim();
      state.buffer = state.buffer.slice(index + 1);
      if (!line) continue;
      const next = state.waiting.shift();
      if (next) next.resolve(line);
    }
  });

  proc.stderr.on("data", (d) => {
    const text = String(d).trim();
    // uv is chatty on first run while it resolves the environment; only
    // surface something that looks like a real failure.
    if (text && /error|traceback/i.test(text)) {
      console.warn(`[operator] transcriber: ${text.slice(0, 200)}`);
    }
  });

  const die = (why) => {
    for (const w of state.waiting.splice(0)) w.reject(new Error(why));
    if (transcriber === state) {
      transcriber = null;
      transcriberReady = null;
    }
  };
  proc.on("error", (err) => die(err?.message ?? "transcriber failed to start"));
  proc.on("exit", (code) => die(`transcriber exited (${code})`));

  transcriber = state;
  transcriberReady = new Promise((resolve, reject) => {
    // READY is printed once the model is resident. A timeout here rather than
    // waiting forever: a first run downloads the model, but an hour of silence
    // means something is wrong and the caller should hear about it.
    const timer = setTimeout(() => reject(new Error("transcriber never became ready")), 180_000);
    state.waiting.push({
      resolve: (line) => {
        clearTimeout(timer);
        if (line === "READY") resolve();
        else reject(new Error(line.startsWith("ERR|") ? line.slice(4) : `unexpected: ${line}`));
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    });
  });
  transcriberReady.catch(() => {});
  return state;
}

/**
 * One WAV to one result line, through the resident model.
 *
 * Falls back to spawning the one-shot `transcribe.py` if the persistent helper
 * cannot be started. Slower, but a broken helper should degrade voice to slow
 * rather than to broken — the one-shot path is the one that has been working
 * for weeks.
 */
function transcribeFile(wav) {
  const run = async () => {
    try {
      if (!transcriber) startTranscriber();
      await transcriberReady;
      const state = transcriber;
      if (!state) throw new Error("transcriber went away");
      return await new Promise((resolve, reject) => {
        state.waiting.push({ resolve, reject });
        state.proc.stdin.write(`${wav}\n`, (err) => {
          if (err) reject(err);
        });
      });
    } catch (err) {
      console.warn(
        `[operator] transcriber unavailable (${err?.message ?? err}) — falling back to one-shot`,
      );
      return transcribeOnce(wav);
    }
  };
  // Chain onto the queue so only one request is in flight.
  const result = transcribeQueue.then(run, run);
  transcribeQueue = result.catch(() => {});
  return result;
}

/** The original path: spawn, transcribe, exit. Kept as the fallback. */
function transcribeOnce(wav) {
  return new Promise((resolve, reject) => {
    const py = spawn(
      UV,
      ["run", "--python", "3.11", "--with", "faster-whisper", "python", scriptPath("transcribe.py"), wav],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    py.stdout.on("data", (d) => (stdout += d));
    py.stderr.on("data", (d) => (stderr += d));
    py.on("error", reject);
    py.on("exit", () => {
      const line = stdout.trim().split(/\r?\n/).pop() ?? "";
      if (line.startsWith("TEXT|") || line === "NOSPEECH" || line.startsWith("ERR|")) {
        resolve(line);
      } else {
        reject(new Error(stderr.trim().slice(-200) || "transcriber said nothing"));
      }
    });
  });
}

/*
  A rolling window of the most recent audio, so a capture can include what was
  said just BEFORE it was asked for.

  Two seconds, which is enough to catch the start of a sentence begun with the
  clap and small enough to be a few hundred KB. Trimmed on every chunk rather
  than periodically, so it cannot grow while nobody is looking.
*/
/*
  Endpointing — stop recording when he stops talking.

  Measured 2026-08-31: the capture window was a fixed 6 seconds, so a
  1.5-second question sat there recording silence for another 4.5. After the
  persistent transcriber took transcription down to ~1.3s, this became the
  single largest source of latency in the whole voice path — bigger than
  inference, routing and the model call combined.

  Speech sits far lower than a clap: the clap bar is `ambient * 12`, this is
  `ambient * 3`, floored so a silent room cannot drift down until noise counts
  as talking.
*/
const SPEECH_MULTIPLE = Number(process.env.OPERATOR_LISTEN_SPEECH_MULTIPLE ?? 3) || 3;
const SPEECH_FLOOR = 0.004;
/** Quiet for this long after speech means the sentence is over. */
const SILENCE_MS = Number(process.env.OPERATOR_LISTEN_SILENCE_MS ?? 900) || 900;

const PRE_ROLL_MS = 2000;
const PRE_ROLL_BYTES = (RATE * 2 * PRE_ROLL_MS) / 1000;
let preRoll = [];
let preRollBytes = 0;
/** Set while a capture is collecting; the audio handler feeds it. */
let collector = null;

function rememberAudio(chunk) {
  if (collector) {
    collector.chunks.push(chunk);
    endpoint(collector, chunk);
  }
  preRoll.push(chunk);
  preRollBytes += chunk.length;
  while (preRollBytes > PRE_ROLL_BYTES && preRoll.length > 1) {
    preRollBytes -= preRoll.shift().length;
  }
}

/**
 * Decide whether the sentence has ended.
 *
 * Exported so it can be driven with synthetic audio. It is the one piece of
 * this file that can be checked without a working microphone, and the machine
 * it runs on frequently does not have one.
 *
 * **Can only ever shorten a capture, never truncate one.** If speech is never
 * clearly detected — which is the honest outcome on a poor microphone, where
 * the owner's voice measured 0.0009 against a 0.0007 room floor — this does
 * nothing at all and the full window runs, exactly as before. Bailing early on
 * "no speech yet" would cut off someone talking quietly, which is a far worse
 * failure than waiting an extra two seconds.
 */
export function endpoint(active, chunk) {
  if (active.done) return;

  let peak = 0;
  for (let i = 0; i + 1 < chunk.length; i += 2) {
    const v = Math.abs(chunk.readInt16LE(i)) / 32768;
    if (v > peak) peak = v;
  }

  const bar = Math.max(SPEECH_FLOOR, ambient * SPEECH_MULTIPLE);
  const now = Date.now();

  if (peak >= bar) {
    active.heardSpeech = true;
    active.quietSince = 0;
    return;
  }
  // Silence only counts once he has actually said something. Before that it is
  // just the gap between the clap and the first word.
  if (!active.heardSpeech) return;
  if (!active.quietSince) {
    active.quietSince = now;
    return;
  }
  if (now - active.quietSince >= SILENCE_MS) active.finish("silence");
}

/**
 * The pre-roll plus new audio, up to `maxSeconds`, ending early once he stops
 * talking.
 */
function collectAudio(maxSeconds) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const active = {
      chunks: [...preRoll],
      heardSpeech: false,
      quietSince: 0,
      done: false,
      finish: null,
    };

    const settle = (why) => {
      if (active.done) return;
      active.done = true;
      clearTimeout(timer);
      collector = null;
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.log(`[operator] capture ended after ${seconds}s (${why})`);
      resolve(Buffer.concat(active.chunks));
    };
    active.finish = settle;

    // The hard cap, and the whole behaviour when endpointing stays silent.
    const timer = setTimeout(() => settle("full window"), maxSeconds * 1000);
    collector = active;
  });
}

/** Wrap raw mono 16-bit PCM in the 44-byte header whisper expects. */
function wavFromPcm(pcm) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // format: PCM
  header.writeUInt16LE(1, 22); // channels
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Transcribe audio recorded somewhere else — specifically, a phone.
 *
 * ## Why this exists
 *
 * The phone surface reads its own microphone for the level meter, which is
 * local and instant. But the WORDS were still coming from the microphone
 * attached to this PC, so the owner could watch his phone's mic move the core
 * while Whisper listened to a completely different room. His question — "mic
 * works on phone so why isnt the thing working" — is answered by that gap.
 *
 * ## Why not the browser's own speech recognition
 *
 * `SpeechRecognition` exists on iOS and would have been a one-line answer. It
 * sends the audio to APPLE for recognition. That is an external host under
 * CLAUDE.md's approval rule, it is the owner's voice rather than a prompt, and
 * he has approved no such thing — so it is not an option, however convenient.
 *
 * This keeps the whole path on his hardware: the phone records, posts to his
 * own server over the tailnet, and the same resident Whisper that the clap
 * gesture uses does the work.
 *
 * @param buffer  the recorded audio, in whatever container the browser chose
 * @returns the same `{text, confidence}` shape as `captureAndTranscribe`
 */
export async function transcribeUpload(buffer) {
  if (!buffer?.length) throw new Error("no audio");

  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { rm, writeFile } = await import("node:fs/promises");
  const { randomUUID } = await import("node:crypto");

  const id = randomUUID().slice(0, 8);
  const incoming = join(tmpdir(), `operator-upload-${id}`);
  const wav = join(tmpdir(), `operator-upload-${id}.wav`);

  try {
    await writeFile(incoming, buffer);

    /*
      Browsers record WebM/Opus (or MP4/AAC on Safari); Whisper wants 16kHz
      mono PCM. ffmpeg is already a dependency of this file and reads both
      without being told which — the container is in the bytes.
    */
    const ffmpeg = findFfmpeg();
    if (!ffmpeg) throw new Error("ffmpeg not found — set OPERATOR_FFMPEG");

    await new Promise((resolve, reject) => {
      const proc = spawn(
        ffmpeg,
        ["-hide_banner", "-loglevel", "error", "-i", incoming, "-ac", "1", "-ar", String(RATE), "-y", wav],
        { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
      );
      let err = "";
      proc.stderr.on("data", (d) => (err += d));
      proc.on("error", reject);
      proc.on("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(err.trim().slice(-200) || `ffmpeg exited ${code}`)),
      );
    });

    const out = await transcribeFile(wav);
    if (out === "NOSPEECH") return { text: "", confidence: 0 };
    if (out.startsWith("ERR|")) throw new Error(out.slice(4));
    const [, confidence, ...rest] = out.split("|");
    return { text: rest.join("|"), confidence: Number(confidence) || 0 };
  } finally {
    // Both, always. Audio of the owner speaking must not accumulate in temp.
    await rm(incoming, { force: true }).catch(() => {});
    await rm(wav, { force: true }).catch(() => {});
  }
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
