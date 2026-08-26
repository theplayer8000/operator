// Restart an app Operator hosts, and wait until it is answering.
//
//   node scripts/app.mjs list
//   node scripts/app.mjs status darams-crm
//   node scripts/app.mjs restart darams-crm
//
// Replaces the five steps this was hand-rolled from a dozen times in one
// session: stop the task, confirm it actually stopped, start it, poll until it
// answers, show the log tail when it does not.
//
// Only apps listed in the OPERATOR_APPS environment variable exist here, and
// only their own recorded commands can run. There is no argument that turns
// this into "run something else" — see server/apps.mjs for why the registry is
// environment-only rather than a file.
//
// Standalone like backup.mjs and render.mjs: it imports the module rather than
// calling the API, so restarting an app does not depend on Operator's own
// storage server being healthy — which is exactly when you need it most.

import { listApps, appStatus, restartApp } from "../server/apps.mjs";

const [command, name] = process.argv.slice(2);

function usage() {
  console.log(
    [
      "Usage:",
      "  node scripts/app.mjs list",
      "  node scripts/app.mjs status  <name>",
      "  node scripts/app.mjs restart <name>",
      "",
      "Apps come from the OPERATOR_APPS environment variable, set at the desk.",
    ].join("\n"),
  );
}

async function main() {
  if (!command || command === "list" || command === "--help" || command === "-h") {
    if (command === "--help" || command === "-h" || !command) usage();
    const apps = listApps();
    if (apps.length === 0) {
      console.log("\nNo apps configured. Set OPERATOR_APPS — see server/apps.mjs for the format.");
      return;
    }
    console.log("");
    for (const app of apps) {
      const notes = [app.health ?? "no health URL", app.hasStop ? null : "no stop command", app.hasLog ? null : "no log"]
        .filter(Boolean)
        .join(", ");
      console.log(`${app.name}\n  ${notes}\n`);
    }
    return;
  }

  if (command === "status") {
    if (!name) throw new Error("status needs an app name");
    const result = await appStatus(name);
    const state = result.up === null ? "unknown (no health URL)" : result.up ? `up (${result.status})` : "not answering";
    console.log(`${result.name}: ${state}`);
    if (result.up === false) process.exitCode = 1;
    return;
  }

  if (command === "restart") {
    if (!name) throw new Error("restart needs an app name");
    const result = await restartApp(name);
    for (const step of result.steps) {
      console.log(`${step.ok ? "ok  " : "FAIL"} ${step.step}${step.detail ? ` — ${step.detail}` : ""}`);
    }
    console.log(`\n${result.summary}`);
    if (result.log) console.log(`\n--- log tail ---\n${result.log}`);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  usage();
  throw new Error(`unknown command: ${command}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
