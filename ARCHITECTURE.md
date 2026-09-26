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
  extension: sessions, the batch queue, the playback scheduler, anchor
  resolution, cursor tracking, the event log, and report assembly. It has no
  editor dependencies, so it can be tested against a fake editor.
- **The VS Code adapter** is a thin layer over the VS Code API: apply edits with
  undo stops, report document changes, render decorations, scroll, save. It
  tells the agent's edits apart from the programmer's by tracking the document
  versions its own edits produce.
- **The narration panel** is a webview. It talks to the extension via
  `postMessage`.

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
2. Picks the window whose workspace folder contains the harness's working
   directory (the longest match). On a tie, it picks the most recently focused.
3. Connects and authenticates with the token and protocol version.

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

**Paths are relative to the agent's working directory.** The relay sends its
working directory with `start`, and the session resolves and reports paths
relative to it, which may be a subfolder of the workspace.

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
with the harness. For Claude Code it runs:

```
claude mcp add --scope user pair -- ~/.ai-pair/bin/pair-mcp
```

For other harnesses it copies the config snippet to the clipboard. The
extension offers this once, the first time it starts.

**Each session.** The programmer asks the agent to pair ("let's pair on adding
a todos API, I'm new to Express"), or runs the server's `start` prompt (in
Claude Code: `/mcp__pair__start`). The agent calls `start`, which returns the
[agent guide](AGENT_GUIDE.md) along with the first report.

**Later, from the editor.** Starting from the editor (type the task in the
panel, and the extension launches the harness in the integrated terminal)
would be a convenience on top, with a small adapter per harness. Not in v1.

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
- **Starting from the editor** (see above).
- **Multiple agents** in one window.
- **Zed.**
