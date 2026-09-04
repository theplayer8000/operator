// Video generation, through Runway.
//
// ## Two actions, not a worker turn
//
// A generation takes minutes. Every other outbound call here answers inside one
// request; this one does not, so modelling it as a `runTurn` would mean a job
// sitting on a slot doing nothing while `OPERATOR_MAX_CONCURRENT` is 3. It is
// two capability actions instead — one starts a task and returns an id, one
// asks whether that id is finished. The waiting happens wherever the caller
// wants it to, including not at all.
//
// ## What leaves the machine
//
// A text prompt, and — for image-to-video — **an image the owner supplies**.
// That image is why CLAUDE.md gives this its own approval row rather than
// treating it as another prompt-shaped call: a picture is a different category
// of disclosure from text he typed, which is the same line ADR 0016 draws
// around audio of him.
//
// **Nothing here reads his disk to find an image.** The caller passes a URL or
// a data URI and that is what is sent. An action that took a path would be a
// way to upload any file on the machine through a video API.
//
// ## The honest caveat
//
// The endpoint, the version header and the model names below are written from
// documentation rather than from a call that succeeded — no key existed when
// this was written. They are all env-overridable for exactly that reason, and
// the errors say when the shape looks wrong rather than reporting a generic
// failure. **The first real generation is the test**; if it 404s or complains
// about a version, the fix is a variable, not a rewrite.
//
// No dependencies.

const env = (name) => (process.env[name] ?? "").replace(/^﻿/, "").trim();

const API_KEY = env("RUNWAY_API_KEY");
const BASE_URL = env("RUNWAY_BASE_URL") || "https://api.dev.runwayml.com/v1";
/*
  Runway versions its API by date header rather than by path. Wrong or missing,
  it refuses the request — so it is named here and overridable, because the
  value that is current will change and a hardcoded one would fail months later
  in a way nobody would connect to this line.
*/
const API_VERSION = env("RUNWAY_API_VERSION") || "2024-11-06";
const MODEL = env("RUNWAY_MODEL") || "gen4_turbo";

export const configured = Boolean(API_KEY);

const TIMEOUT_MS = 30_000;

export class RunwayError extends Error {}

function requireKey() {
  if (!API_KEY) {
    throw new RunwayError(
      "RUNWAY_API_KEY is not set. Set it with the secret_set action — never by typing setx in the terminal, which writes the value to the server log — then restart.",
    );
  }
}

async function call(path, { method = "GET", body } = {}) {
  requireKey();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "content-type": "application/json",
        "X-Runway-Version": API_VERSION,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });

    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // Left null; the error below quotes the raw text, which is more useful
      // than "unexpected token" when a proxy or a 404 page came back instead.
    }

    if (res.status === 401 || res.status === 403) {
      throw new RunwayError("Runway refused the key. Check RUNWAY_API_KEY and that the account has credits.");
    }
    if (res.status === 404) {
      throw new RunwayError(
        `Runway returned 404 for ${path}. The endpoint or the version header is probably wrong — both are env-overridable (RUNWAY_BASE_URL, RUNWAY_API_VERSION). Check their current docs rather than editing this file.`,
      );
    }
    if (res.status === 429) {
      throw new RunwayError("Runway is rate-limiting or out of credits — it did not say which. Try later.");
    }
    if (!res.ok) {
      const detail = parsed?.error ?? parsed?.message ?? String(text).slice(0, 200);
      throw new RunwayError(`Runway returned ${res.status}: ${detail}`);
    }
    return parsed;
  } catch (err) {
    if (err instanceof RunwayError) throw err;
    throw new RunwayError(
      controller.signal.aborted
        ? `Runway did not answer within ${TIMEOUT_MS / 1000}s — the request may still have been accepted, so check runway_status before starting another`
        : `could not reach Runway: ${err?.message ?? err}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Start a generation. Returns a task id; it will not be finished yet.
 *
 * `image` is a URL or a data URI the CALLER supplies. Nothing reads the disk.
 */
export async function generate({ prompt, image, model, duration = 5, ratio } = {}) {
  const text = String(prompt ?? "").trim();
  if (!text) throw new RunwayError("prompt is required — describe the video you want");
  if (!image) {
    /*
      Refused rather than quietly starting a text-only generation.

      The image-to-video endpoint is the one this was approved for, and the
      approval row names the image as the thing that leaves the machine. A
      silent fallback to a different endpoint would be a different disclosure
      than the one recorded, which is exactly the drift the approvals table
      exists to prevent.
    */
    throw new RunwayError(
      "image is required. This is image-to-video: pass a URL or a data URI. Nothing here reads a file from disk — an action that did would be a way to upload anything on the machine through a video API.",
    );
  }
  const src = String(image);
  if (!/^https?:\/\//i.test(src) && !/^data:image\//i.test(src)) {
    throw new RunwayError("image must be an http(s) URL or a data:image/… URI");
  }

  const task = await call("/image_to_video", {
    method: "POST",
    body: {
      promptImage: src,
      promptText: text.slice(0, 1000),
      model: model || MODEL,
      duration: Math.max(1, Math.min(Number(duration) || 5, 10)),
      ...(ratio ? { ratio: String(ratio) } : {}),
    },
  });

  const id = task?.id ?? task?.taskId ?? null;
  if (!id) {
    throw new RunwayError(
      `Runway accepted the request but returned no task id — the response shape may have changed: ${JSON.stringify(task).slice(0, 200)}`,
    );
  }
  return {
    taskId: id,
    status: task?.status ?? "PENDING",
    model: model || MODEL,
    note: "Generation takes minutes. Call runway_status with this taskId rather than waiting.",
  };
}

/** Ask whether a generation has finished, and where the result is. */
export async function status({ taskId } = {}) {
  const id = String(taskId ?? "").trim();
  if (!id) throw new RunwayError("taskId is required — it comes back from runway_generate");

  const task = await call(`/tasks/${encodeURIComponent(id)}`);
  const state = task?.status ?? "UNKNOWN";
  const output = Array.isArray(task?.output) ? task.output : task?.output ? [task.output] : [];

  return {
    taskId: id,
    status: state,
    done: state === "SUCCEEDED" || state === "FAILED",
    ...(output.length ? { output } : {}),
    ...(task?.failure || task?.failureCode
      ? { failure: task.failure ?? task.failureCode }
      : {}),
    /*
      Said plainly, because a URL that expires is a URL somebody will paste
      into a note and find broken later.
    */
    ...(state === "SUCCEEDED"
      ? { note: "Runway's output URLs expire — download it rather than storing the link." }
      : {}),
  };
}
