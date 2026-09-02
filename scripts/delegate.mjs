#!/usr/bin/env node
// Hand one piece of work down to a cheaper model. See server/delegate.mjs.
//
//   node scripts/delegate.mjs "<task>" [--file P]... [--worker W] [--model M] [--json]
//
// A CLI rather than an SDK tool, for the same reason `operator-action.mjs` is
// one: every worker calls it identically, and adding a native tool means adding
// zod, which needs an ADR. This one is for the worker holding the job — the
// dispatcher — and deliberately not exposed to delegated workers themselves.
//
// Examples:
//
//   node scripts/delegate.mjs "List every storage key this file reads or writes." \
//     --file src/hooks/useMissionBoard.ts
//
//   node scripts/delegate.mjs "Summarise what changed and why, in five bullets." \
//     --file /tmp/diff.patch --worker airouter
//
// Prints the answer on stdout and a one-line receipt (worker, model, ms,
// characters attached) on stderr, so piping the answer somewhere keeps it clean
// while the receipt still says who did the work and how long it took.

import { delegate, available } from "../server/delegate.mjs";

function usage(message) {
  if (message) console.error(`${message}\n`);
  console.error(
    [
      'Usage: node scripts/delegate.mjs "<task>" [options]',
      "",
      "  --file <path>     attach a file's contents (repeatable, project files only)",
      "  --worker <id>     " + (available().join(" | ") || "none configured"),
      "  --model <id>      override the worker's default model",
      "  --json            print the full result as JSON instead of the answer",
      "",
      "The sub-task gets no tools and cannot change data — it reads and answers.",
    ].join("\n"),
  );
  process.exit(message ? 2 : 0);
}

const argv = process.argv.slice(2);
if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") usage();

const files = [];
let task = "";
let worker;
let model;
let asJson = false;

for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === "--file" || arg === "-f") files.push(argv[(i += 1)]);
  else if (arg === "--worker" || arg === "-w") worker = argv[(i += 1)];
  else if (arg === "--model" || arg === "-m") model = argv[(i += 1)];
  else if (arg === "--json") asJson = true;
  else if (arg.startsWith("-")) usage(`Unknown option: ${arg}`);
  // Everything else joins the task, so an unquoted sentence still works.
  else task = task ? `${task} ${arg}` : arg;
}

if (!task.trim()) usage("Give it a task to do.");
if (files.some((f) => !f)) usage("--file needs a path after it.");

try {
  const result = await delegate({ task, files, worker, model });

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(result.text);
    const chars = result.attached.reduce((n, f) => n + f.chars, 0);
    const attached = result.attached.length
      ? `, ${result.attached.length} file(s), ${chars} chars${result.truncated ? " (TRUNCATED)" : ""}`
      : "";
    console.error(
      `[delegated to ${result.worker}/${result.model ?? "default"} in ${result.ms}ms${attached}]`,
    );
  }
} catch (err) {
  console.error(String(err?.message ?? err));
  process.exit(1);
}
