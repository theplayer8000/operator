# Operator — a brief for a model that has never seen this repo

Written 2026-09-01. Self-contained on purpose: `docs/handoffs/CURRENT.md` is the
working note and assumes `CLAUDE.md` has been read. This one assumes nothing, so
it can be pasted into a fresh conversation with any model.

If you are reading this in the repo, the live state is in `CURRENT.md` and the
rules are in `CLAUDE.md`. This file exists to be copied OUT.

---

## What Operator is

A personal productivity system and AI control plane, self-hosted, built and used
by one person. It runs on his Windows PC and is reached from his phone over
Tailscale. Tasks contribute to missions; missions contribute to a long-term
roadmap.

It is also increasingly the thing he talks to — the goal is stated plainly as
"like JARVIS": speak to it, it acts, it knows him.

## The one hard rule

**Nothing reaches a host he does not control without his explicit, named,
advance approval — every time, one host at a time.**

Not inferred from a similar integration already existing, not bundled into a
larger feature. Currently approved, and this list is the whole set:

| What | Host |
|---|---|
| Google Fonts | `fonts.googleapis.com` |
| Claude service status | `status.claude.com` |
| Anthropic, via the Claude Agent SDK | Anthropic's API |
| Google Gemini | `generativelanguage.googleapis.com` — prompts and job context only |
| ntfy.sh **as a relay only** | a message ID and a topic hash; never title or body |

Everything else was refused, and the reasoning matters more than the list:

- **iOS `SpeechRecognition`** — would have been one line, sends audio to Apple.
- **Deepgram, ElevenLabs** — hosted; his voice would go to a company.
- **Gemini Live** — fast and tempting, but the Gemini approval covers *prompts*.
  Streaming continuous microphone audio is a different class and needs its own.
- **Honcho** and hosted memory — personal context is the most sensitive data here.
- **A friend's homelab GPU** — a remote Ollama is an external host.

API keys live in environment variables only. Never in the JSON store (it is
plaintext, served over the tailnet), never in git, and **never typed into
Operator's own terminal**, which logs every command — a key was reissued once
for exactly that.

## Stack and shape

- **Frontend**: React 18, TypeScript, Vite, Tailwind, React Router, Recharts,
  lucide-react. Nothing else. No state library — hooks and local state only.
- **`server/`**: plain Node, no dependencies, **except** the Claude Agent SDK in
  `runner.mjs`. A new server dependency requires a written decision record.
  External capabilities are spawned binaries: ffmpeg, headless Edge, Python for
  Whisper.
- **Storage**: one JSON file (`data/operator.json`) held in server memory,
  served over an authenticated API. One namespace per feature, one hook per
  namespace, one folder, one page.

## Architecture worth knowing

- **Jobs, not requests.** A conversation is a job with an append-only event log
  that outlives any HTTP request. Polling, not streaming — an iPhone constraint.
- **Provider boundary.** `providers.mjs` sits between jobs and whichever worker
  runs a turn. Three exist: Claude Code (full tools), Gemini (capability actions
  only), and a local Ollama model (free, no quota).
- **A router picks the worker** by rules first, a model only when genuinely
  ambiguous, falling back to the capable worker when uncertain.
- **The capability layer.** ~39 named, validated actions over Operator's own
  data (`gym_toggle_exercise`, `mission_set_progress`, `calendar_create_event`).
  Called by a CLI so every worker uses them identically. **An AI changes data
  through these, never by editing source.**
- **Three permission tiers**: identity gets you the app; capability actions need
  no arming; the terminal and starting jobs need a named device *and* an armed
  terminal. Publishing and deleting are denied outright and never become
  questions.
- **Worktree isolation.** The in-app agent writes to a separate git checkout on
  branch `agent`, so its work is invisible until merged.

## Where the voice layer actually is

Working and measured, phone and desktop:

- A **named** microphone chosen from a list, not the OS default.
- Level read locally at frame rate — no network in the loop.
- A segment ends **2s after speech stops**, not on a timer.
- Typing rejected by **voiced fraction**, not loudness: a keystroke peaks as
  loud as a syllable but lasts a fraction as long.
- Audio posts to his own server; resident Whisper transcribes in **~282ms warm**.
- Words land in the chat, or send straight through if auto-send is on.
- A live mission map with a reactive core: idle, hearing, speaking, thinking.
- Notifications reach his phone at priority 4+ (lower arrives silently).

**Why it is still not JARVIS — four gaps, none of them transcription:**

1. **It hears, then hands over text.** "I did push day" should tick the gym off.
   The action exists. The model turning speech into an *action* does not.
2. **It does not know him.** Every store key is feature data. No memory of the
   person. A new thread is a stranger.
3. **It cannot answer back when busy.** A second request queues silently. It
   should say "that will wait behind the build" or "I will give that to Gemini".
4. **The voice is a system voice.** Kokoro is the chosen local fix.

## Hardware, measured not argued

- **15.7 GB RAM, seen as low as 0.45 GB free.** A cold Whisper load took **68s**
  under that pressure and **282ms** warm — a 200x difference caused by paging.
  32 GB is the best-value upgrade.
- **4 GB VRAM** (RX 6400, unsupported by ROCm). Caps the local model at 3B,
  which is why semantic verification scores 2 of 3. 12–16 GB is what makes local
  AI capable rather than merely resident.
- CPU (i5-10400) is not the bottleneck.

## Traps that have each cost real time

- **`node` on PATH is shadowed** by a broken binary one directory above the
  repo. It fails *silently* — `node --check` exits 0 having checked nothing. Use
  the full path to the real binary.
- **Restarts lie.** `POST /api/restart` and `schtasks /End` both fail to reload
  environment variables while the supervisor process survives. Only a genuine
  cold start re-reads them; the banner in `serve.log` is the only honest signal.
- **`tsc` and `vite build` never read a `.mjs` file**, so a clean build says
  nothing about a server change.
- **Whisper hallucinates on silence** — "Thanks for watching!", "Mm-hmm" — with
  high confidence. It once created about twenty real, billed jobs.
- **PowerShell 5.1 writes a BOM**, which has broken a path and a topic name.
- **Never `git add -A`.** Two sessions share the working tree.

## How to be useful here

Measure before designing. Several of the worst bugs were confident guesses:
a clap threshold guessed twice against a microphone that could not reach it, a
"which model" problem that was really a routing problem, and a drag that broke
because it held an object rebuilt on every data sync.

State what is verified and what is not. Say when something was not tested and
why. Do not present a reasoned number as a measured one.
