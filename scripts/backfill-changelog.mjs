// Backfill the Updates changelog for days that shipped work but were never logged.
//
// The shipping-velocity chart on Statistics reads `updates.entries` by date, so
// a day nobody logged reads as a day nothing happened. 31 July carried twenty
// commits and shows as a gap.
//
// ## Marked as reconstructed, deliberately
//
// These are derived from git after the fact, not written at the time, and the
// entry says so. A backfilled entry that looks contemporaneous is a small lie
// in the one record that is supposed to be the honest history — `CURRENT.md`
// says where the work is, the changelog says what happened, and it is never
// rewritten. Adding to it is fine; disguising the addition is not.
//
// One entry per DAY, not per commit, per the rule in CLAUDE.md.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const BASE = process.env.OPERATOR_URL ?? "http://127.0.0.1:5174";
const WRITE = process.argv.includes("--write");

const state = await (await fetch(`${BASE}/api/state`)).json();
const entries = state?.state?.["updates.entries"] ?? [];
const logged = new Set(entries.filter((e) => e.date).map((e) => e.date));

// Which days have commits.
const { stdout } = await run("git", ["log", "--since=2026-07-28", "--format=%ad", "--date=short"]);
const days = [...new Set(stdout.trim().split("\n"))].filter(Boolean).sort();

const gaps = days.filter((d) => !logged.has(d));
if (gaps.length === 0) {
  console.log("No gaps — every day with commits already has an entry.");
  process.exit(0);
}

console.log(`${gaps.length} day(s) with commits and no changelog entry\n`);

const additions = [];
for (const day of gaps) {
  const { stdout: subjects } = await run("git", [
    "log",
    `--since=${day} 00:00`,
    `--until=${day} 23:59`,
    "--format=%s",
  ]);
  const lines = subjects.trim().split("\n").filter(Boolean);
  if (lines.length === 0) continue;

  /*
    Feature and fix commits describe what shipped; docs and chore commits are
    the paperwork around it. Both are real work, but a reader asking "what
    happened that day" wants the first kind — so those lead, and the rest is
    counted rather than listed.
  */
  const substantive = lines.filter((l) => /^(feat|fix|refactor|perf|revert)/.test(l));
  const rest = lines.length - substantive.length;
  const shown = (substantive.length ? substantive : lines).slice(0, 4);

  const detail =
    shown.map((l) => l.replace(/^\w+(\([^)]*\))?:\s*/, "")).join(" · ") +
    (rest > 0 ? ` · plus ${rest} docs/chore commit${rest === 1 ? "" : "s"}` : "") +
    `\n\nReconstructed from git on 2026-09-03 — this day shipped ${lines.length} commit${lines.length === 1 ? "" : "s"} and was never logged at the time.`;

  additions.push({
    id: `backfill-${day}`,
    title: `${lines.length} commit${lines.length === 1 ? "" : "s"} — reconstructed from git`,
    detail,
    date: day,
    status: "done",
  });
  console.log(`${day}  ${lines.length} commits`);
  console.log(`  ${shown[0]?.slice(0, 90) ?? ""}`);
}

if (!WRITE) {
  console.log(`\n${additions.length} entries would be added — pass --write`);
  process.exit(0);
}

// Newest first, matching how the log is stored and rendered.
const merged = [...entries, ...additions].sort((a, b) =>
  String(b.date ?? "").localeCompare(String(a.date ?? "")),
);

const res = await fetch(`${BASE}/api/state/${encodeURIComponent("updates.entries")}`, {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ value: merged }),
});
console.log(res.ok ? `\n${additions.length} entries written` : `\nfailed: ${res.status}`);
