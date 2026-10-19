# Architecture

The components of the tool, how they find and talk to each other, and how a
pairing session starts and ends. The agent-facing contract is in
[PROTOCOL.md](PROTOCOL.md); the programmer-facing design is in
[DESIGN.md](DESIGN.md).

Status: **draft**.

## Components

```
┌──────────────────┐  stdio (MCP)  ┌────────────┐  WebSocket, 127.0.0.1  ┌─────────────────────────────┐
│  agent harness   │ ────────────▶ │  pair-mcp  │ ─────────────────────▶ │  VS Code extension          │
│  (Claude Code,   │               │  (relay)   │     + auth token       │                             │
│   Codex, …)      │               └────────────┘                        │   core                      │
└──────────────────┘                                                     │     │                       │
                                                                         │   VS Code adapter           │
                                                                         │     │                       │
                                                                         │   narration panel (webview) │
                                                                         └─────────────────────────────┘
```

- **`pair-mcp`** is the MCP server the harness launches over stdio. It holds the
  tool schemas, the server instructions, and the `start` prompt, forwards
  every tool call to the extension, and renders the extension's structured
  reports as the text the agent reads. It has no session state of its own.
- **The core** is an editor-agnostic TypeScript library, running inside the
  extension: sessions, the batch queue, the playback scheduler, place
  resolution, cursor tracking, the event log, and report assembly. It has no
  editor dependencies, so it can be tested against a fake editor.
- **The VS Code adapter** is a thin layer over the VS Code API: apply edits with
  undo stops, report document changes, render decorations, scroll, save. It
  tells the agent's edits apart from the programmer's by tracking the document
  versions its own edits produce. A change landing within 300 ms right where
  its last edit ended, and not an undo or a save's, is another extension
  answering its typing (auto-closing quotes, format on type): it undoes that
  before its next edit, so it never reaches the core.
- **The narration panel** is a webview. It talks to the extension via
  `postMessage`.
- **Starting an agent** is as thin as it looks: the panel's Start button
  types the chosen agent's command into a terminal — an open one only if
  shell integration says it is free and already standing in the workspace,
  else a new one there — after setting the pair server up in that agent
  if it isn't. The
  extension hosts no agent; each harness stays its own app and reaches the
  editor through `pair-mcp`, so nothing about the protocol changes for any
  of them.

### Why a relay

Every harness supports stdio MCP servers, and a stdio config is static: "run
this command". If the extension served MCP over HTTP directly, the harness
would need a URL whose port changes with every VS Code window. The relay keeps
the harness config fixed and resolves which editor to talk to at runtime.

### Why the core runs inside the extension

It's simpler, and playback timing stays next to the editor. The core could
later become a separate process with thin editor clients (like a language
server with document sync), which may be needed for Zed. That move wouldn't
change the protocol.

## Discovery and connection

**Each VS Code window registers itself.** On activation, the extension starts a
WebSocket server on a random port bound to `127.0.0.1`, and writes a discovery
file:

```jsonc
// ~/.ai-pair/windows/<pid>.json   (mode 0600)
{
  "pid": 41234,
  "workspaceFolders": ["/Users/me/projects/todo-app"],
  "port": 53817,
  "token": "…",               // random, per window
  "protocolVersion": 1,
  "lastFocused": 1758700000   // updated when the window gains focus
}
```

The file is removed on deactivation.

**The relay finds its window lazily**, when a session starts, not at launch. The
editor may be opened after the harness. To find the window it:

1. Reads all discovery files and drops stale ones (the process is gone).
2. Finds the agent's working directory: the first of these that a window's
   workspace folder contains. Harnesses don't all start MCP servers in the
   project (Codex's app and IDE extension start them in `/` or in their own
   install folder), so the relay's own working directory comes last:
   - the `cwd` the agent passes to `start`,
   - the harness's roots, if it supports MCP roots,
   - the relay's working directory.
3. Picks the window whose workspace folder contains it (the longest match). On
   a tie, it picks the most recently focused.
4. Connects and authenticates with the token and protocol version.

If no window matches, `start` fails with a clear message: "Open
`/Users/me/projects/todo-app` in VS Code with the extension installed."

**Relay ↔ extension messages** are JSON-RPC over the WebSocket, mirroring the
MCP tool calls one to one:

- `hello { token, protocolVersion }`: the handshake, rejected on a mismatch.
- `call { id, tool, args }` → `result { id, … }` or `error { id, … }`.
- `cancel { id }`: forwarded when the harness cancels a tool call, for example
  when the programmer presses Esc in the harness.
- `return { report }`: a report that arrived for a call the relay had already
  cancelled, handed back to be delivered again (see below).

**Cancelling a call doesn't affect the session.** A cancelled `step` has
already queued its batch, and its outcome is reported on the next call.
Cancellation just releases the blocked call, without taking a report.

**Reports survive a race with cancellation.** A cancellation takes a moment to
reach the editor. If the call returns in that moment (say, because the
programmer just wrote a message), the harness has already given up on it and
the report would be lost. So the relay sends such a report back, and the
editor puts its batches and events back to be reported again. The WebSocket is
ordered, so this happens before the agent's next call arrives.

**Paths are relative to the agent's working directory.** The relay sends the
working directory it found with `start`, and the session resolves and reports
paths relative to it, which may be a subfolder of the workspace.

## Sessions

**One MCP connection can host many pairing sessions, one after another.** The
programmer works in the harness as usual, starts pairing when they want to,
ends it, goes back to the harness, and may pair again later.

A **session**:

- **starts** when the agent calls `start`, typically because the programmer
  asked it to pair, or ran the `start` prompt. The panel opens.
- **ends** when:
  - the programmer presses End session in the panel, or
  - the agent calls `end` (e.g. the programmer said they're done), or
  - the relay disconnects (the harness exited), or
  - the window closes.
- **belongs to one window**, and a window has at most one session at a time. A
  `start` while another session is active in that window is rejected.

Outside a session, pair tools other than `start` fail with `no_session`, so an
agent can't accidentally drive the editor when the programmer isn't pairing.
The programmer's edits between sessions aren't tracked. A new session starts
fresh, and the agent should re-read what it needs.

The panel keeps each session's narration history. Between sessions it shows
"No active session", and how to start one.

## Starting a session

**First-time setup.** The command *AI Pair: Set up agent* registers `pair-mcp`
with the harnesses the programmer picks, in each one's user-wide MCP
configuration, so it works in every project. It edits only the `pair` entry,
keeping the rest of the file as it was: JSON and JSONC with `jsonc-parser`,
Codex's TOML as text, table by table (a TOML round trip would drop comments).
For Claude Code it runs `claude mcp add --scope user` when the `claude` command
is there, since Claude Code rewrites `~/.claude.json` constantly. Harnesses in
VS Code itself (Copilot) need no setup: the extension provides the server to
them through VS Code's MCP API, running the relay directly in the workspace.
For any other harness it copies the config snippet to the clipboard. The
extension offers this once, the first time it starts. The harnesses and their
files are in [`agents.ts`](packages/vscode/src/agents.ts). OMP's entry
carries `timeout: 0`, since pair calls block while the
programmer watches and replies, far past OMP's 30-second MCP default.

**Each session.** The programmer picks the session's pairing mode beside
the panel's Start button (Build, or Learn at three splits of who does the
work; remembered, and fixed once a session starts), asks the agent to pair
("let's pair on adding a todos API, I'm new to Express"), or runs the
server's `start` prompt (in Claude Code: `/mcp__pair__start`). The agent
calls `start`, which returns the [agent guide](AGENT_GUIDE.md) and the
mode's page (`modeGuide.ts` in the relay, from the mode in the first
report) along with the first report.

**An agent, from the editor.** The panel's **Start** (or _AI Pair: Start
Agent_) sets the pair server up in the chosen agent if it isn't, then
opens a terminal in the workspace folder and runs its command there
(`omp`, `claude`, `codex`, `opencode`, `gemini`, or a custom command the
programmer gave, flags and all). That is all it does: the conversation
happens in the agent's own screen, and pairing starts from there as
above. The pick is remembered; Cursor has no terminal command, so it
isn't offered.

**What didn't play leaves OMP's history.** When the programmer interrupts,
the batches written ahead never play, but the `step` calls that sent them
stay in the agent's history, and a model tends to believe what it sees
itself write. So an OMP started from the panel also loads a small OMP extension
([`ompExtension.ts`](packages/relay/src/ompExtension.ts), bundled to
`dist/ompExtension.js` and passed with `-e`). On OMP's `context` hook it runs
[`history.ts`](packages/relay/src/history.ts): it reads each interrupted,
discarded or failed batch's "Not played" lines back from its report, finds
the `step` call that sent that batch (by the "Batch N is queued" line in its
result, or, when an interruption discarded it at once, as the last batch its
own result lists), and cuts that call down to the beats that played. A beat
cut short keeps its `say`, which was heard, and the actions that played
whole. Where OMP keeps the provider's own record of the message (OpenAI
Responses items, sent back in its place to keep the model's reasoning), the
call is cut there too. It
changes only what the model is sent, never the saved session, and it depends
on the history alone, so the same history always gives the same rewrite and
the provider's prompt cache still holds. Other agents have no such hook; they
go by the report, which says plainly that what didn't play never happened.

## The voice

A beat's `say` can be spoken instead of only shown. The player asks its stage
for a voice ([`VoicePort`](packages/core/src/ports.ts)); without one the words
are shown for their reading time. Either way a beat's words and its actions
start together, and the next beat starts once both are done. With a voice,
the player measures how long the beat's actions will take to play and hands
that span to `speak`, and the voice spreads its sentences across it — a
touch slower or faster, with pauses between sentences. Making speech takes a
moment — longer for a heavier model, or behind words still queued — so
`speak` also says when the words are first heard, and the actions wait for
that (`timing.voice.maxStartMs` caps the wait, so a stuck voice can't stall
the session); the hands never run ahead of the words about them. When the
words run longer than the actions, the voice gets that much of a head start
(`timing.voice.maxLeadMs` caps it), so talking and working end about
together, and the beat is then heard out in full before the next one starts,
so a `point` highlight stays on the code while it's talked about. A voice
that goes quiet without finishing is let go after about twice the line's
length. Without a voice, the actions start after `timing.voice.leadMs` (or
the reading time, if shorter), and the beat lasts as long as the longer of
reading and working. Interruptions settle the `speak` promise by stopping
the voice. Rehearsals never get a voice: they are silent.

The agent is told whether the voice is on (`VoicePort.enabled`): in the
`start` report, and again in the first report after it changes, so it
writes `say` for the ear or for the eye.

**Speech is made ahead.** When a batch is queued, the controller hands each of
its beats' `say`s to `VoicePort.prepare`, with the span the player will give it, so
its sentences are made while the batches before it play and the batch starts
talking at once. The speech queue
([`voiceQueue.ts`](packages/vscode/src/voiceQueue.ts)) makes them in order, one
at a time and a few ahead at most, so a fresh `say` after an interruption
waits behind one sentence, not the whole queue. `speak` takes the one made
for it; early ones it passes over, and everything made early when the voice
is stopped, are let go.

There are two voice models (`aiPair.voice.model`), each kept warm in a
worker process that takes one sentence per JSON line in and writes a WAV per
line; the extension ([`voice.ts`](packages/vscode/src/voice.ts)) restarts the
worker when the model changes.

The default is **Kokoro**, a light local speech model, in
[`voiceWorker.ts`](packages/vscode/src/voiceWorker.ts) (built to
`dist/voiceWorker.js`). It cannot run under VS Code's Electron
runtime — the hardened runtime refuses the speech engine's native code —
so bun, else node, found on the machine runs it. The pinned `kokoro-js`
is fetched on first turn-on into the extension's own storage
(`kokoro-<version>`, by bun or npm), the way Chatterbox is fetched by
uv: the voice belongs to AI Pair, not to any agent, and needs no agent
installed.

**Chatterbox** (Resemble AI's Turbo model, MIT) sounds more natural but is
heavier. On an Apple Silicon Mac it runs on the GPU through
[mlx-audio](https://github.com/Blaizzy/mlx-audio) at about 1.5× real time
(the 4-bit model; ONNX on the CPU managed under half); everywhere else it
runs in its original PyTorch form (Resemble's `chatterbox-tts` package),
on an NVIDIA card when there is one and slower on the CPU. Both workers
are Python — [`chatterboxWorker.py`](packages/vscode/src/chatterboxWorker.py)
and [`chatterboxTorchWorker.py`](packages/vscode/src/chatterboxTorchWorker.py)
— speaking the same lines to the extension, run by `uv tool run --from
<pinned package>` so no system Python is needed; the pins matter, because
the MLX worker swaps voices through a private field, and the PyTorch one's
watermarker still needs an older setuptools beside it. Only a click may
download: at startup the worker runs `--offline` with `HF_HUB_OFFLINE`,
and if the model isn't there yet it says so; turning the voice on fetches
it (about 1.3 GB on a Mac, a few GB elsewhere, once). Its voice is the
model's own, or one cloned from a recording the programmer picks. It has
no pace to set, so on a Mac its recording is played faster through
`afplay --rate`, which keeps the pitch. Either way it is never fitted to
a line's typing span: a natural voice played back faster and slower line
by line is plainly heard doing it, so it keeps one steady pace (below)
and only pauses between its sentences spread it over the typing.

**Pace.** One speed control drives typing and talking. The voice follows the
session speed from 1× up to 2×: slower sessions keep its natural pace and
just pause more, and past 2× words blur. `aiPair.voice.rate` multiplies on
top, and for Kokoro span fitting nudges each line; all together stays
within 0.5× and 2×. Kokoro takes the pace as its `speed` up to 1.3×; past
that it speeds up by giving each sound fewer frames, and short sounds run
out of them and words smear. A faster line is made at 1.3× and its
recording sped up the rest of the way at the same pitch, in the worker
(`timeStretch.ts`, overlap-add with each window lined up on the one before).
Chatterbox takes just the one pace, steady, as its playback rate.

Either way, the extension
puts each `say` the way a programmer says it out loud
([`voiceText.ts`](packages/vscode/src/voiceText.ts): `req.body` is "req dot
body", `user_id` "user id", `createTodo` "create todo", 404 "four oh four"),
splits it into sentences — a dot inside a word ends none — makes the next
while the last plays through the OS player (`afplay`, PowerShell's
SoundPlayer, PulseAudio/PipeWire tools), and drops the oldest waiting
sentences when speech falls behind.
Words are spoken for every agent alike: the sound
hangs off playback, not off the harness.

## Distribution

`pair-mcp` is **bundled inside the extension**, not published separately, so
the relay and the extension can never be out of sync.

The extension's install path changes with every version, so on activation the
extension writes a launcher at a fixed path, `~/.ai-pair/bin/pair-mcp`
(`pair-mcp.cmd` on Windows), pointing at the current version. The launcher runs
the relay with VS Code's own runtime (`ELECTRON_RUN_AS_NODE=1`), so the
programmer doesn't need Node installed.

## Repository layout

```
packages/
  protocol/   types of the agent protocol and the relay ↔ editor messages
  core/       editor-agnostic session and playback logic, and the WebSocket
              server (bridge) with discovery
  relay/      pair-mcp: stdio MCP ↔ WebSocket; tool schemas, instructions,
              the start prompt; bundles AGENT_GUIDE.md at build time
  vscode/     the extension: adapter, panel, launcher, setup; ships the relay
```

TypeScript throughout, npm workspaces, bundled with esbuild. The relay uses
the official MCP TypeScript SDK.

## Out of scope for v1

- **Permission prompts.** When the harness asks for permission, it notifies the
  programmer itself.
- **Starting other harnesses from the editor.** OMP starts from the panel
  (above); the rest are still launched by the programmer.
- **Multiple agents** in one window.
- **Zed.**
