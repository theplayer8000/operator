// Runs the triage page's OWN parsing functions against the real export.
//
// The functions are extracted from index.html rather than copied, so this
// cannot drift from what the page actually does — a copy would pass while the
// page failed, which is the worst possible outcome for a test.

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

// Point this at your own export folder.
const DIR =
  "D:/Framework/0026e7976a19e5ef7d2eab17dcbf59e4bb8afa3ea9e4c05dc677d729d9f5b78d-2026-06-17-15-12-19-3d3a2bb21ff54f8fa244c9d58d66f436";

const html = await readFile("D:/Projects/operator/tools/vault-triage/index.html", "utf8");

// Pull the four functions the parse path depends on straight out of the page.
const grab = (name) => {
  const start = html.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`could not find ${name} in index.html`);
  let depth = 0;
  let started = false;
  for (let i = start; i < html.length; i++) {
    if (html[i] === "{") { depth++; started = true; }
    else if (html[i] === "}") {
      depth--;
      if (started && depth === 0) return html.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
};

const src = [
  "const CONTENT_KINDS = { text: true, multimodal_text: true };",
  "const ASIDE_KINDS = { thoughts: true, reasoning_recap: true };",
  grab("isConversation"),
  grab("linearise"),
  grab("partsToText"),
  grab("parseConversation"),
  grab("extractConversations"),
  "return { parseConversation, extractConversations };",
].join("\n\n");

const { parseConversation, extractConversations } = new Function(src)();

// --- run it over the real export -------------------------------------------
// Every JSON in the folder, exactly as a dropped folder would give it — this
// is the case that produced 322 phantom chats.
const files = (await readdir(DIR)).filter(
  (f) => f.endsWith(".json") && !/manifest|asset_file_names/i.test(f),
);
const chats = [];
for (const f of files) {
  const convos = extractConversations(f, await readFile(join(DIR, f), "utf8"));
  for (const c of convos) chats.push(parseConversation(c, f));
  console.log(`${f}: ${convos.length} conversations`);
}

const ids = new Set(chats.map((c) => c.id));
const noTitle = chats.filter((c) => !c.title || c.title === "Untitled").length;
const noDate = chats.filter((c) => !c.created).length;
const empty = chats.filter((c) => c.msgCount === 0).length;
const thin = chats.filter((c) => c.userCount <= 1).length;
const counts = chats.map((c) => c.msgCount).sort((a, b) => a - b);

console.log(`\nparsed        ${chats.length} chats`);
console.log(`unique ids    ${ids.size}  ${ids.size === chats.length ? "OK" : "COLLISION"}`);
console.log(`no title      ${noTitle}`);
console.log(`no date       ${noDate}`);
console.log(`zero messages ${empty}`);
console.log(`thin (<=1 user msg) ${thin}`);
console.log(`messages: min ${counts[0]} median ${counts[counts.length >> 1]} max ${counts.at(-1)}`);
console.log(`total characters ${(chats.reduce((n, c) => n + c.bytes, 0) / 1e6).toFixed(1)}M`);

// The branch-walk is the part most likely to be subtly wrong, so check one big
// chat reads as an alternating conversation rather than a jumble.
const big = chats.slice().sort((a, b) => b.msgCount - a.msgCount)[0];
console.log(`\nlargest: "${big.title}" — ${big.msgCount} messages`);
console.log("first 6 roles:", big.messages.filter((m) => !m.aside).slice(0, 6).map((m) => m.role).join(" -> "));
const real = big.messages.filter((m) => !m.aside);
let alternating = 0;
for (let i = 1; i < real.length; i++) if (real[i].role !== real[i - 1].role) alternating++;
console.log(`alternating turns: ${alternating}/${real.length - 1}`);
console.log(`first user line: ${JSON.stringify(big.firstUser.slice(0, 90))}`);

// And that attachments were named rather than dropped.
const withAttach = chats.filter((c) => c.messages.some((m) => /【/.test(m.text))).length;
console.log(`\nchats containing an attachment placeholder: ${withAttach}`);
