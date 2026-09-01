// What the intent router heard and did not understand.
//
//   node scripts/intent-misses.mjs            group and count them
//   node scripts/intent-misses.mjs --explain  ask the local model to name the clusters
//   node scripts/intent-misses.mjs --notify   send a short digest to his phone
//
// ## Why this exists
//
// `server/intent.mjs` runs on every transcript and executes nothing — it logs
// what it WOULD have done. That is deliberate: every phrase in its test suite
// was invented, none came from the owner actually speaking, and shipping a rule
// set on invented evidence is the guessed-clap-threshold mistake that cost two
// evenings against a microphone which could not physically produce the number
// being tested for.
//
// The misses are the evidence. A hit only proves a rule fires; a miss is a real
// sentence falling through, and reading those is the entire reason it runs
// before it is trusted.
//
// ## Why the model does not write the rules
//
// He asked whether a local model could watch this and update the router. The
// grouping half of that idea is good and is what this does. The writing half is
// not: `intent.mjs` decides whether speech MODIFIES HIS DATA, a bad pattern is
// a false positive is an unwanted write, and qwen2.5:3b scores two out of three
// on semantic verification and has hallucinated agreement outright. A model
// that cannot reliably say whether a diff matches a request should not be
// authoring the rules that decide whether to change a gym log.
//
// It is also source code, and the capability layer exists precisely so that a
// model changes DATA rather than code.
//
// So the split is: the model reads two hundred lines and says "these fourteen
// are all about the calendar", which is summarising and it is good at. A person
// writes the rule, which is judgement and stays where judgement belongs.
//
// No dependencies. Reads the log, nothing else.

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOGS = [join(ROOT, "data", "serve.log"), join(ROOT, "data", "serve.log.1")];

const MISS = /\[operator\] intent: no match — "(.+)"$/;
const HIT = /\[operator\] intent \(WOULD run, not running\): (\S+)/;

/**
 * Two transcripts are "the same question" if their meaningful words overlap.
 *
 * Deliberately crude — a shared-word ratio, not embeddings. The point is to
 * stop him reading the same sentence forty times, not to be clever: "whats on
 * my calendar" and "what's on the calendar today" are obviously one thing to a
 * person, and a person is who reads this.
 */
const NOISE = new Set([
  "the", "a", "an", "my", "me", "i", "is", "it", "to", "of", "on", "in", "for",
  "and", "do", "did", "you", "can", "whats", "what", "s", "please", "operator",
]);

function words(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !NOISE.has(w));
}

function similar(a, b) {
  const A = new Set(words(a));
  const B = new Set(words(b));
  if (A.size === 0 || B.size === 0) return false;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared += 1;
  return shared / Math.min(A.size, B.size) >= 0.6;
}

async function main() {
  const explain = process.argv.includes("--explain");
  const wantNotify = process.argv.includes("--notify");

  const misses = [];
  const hits = new Map();
  for (const path of LOGS) {
    if (!existsSync(path)) continue;
    const text = await readFile(path, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const miss = line.match(MISS);
      if (miss) {
        misses.push(miss[1]);
        continue;
      }
      const hit = line.match(HIT);
      if (hit) hits.set(hit[1], (hits.get(hit[1]) ?? 0) + 1);
    }
  }

  const total = misses.length + [...hits.values()].reduce((a, b) => a + b, 0);
  if (total === 0) {
    console.log("Nothing recorded yet. The router logs on every transcript, so");
    console.log("this fills up as he talks to it.");
    return;
  }

  console.log(`Heard ${total} things. Matched ${total - misses.length}, missed ${misses.length}.`);
  if (hits.size) {
    console.log("\nWhat it matched:");
    for (const [action, n] of [...hits.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(4)}  ${action}`);
    }
  }

  if (misses.length === 0) {
    console.log("\nNothing fell through.");
    return;
  }

  // Group by rough similarity, largest first.
  const groups = [];
  for (const text of misses) {
    const home = groups.find((g) => similar(g[0], text));
    if (home) home.push(text);
    else groups.push([text]);
  }
  groups.sort((a, b) => b.length - a.length);

  console.log("\nWhat fell through, most common first:");
  for (const group of groups) {
    console.log(`\n  ${String(group.length).padStart(3)}x  ${JSON.stringify(group[0])}`);
    for (const variant of [...new Set(group.slice(1))].slice(0, 4)) {
      console.log(`        also  ${JSON.stringify(variant)}`);
    }
  }

  if (!explain) {
    console.log("\nRun with --explain to have the local model name each cluster.");
    return;
  }

  /*
    The model's job, and only this: look at a group of sentences and say what
    they are about. Summarising, which a 3B model does well, rather than
    authoring a rule, which it does not.
  */
  const { ask, isAvailable, installedModels } = await import("../server/ollama.mjs");
  if (!(await isAvailable())) {
    console.log("\nOllama is not running, so there is nothing to explain with.");
    return;
  }
  const model = (await installedModels())[0];
  if (!model) {
    console.log("\nNo local model installed.");
    return;
  }

  console.log(`\nAsking ${model} what each cluster is about...\n`);
  for (const group of groups.slice(0, 8)) {
    const sample = [...new Set(group)].slice(0, 6).map((t) => `- ${t}`).join("\n");
    let answer = "";
    try {
      answer = await ask({
        prompt:
          `These are things someone said to a personal assistant that it did not understand:\n\n${sample}\n\n` +
          `In ONE short sentence, what are they asking it to do? If they are not asking for anything, say "not a request".`,
        model,
        system: "You summarise in one short sentence. You never speculate beyond what is written.",
        maxTokens: 60,
      });
    } catch (err) {
      answer = `(model failed: ${err?.message ?? err})`;
    }
    console.log(`  ${String(group.length).padStart(3)}x  ${answer.split("\n")[0].trim()}`);
    console.log(`        e.g. ${JSON.stringify(group[0])}`);
  }

  console.log("\nThese are suggestions to READ, not rules to apply. A pattern here");
  console.log("decides whether speech changes his data, so it is written by hand.");
}

main().catch((err) => {
  console.error(String(err?.message ?? err));
  process.exit(1);
});
