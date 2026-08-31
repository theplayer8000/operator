// Compile the window helper.
//
//   node scripts/build-win.mjs
//
// Builds `server/win/OperatorWin.cs` into `OperatorWin.exe` with the C#
// compiler that ships with Windows — `csc.exe` in the .NET Framework
// directory. No SDK, no package, no dependency, the same bargain
// `server/render.mjs` struck with Edge.
//
// ## Why this exists rather than doing the work in PowerShell
//
// The summon spawned PowerShell and compiled its P/Invoke declarations with
// `Add-Type` on every call: ~320ms to start the shell and ~450ms to compile,
// before a single Win32 call happened, on work that takes microseconds.
// Compiling once turns that into ~100ms including process start.
//
// A long-lived PowerShell was tried first and abandoned: `powershell
// -Command -` buffers stdin until EOF rather than acting as a REPL, so no
// framing over its stdin can work. A spawned exe also needs no lifecycle
// management, no request queue and no fallback path.
//
// ## The exe is NOT committed
//
// `dist/` and `node_modules/` are not in the repo and neither is a compiled
// binary — a build artefact in version control is a thing that silently goes
// stale against the source next to it. This is one command, and the action
// says to run it when the exe is missing.

import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "server", "win", "OperatorWin.cs");
const OUT = join(ROOT, "server", "win", "OperatorWin.exe");

/*
  Both architectures, oldest last. The path is stable across Windows versions
  because the .NET Framework 4 runtime is a permanent part of the OS — it is
  the one compiler that can be relied on to be present without installing
  anything.
*/
const CSC_CANDIDATES = [
  process.env.OPERATOR_CSC,
  "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe",
  "C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe",
].filter(Boolean);

/** The GAC path for System.Speech, whose version directory varies by machine. */
function findSpeechAssembly() {
  if (process.env.OPERATOR_SPEECH_DLL) return process.env.OPERATOR_SPEECH_DLL;
  const gac = "C:\\Windows\\Microsoft.NET\\assembly\\GAC_MSIL\\System.Speech";
  if (!existsSync(gac)) return null;
  for (const dir of readdirSync(gac)) {
    const candidate = join(gac, dir, "System.Speech.dll");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function main() {
  if (!existsSync(SRC)) throw new Error(`missing source: ${SRC}`);

  const csc = CSC_CANDIDATES.find((p) => existsSync(p));
  if (!csc) {
    throw new Error(
      "no C# compiler found. Expected csc.exe in the .NET Framework directory; " +
        "set OPERATOR_CSC to point at one.",
    );
  }

  /*
    System.Speech is not referenced by default, and `csc` will not find it by
    name: it lives in the GAC rather than beside the compiler, so the reference
    has to be a full path. Located rather than hardcoded because the version
    directory carries a build number that differs between machines.
  */
  const speech = findSpeechAssembly();
  const args = ["/nologo", "/target:exe", "/platform:x64", "/optimize+"];
  if (speech) args.push(`/reference:${speech}`);
  else {
    console.warn(
      "System.Speech.dll not found — building without it. `listen` will not work; `summon` will.",
    );
  }
  args.push(`/out:${OUT}`, SRC);

  await run(csc, args, { windowsHide: true });

  if (!existsSync(OUT)) throw new Error("compiler reported success but produced no exe");
  console.log(`built ${OUT}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
