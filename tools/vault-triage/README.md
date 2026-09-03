# Vault Triage

Decide which of your ChatGPT conversations are worth becoming vault notes,
before any of them do.

Open `index.html` by double-clicking it. Drag the export folder in. Nothing is
uploaded, nothing is fetched, and the page works with the network off — the
only thing it reads is what you drop on it.

## Why this exists

The importer (`scripts/knowledge-import.mjs`) turns documents into notes, and it
is good at that. It has no opinion about whether a document is worth importing —
and a chat export is mostly not. Measured on the real export: **288
conversations, 77 of which have one user message or fewer.** Those are questions
you asked once and never returned to.

Importing everything would bury the notes that matter under a few hundred that
do not, and the vault's whole value is that its contents were worth writing
down. This is the step that decides.

## Using it

| | |
|---|---|
| `k` | keep — becomes a vault note |
| `t` | trash — never imported |
| `u` | unsure — decide later |
| `↑` `↓` | move through the list |
| `space` | tick a chat for a bulk action |
| `/` | jump to search |
| `r` | surprise me — a random unreviewed chat |
| `z` | undo the last action, including a bulk one |

Marking with the keyboard advances to the next chat, so a run of decisions is
`k k t t k` without touching anything else.

**Bulk actions apply to your ticked selection, or to everything currently
shown if you have ticked nothing.** That is the fast path: set the preset to
`thin — 1 exchange or fewer`, check the list looks like throwaways, and press
trash once. Undo is one keystroke if it does not.

### The presets are where the time is saved

- **thin** — 1 exchange or fewer. 77 of 288 in this export.
- **starred** / **archived** — what you already flagged inside ChatGPT.
- **substantial** — 10+ messages. The ones most likely to hold something.

### Dropping the export

Drag the whole export folder in, or just the `conversations-*.json` files.

If both JSON and `chat.html` are present the JSON is used and the HTML ignored
— they hold the same conversations, so loading both would double every chat,
and the JSON additionally carries dates, roles, starred/archived flags and the
branch structure that the rendered HTML has already discarded.

`.dat` files are the attachments. They are not read; triage does not need them,
and there are several hundred megabytes of them.

## What persists, and what does not

**Decisions persist. Conversations do not.**

localStorage is about 5MB and this export is ~17MB of JSON, so the
conversations cannot be cached there. A tool that appeared to remember your work
and then lost it at chat 300 would be worse than one that never claimed to.

So each session you re-drop the export, and your decisions rejoin it by
ChatGPT's own `conversation_id`. That id is stable across exports, so a fresh
export next month keeps everything you have already decided.

Export the manifest when you finish a session. It is the durable copy, and the
only one if your browser refuses localStorage on `file://` — some do.

## The manifest

`manifest.json` is the contract with the import step. One file, written by the
`export manifest.json` button.

```json
{
  "schema": "vault-triage/1",
  "generatedAt": "2026-09-03T04:20:00.000Z",
  "totals": {
    "chats": 288, "keep": 41, "trash": 190, "unsure": 12, "unreviewed": 45
  },
  "chats": [
    {
      "id": "68f2c4a1-...",
      "title": "Server Build Recommendations",
      "firstDate": "2026-02-11T19:04:12.000Z",
      "lastDate":  "2026-02-19T08:55:40.000Z",
      "messageCount": 700,
      "userMessageCount": 341,
      "characters": 412903,
      "sourceFile": "conversations-001.json",
      "starred": false,
      "archived": false,
      "decision": "keep",
      "note": "the EPYC spec lives in here",
      "decidedAt": "2026-09-03T04:11:02.000Z"
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `id` | ChatGPT's `conversation_id`. Stable across exports — this is the join key |
| `firstDate` / `lastDate` | ISO 8601. From the conversation's own timestamps |
| `messageCount` | User and assistant turns. **Excludes** the model's internal reasoning (`thoughts`, `reasoning_recap`), which would otherwise make a two-question chat look substantial |
| `userMessageCount` | How many times *you* spoke. The best single signal of whether a chat went anywhere |
| `characters` | Conversation text only, no attachments. Used for the "text done" figure |
| `decision` | `keep` · `trash` · `unsure` · `unreviewed` |
| `note` | Free text, yours. Carried through so the importer can use it as a hint |
| `grewSinceDecision` | How many messages longer the chat is now than when you judged it. `0` normally |

### Re-exporting, and decisions that go stale

Decisions key on `conversation_id`, so dropping a **newer** export keeps
everything you already decided and leaves only the new chats unreviewed. That
is the point, and it means triaging a stale export today is not wasted work.

One thing it cannot know on its own: a conversation you judged may have
**continued** since. Trash a three-message chat, carry it on for another forty,
re-drop next month's export, and the old verdict silently still applies to
something that is no longer the same conversation.

So a decision records how long the chat was when it was made. Anything that has
grown since is badged in the list, counted in the header, and reachable with the
`grew since you decided` preset. Nothing is undone automatically — it is asking
for a second look, not overruling you.

**The importer should read `decision === "keep"` and nothing else.**
`unreviewed` is not a decision and must not be treated as one — that is the
difference between importing what you chose and importing what you had not got
to yet.

## What it deliberately does not do

**It does not import anything.** It writes a manifest and stops. Triage and
import are separate so that a bad import can be re-run against the same
decisions without triaging 288 chats again.

**It does not edit or delete your export.** Every file is opened read-only. If
this tool is wrong, nothing has been lost.

**It has no dependencies and no build step.** One HTML file, plain CSS and plain
JS, so it can be read and changed without a toolchain — and so it still opens in
five years when whatever bundler was fashionable this month does not.
