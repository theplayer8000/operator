// Render an HTML or SVG file to a PNG, and print where it landed.
//
//   node scripts/render.mjs docs/some-page.html
//   node scripts/render.mjs board.svg --width 900 --height 1200
//   node scripts/render.mjs http://localhost:5173/missions --width 390 --height 844
//
// Then **Read the PNG it prints** — that is the point of the whole thing. A
// worker can generate a page and then look at what it actually produced,
// instead of asking a person whether it came out right.
//
// ## Read these directly, do not render them
//
// PDFs and images already work with the Read tool — it takes a `pages` range
// for PDFs and shows images visually. Rendering them would be a slower route to
// the same picture, so this refuses and says so.
//
// ## Standalone on purpose
//
// It imports server/render.mjs rather than calling the API, the same way
// scripts/backup.mjs does: nothing here touches Operator's data, so there is no
// reason for it to stop working when the storage server is down.

import { renderToPng, findBrowser } from "../server/render.mjs";

const argv = process.argv.slice(2);

function usage() {
  console.log(
    [
      "Usage: node scripts/render.mjs <file.html|file.svg|loopback-url> [options]",
      "",
      "  --width  <px>   viewport width  (default 1280)",
      "  --height <px>   viewport height (default 900)",
      "  --wait   <ms>   settle time for layout and webfonts (default 1200)",
      "",
      "Only the viewport is captured — there is no full-page mode, so make",
      "--height tall enough for what you need to see.",
      "",
      "A narrow --width is a narrow DESKTOP browser, not a phone: this ignores",
      "<meta viewport>, which mobile Safari honours. Check the real device",
      "before believing a responsive bug you only saw here.",
    ].join("\n"),
  );
}

function parse(args) {
  const opts = {};
  let target = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--width" || arg === "--height" || arg === "--wait") {
      const value = Number(args[++i]);
      if (!Number.isFinite(value)) throw new Error(`${arg} needs a number`);
      opts[arg.slice(2)] = value;
    } else if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else if (target === null) {
      target = arg;
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }
  return { target, opts };
}

async function main() {
  if (argv.length === 0) {
    usage();
    const browser = findBrowser();
    console.log(browser ? `\nBrowser: ${browser}` : "\nNo Chromium browser found — set OPERATOR_RENDER_BROWSER.");
    process.exit(1);
  }

  const { target, opts } = parse(argv);
  if (!target) throw new Error("a file or loopback URL is required");

  const result = await renderToPng(target, opts);
  console.log(result.path);
  console.error(`rendered ${result.source} at ${result.width}×${result.height} — ${result.bytes} bytes`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
