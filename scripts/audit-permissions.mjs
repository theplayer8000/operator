// Audit OPERATOR'S OWN permission profile, not just Claude Code's.
//
//   node scripts/audit-permissions.mjs           structural checks only, no deps
//   node scripts/audit-permissions.mjs --deep    also run AgentShield over it
//
// ## Why this exists
//
// `security-scan` (ECC/AgentShield) reads `.claude/` — Claude Code's config for
// the agent BUILDING Operator. It never sees `ALLOWED_TOOLS` and `DENIED_TOOLS`
// in `server/jobs.mjs`, which is the list that decides what a job running
// INSIDE Operator may do without asking.
//
// That is the more important of the two. The `.claude/` list governs a session
// at a desk with a person watching; Operator's list governs an agent acting on
// a spoken sentence while its owner is at work.
//
// Found the same day the gap was noticed (2026-09-01): three of the four
// full-path `operator-action` rules contained **literal newlines**, because they
// were written as plain quoted JS strings — `\P` drops its backslash and `\n` in
// `\nodejs` becomes a line break. They could never match. They had been added to
// fix "two permission prompts for one command", looked right in review, and did
// nothing for weeks.
//
// ## The failure mode this is built around
//
// **A permission rule fails silently.** A rule that matches nothing is
// indistinguishable, from the outside, from a rule that was never written — the
// only symptom is being asked for permission slightly more often, which reads
// as normal. Nothing throws. Nothing logs. `node --check` passes.
//
// So the checks below are mostly not about security policy. They are about
// whether each rule is capable of matching anything at all.
//
// ## Two layers, deliberately
//
// The structural checks are Operator's own and need no dependency, so they can
// run in CI or on a machine with no network. `--deep` additionally reshapes the
// lists into the `.claude/settings.json` form AgentShield expects and runs it,
// which brings ~40 policy rules for free rather than reimplementing them badly.
//
// No dependencies of its own. See docs/ecc-catalogue.md.

import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const { ALLOWED_TOOLS, DENIED_TOOLS } = await import("../server/jobs.mjs");

const findings = [];
const note = (severity, rule, what, why) =>
  findings.push({ severity, rule, what, why });

/*
  1. Control characters — the bug that started this.

  Any of these means the string was mangled between the source and here. `\n`
  is the one that actually happened (from `\nodejs`), but `\t` from a `\temp`
  path and `\b`, `\f`, `\v` are all reachable the same way.
*/
const CONTROL = /[\x00-\x1f\x7f]/;
for (const rule of [...ALLOWED_TOOLS, ...DENIED_TOOLS]) {
  if (CONTROL.test(rule)) {
    note(
      "critical",
      rule,
      "contains a control character",
      "The source string was mangled by JS escape processing — almost certainly a " +
        "Windows path written in single quotes. This rule cannot match anything. " +
        "Escape the backslashes: '\\\\Program Files\\\\nodejs\\\\node.exe'.",
    );
  }
}

/*
  2. Unbalanced parentheses.

  Both lists are built with `.join(",")` and immediately `.split(",")` so that
  OPERATOR_JOB_ALLOW can override them from the environment. That round trip is
  lossy: a rule CONTAINING a comma is silently torn into two fragments, each of
  which matches nothing. `Bash(git commit -m "a, b")` would do it.

  Unbalanced brackets is the cheap way to detect the halves.
*/
for (const [name, list] of [["allow", ALLOWED_TOOLS], ["deny", DENIED_TOOLS]]) {
  for (const rule of list) {
    const open = (rule.match(/\(/g) ?? []).length;
    const close = (rule.match(/\)/g) ?? []).length;
    if (open !== close) {
      note(
        "critical",
        rule,
        `unbalanced parentheses in the ${name} list`,
        "Probably half of a rule that contained a comma. Both lists round-trip " +
          "through join(',')/split(','), so a comma inside a rule splits it. " +
          "Rewrite the rule without a comma, or change the separator.",
      );
    }
  }
}

/*
  3. Rules that are structurally incapable of matching.

  A `Tool(...)` rule with an empty body, or stray whitespace at either end that
  the split did not trim.
*/
for (const rule of [...ALLOWED_TOOLS, ...DENIED_TOOLS]) {
  if (rule !== rule.trim()) {
    note("high", rule, "has leading or trailing whitespace", "It will not match.");
  }
  if (/\(\s*\)$/.test(rule)) {
    note("high", rule, "has an empty parameter body", "Matches only the literal empty command.");
  }
}

/*
  4. An allow rule that a deny rule overrides.

  Not always a bug — deny SHOULD win, that is the point. It is worth reporting
  because it usually means someone added an allow expecting it to work, and the
  symptom is a tool that mysteriously never runs.
*/
const denyPrefixes = DENIED_TOOLS.map((d) => d.replace(/:\*$/, "").replace(/\*$/, ""));
for (const rule of ALLOWED_TOOLS) {
  const shadowed = denyPrefixes.find((d) => d.length > 6 && rule.startsWith(d));
  if (shadowed) {
    note(
      "medium",
      rule,
      `shadowed by the deny rule "${shadowed}"`,
      "Deny wins, so this allow never applies. Either the allow is dead or the " +
        "deny is broader than intended.",
    );
  }
}

/*
  5. Bare tool names for tools that write — REPORTED, NOT CONDEMNED.

  A bare name auto-approves that tool everywhere, before the permission callback
  is consulted. For `Write` and `Edit` that is deliberate here and must not be
  "fixed": CLAUDE.md records that the scoped form `Write(**)` was MEASURED to
  match nothing, which made every single write a prompt.

  So this is stated as an accepted risk rather than a defect. Someone acting on
  it as though it were a bug would reintroduce a change already tried and
  reverted — which is exactly the failure this whole file is meant to prevent,
  one level up.

  It is still worth printing. The scope of what the agent can silently write is
  the largest single thing in this profile, and a reader should meet it
  deliberately rather than by scrolling past a list.
*/
const WRITES = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "PowerShell"]);
/** Measured to be unavoidable — see the comment above ALLOWED_TOOLS. */
const KNOWINGLY_BARE = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
for (const rule of ALLOWED_TOOLS) {
  if (rule.includes("(") || !WRITES.has(rule)) continue;
  if (KNOWINGLY_BARE.has(rule)) {
    note(
      "accepted",
      rule,
      "writes anywhere without asking — deliberate, do not narrow",
      "The scoped form (Write(**)) was measured to match nothing, making every " +
        "write a prompt. Recorded in CLAUDE.md. Listed so the blast radius is " +
        "visible, not because it is wrong.",
    );
  } else {
    note(
      "high",
      rule,
      "is a bare tool name for a tool that executes",
      "A bare name auto-approves everywhere and skips the callback, so ADR 0012's " +
        "ask-on-the-phone flow never runs for it. Unlike Write/Edit there is no " +
        "measurement saying this one has to be bare.",
    );
  }
}

// ---------------------------------------------------------------- report

/*
  "accepted" sorts LAST and is not a failure.

  A known, measured, deliberate trade-off printed alongside real defects would
  train someone to skim the list, and a list that gets skimmed catches nothing.
*/
const RANK = { critical: 0, high: 1, medium: 2, low: 3, accepted: 4 };
findings.sort((a, b) => RANK[a.severity] - RANK[b.severity]);

console.log(`Operator's job permission profile`);
console.log(`  ${ALLOWED_TOOLS.length} allow rules, ${DENIED_TOOLS.length} deny rules\n`);

const problems = findings.filter((f) => f.severity !== "accepted");
const accepted = findings.filter((f) => f.severity === "accepted");

if (problems.length === 0) {
  console.log("No structural problems. Every rule can match something.\n");
}
for (const f of problems) {
  console.log(`  [${f.severity.toUpperCase()}] ${f.what}`);
  console.log(`    rule: ${JSON.stringify(f.rule)}`);
  console.log(`    ${f.why}\n`);
}
if (problems.length) console.log(`${problems.length} problem(s).\n`);

if (accepted.length) {
  console.log("Accepted by decision — listed so the blast radius stays visible:");
  for (const f of accepted) console.log(`  ${f.rule.padEnd(14)} ${f.what}`);
}

if (!process.argv.includes("--deep")) {
  console.log("\nRun with --deep to also check policy with AgentShield.");
  process.exit(problems.some((f) => f.severity === "critical") ? 1 : 0);
}

/*
  Reshape, do not reimplement.

  AgentShield has ~40 policy rules — interpreter access, env dumping, missing
  denials, delete grants. Writing those again here would be forty chances to get
  one subtly wrong. Operator's lists are already in Claude Code's rule syntax,
  so the only thing missing is the file shape it expects.

  Written to a temp directory and removed afterwards: this is a view of the
  profile, not a second copy of it that could drift.
*/
const dir = join(tmpdir(), `operator-permission-audit-${process.pid}`, ".claude");
mkdirSync(dir, { recursive: true });
writeFileSync(
  join(dir, "settings.json"),
  JSON.stringify({ permissions: { allow: ALLOWED_TOOLS, deny: DENIED_TOOLS } }, null, 2),
);

console.log("\n--- AgentShield, over Operator's own profile ---\n");
/*
  `cmd.exe /c`, not `shell: true`, and not bare "npx.cmd".

  Node cannot spawn a Windows `.cmd` directly — it fails `EINVAL`, which is the
  trap CLAUDE.md names. The tempting fix is `shell: true`, and CLAUDE.md
  explicitly rejects it for `terminal.mjs` because it turns an argv list into a
  string a caller could inject into.

  That reasoning is about untrusted input, and there is none here: every
  argument below is a literal in this file, and `dir` is a path this process
  just built from `tmpdir()` and its own pid. Naming the interpreter explicitly
  keeps the argv discipline anyway, so the habit survives even where the risk
  does not.
*/
const win = process.platform === "win32";
const res = spawnSync(
  win ? "cmd.exe" : "npx",
  win
    ? ["/c", "npx", "-y", "ecc-agentshield", "scan", "--path", dir]
    : ["-y", "ecc-agentshield", "scan", "--path", dir],
  { stdio: "inherit" },
);
rmSync(join(dir, ".."), { recursive: true, force: true });

if (res.error) {
  console.log(`Could not run AgentShield: ${res.error.message}`);
  console.log("The structural checks above ran regardless — they need nothing.");
}
process.exit(problems.some((f) => f.severity === "critical") ? 1 : 0);
