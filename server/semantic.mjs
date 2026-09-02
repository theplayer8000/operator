// Did the work actually do what was asked?
//
// ## The layer above the gates, and deliberately a separate file
//
// `verify.mjs` runs checks that cannot be wrong: `node --check`, `tsc`, a
// build. Something either compiles or it does not. That certainty is the whole
// value of that file, and putting a language model inside it would quietly
// spend it — a caller reading `status: "passed"` should not have to wonder
// which kind of passing it means.
//
// So this is the second layer, named for what it is: an opinion. It reads the
// request and the diff and says whether they look like the same thing.
//
// ## Why the local model, with no tools
//
// It runs on every completed turn, so it has to be free — Gemini's free tier is
// 20 requests a day and Claude is money. It also sees the owner's source diff,
// which is a different class of disclosure from a prompt: routine per-job
// upload of his code to anyone is not covered by any approval he has given, and
// should not be. `ollama.ask()` talks to 127.0.0.1 and takes no tools, because
// a checker that can write to his data is a second actor rather than a check.
//
// ## What a MISMATCH does: nothing, on purpose
//
// It is recorded and shown. It does not fail the job, does not change
// `status`, and does not trigger a repair turn. `jobs.mjs` already states why
// verification must never be able to break a job — turning a red build into a
// failed job makes "cancelled" and "the check disagreed" look identical in the
// tab strip. That reasoning is stronger here, not weaker: this layer is a 3B
// model's guess, and an automatic action on a guess spends money the owner did
// not agree to. He remains the one who decides.
//
// Off unless `OPERATOR_SEMANTIC_VERIFY=1`. It should be watched for a while
// before it is trusted enough to be on by default.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ask, isAvailable, installedModels } from "./ollama.mjs";

const run = promisify(execFile);

/*
  Which model checks the work — and why this is a switch rather than a decision.

  The case for moving it off the local model is strong and is ADR 0016's whole
  argument: the 3B that fits in 4GB of VRAM scores two out of three here and has
  hallucinated agreement outright. AI Router offers a 27B and a 284B at a flat
  rate, so the check could be genuinely good at no marginal cost.

  **And it is off by default, because of what this particular caller sends.**

  This layer sees the owner's SOURCE DIFF, on every completed turn, automatically.
  ADR 0016 approved "the prompt and whatever job context is attached" — the same
  class as the Gemini approval. A routine per-job upload of his code is not that,
  and the header above says so in as many words. It is his decision to make
  knowingly, not one to be inherited from a nearby approval.

  `OPERATOR_SEMANTIC_PROVIDER=airouter` turns it on. Local remains the default,
  and remains the right default for anyone who has not thought about it.
*/
const PROVIDER = (process.env.OPERATOR_SEMANTIC_PROVIDER ?? "local").trim().toLowerCase();

/**
 * Ask whichever model is configured. Same shape as `ollama.ask`.
 *
 * Deliberately narrow: no tools on either path. A checker that can write to his
 * data is a second actor rather than a check, and that is true regardless of
 * which model is behind it.
 */
async function askModel({ prompt, model, system, maxTokens }) {
  if (PROVIDER === "airouter") {
    const { runTurn, DEFAULT_MODEL } = await import("./airouter.mjs");
    let text = "";
    await runTurn({
      prompt,
      model: model || DEFAULT_MODEL,
      appendSystemPrompt: system,
      onEvent: (type, data) => {
        if (type === "text") text += data.text;
      },
    });
    return text.trim();
  }
  return ask({ prompt, model, system, maxTokens });
}

export const enabled = process.env.OPERATOR_SEMANTIC_VERIFY === "1";

/** Overridable, because the model that fits will change with the hardware. */
const MODEL = process.env.OPERATOR_VERIFY_MODEL ?? "";

/*
  Every input is capped, and truncation is reported rather than hidden.

  `num_ctx` is 4096 on this machine. An unbounded diff either silently
  truncates mid-hunk — so the model reviews half a change and confidently
  judges it — or blows the window entirely. Silent truncation is the dangerous
  one, because the answer still looks like an answer.
*/
const MAX_REQUEST = 600;
const MAX_STAT = 700;
const MAX_DIFF = 1200;
const MAX_CLAIM = 600;

/** A verdict this layer can produce. `unsure` is a real answer, not a failure. */
const VERDICTS = new Set(["matches", "mismatch", "unsure"]);

const NEWLINE = /\r?\n/;
/** File headers, index hashes, hunk positions — envelope, not content. */
const DIFF_META =
  /^(diff --git|index |--- |\+\+\+ |@@|new file|deleted file|similarity|rename |Binary files)/;

async function git(cwd, args, cap) {
  try {
    const { stdout } = await run("git", args, { cwd, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
    return String(stdout).slice(0, cap);
  } catch {
    return "";
  }
}

/**
 * Raw `git diff` down to just the changed lines.
 *
 * Measured 2026-08-31, and this is the difference between the layer working
 * and not. Fed real `-U0` output — `@@` hunk headers, `diff --git`, index
 * lines, `+++`/`---` pairs — qwen2.5:3b returned "MISMATCH" with no
 * explanation for BOTH a matching and a mismatching request: useless, and
 * confidently so. Fed the same change as a plain list of added and removed
 * lines, it answered "MATCHES" with a correct sentence.
 *
 * The model was never the problem; the diff format was. A 3B model spends its
 * attention parsing the envelope instead of reading the change.
 */
function condense(raw, cap) {
  const lines = [];
  let length = 0;
  for (const line of raw.split(NEWLINE)) {
    if (DIFF_META.test(line)) continue;
    if (!/^[+-]/.test(line)) continue;
    const trimmed = line.trimEnd();
    // A bare "+" or "-" is whitespace churn and tells the model nothing.
    if (trimmed.length <= 1) continue;
    const clipped = trimmed.slice(0, 160);
    if (length + clipped.length > cap) break;
    lines.push(clipped);
    length += clipped.length + 1;
  }
  return lines.join("\n");
}

/**
 * Review one completed turn.
 *
 * @param cwd      the worktree the work happened in
 * @param request  what the owner actually asked for
 * @param claimed  what the worker said it did (its own text back)
 * @returns `{verdict, note, model, truncated, ms}` — or `null` when it did not
 *          run at all, which is the normal case and must never be shown as a
 *          failure.
 */
export async function reviewWork({ cwd, request, claimed = "" }) {
  if (!enabled) return null;
  if (!cwd || !request?.trim()) return null;

  const startedAt = Date.now();

  /*
    Is the configured model reachable, asked of whichever one it is.

    This checked Ollama unconditionally, which would refuse to run on a machine
    that had deliberately pointed the check at the router and had no local model
    at all — a guard written for one provider silently vetoing another.

    "Not reachable" is not a verdict either way. Returning `unsure` here would be
    indistinguishable from the model having looked and hesitated, which is the
    one thing this must never blur.
  */
  let model = MODEL;
  if (PROVIDER === "airouter") {
    const { configured, DEFAULT_MODEL } = await import("./airouter.mjs");
    if (!configured) return null;
    model = model || DEFAULT_MODEL;
  } else {
    if (!(await isAvailable())) return null;
    model = model || (await installedModels())[0];
  }
  if (!model) return null;

  const stat = await git(cwd, ["diff", "--stat", "HEAD"], MAX_STAT);
  /*
    Read generously, then condense. The useful lines are a small fraction of
    raw diff output, so capping before filtering would throw away content and
    keep envelope — the exact thing that broke this.
  */
  const rawDiff = await git(cwd, ["diff", "-U0", "HEAD"], MAX_DIFF * 8);
  if (!stat.trim() && !rawDiff.trim()) return null; // nothing changed to review

  const diff = condense(rawDiff, MAX_DIFF);
  // Honest about partial input: either git's output was clipped, or condensing
  // at twice the cap would have yielded more than we are showing.
  const truncated =
    rawDiff.length >= MAX_DIFF * 8 || condense(rawDiff, MAX_DIFF * 2).length > diff.length;

  const prompt = [
    "A developer was asked to do something. Below is the request, then the",
    "lines they actually added and removed. Decide whether the changes",
    "plausibly do what was asked.",
    "",
    "REQUEST:",
    request.slice(0, MAX_REQUEST),
    "",
    ...(claimed.trim() ? ["THEY SAY THEY DID:", claimed.slice(0, MAX_CLAIM), ""] : []),
    "FILES CHANGED:",
    stat.trim() || "(none reported)",
    "",
    "CHANGED LINES" + (truncated ? " (a sample of a larger change)" : "") + ":",
    diff || "(none)",
    "",
    /*
      Reason FIRST, label LAST. This ordering is not a style choice.

      Measured 2026-08-31: asked for the verdict on line one, qwen2.5:3b
      answered MATCHES for a request about changing a dashboard colour while
      its own next sentence read "the sample lines do not appear to be related
      to changing the dashboard background". The reasoning was right and the
      label was wrong, because a 3B model asked to commit to a label before
      thinking is guessing and then rationalising.
    */
    "Do not assume the changes match. Read the lines and check.",
    "If the files and lines shown have nothing to do with the request, that is",
    "a MISMATCH even if the request sounds reasonable.",
    "First write one short sentence describing what the changed lines actually",
    "do, WITHOUT referring to the request.",
    "Then, on the very last line, write exactly one word: MATCHES, MISMATCH,",
    "or UNSURE.",
    /*
      Truncation must NOT be a reason to answer UNSURE.

      The first version said "(partial - judge only what you can see)" and
      "Say UNSURE if you genuinely cannot tell" together, which reliably
      produced UNSURE for any change big enough to be worth checking — the
      prompt talking itself out of an answer. Measured: the identical diff
      returned MATCHES with a correct sentence once those two lines stopped
      pulling against each other.

      Judging a representative sample is the normal case here, not a
      degraded one.
    */
    "The lines above may be a sample of a larger change; judge whether they are",
    "consistent with the request rather than whether they are complete.",
  ].join("\n");

  try {
    const raw = await askModel({
      prompt,
      model,
      system:
        "You review code changes against the request that produced them. You are terse and you do not speculate.",
      maxTokens: 120,
    });

    /*
      Parsed strictly, the way routing.mjs parses its classifier: anything the
      grammar does not recognise becomes `unsure` rather than a guess. A
      verifier that invents a verdict when confused is worse than one that
      admits it, because the badge is only worth reading if it is honest.
    */
    const parts = raw.split(NEWLINE).map((l) => l.trim()).filter(Boolean);
    // The verdict is the LAST line, because that is where reasoning ends up.
    const last = parts.at(-1) ?? "";
    const word = last.toLowerCase().replace(/[^a-z]/g, "");
    const verdict = VERDICTS.has(word) ? word : "unsure";
    const note = parts.slice(0, -1).join(" ").trim().slice(0, 300);

    return {
      verdict,
      note: note || (verdict === "unsure" ? "The model gave no usable answer." : ""),
      model,
      truncated,
      ms: Date.now() - startedAt,
    };
  } catch (err) {
    // A model that timed out or died is not a verdict either.
    console.warn(`[operator] semantic check failed: ${err?.message ?? err}`);
    return null;
  }
}
