# AI Pair Programmer

Pair program with an AI agent in VS Code. The agent gets its own cursor in your
editor. It types at a human pace and narrates what it's doing in a panel next
to the code, and you can interrupt it, reply, or take over at any moment.

Instead of handing the agent a task, waiting, and reviewing a pile of changes,
you're there the whole time. You see where it's going early, steer when you
don't like the direction, and write parts yourself. Or you watch it build
something with a technology you want to learn, and follow along as if it were
a tutorial written for you.

It works with your existing coding agent (tested with Claude Code) through
MCP, so the agent keeps all its usual tools.

> **Status:** early and experimental. VS Code only; macOS is the tested
> platform. Not on the Marketplace yet.

## Install

You need **VS Code 1.105 or newer** and **Node.js 20 or newer**. Build the
extension from source and install it:

```sh
git clone https://github.com/faiface/ai-pair.git
cd ai-pair
npm install
npm run package
code --install-extension ai-pair-0.1.0.vsix
```

Or, instead of the last line, in VS Code: Extensions view → `…` menu →
*Install from VSIX…*

## Connect your agent

1. **Open a project folder in VS Code.** On its first start, the extension
   installs a small launcher at `~/.ai-pair/bin/pair-mcp`. That's the MCP
   server your agent runs, and each VS Code window registers itself so the
   server can find it.
2. **Run *AI Pair: Set Up Agent*** from the command palette (VS Code also
   offers this the first time the extension starts). Pick your agent:
   - **Claude Code (CLI)**, for all your projects. This runs the following in
     a terminal:
     ```sh
     claude mcp add --scope user pair -- ~/.ai-pair/bin/pair-mcp
     ```
   - **Claude Code (this project)**. This writes a `.mcp.json` into the
     project. Use it if you use Claude Code in the **Claude desktop app**,
     which has no `claude` command. The file refers to the launcher through
     `${HOME}`, so it works for anyone who has the extension.
   - **Another agent**. This copies an MCP server configuration to the
     clipboard: a stdio server named `pair` running `~/.ai-pair/bin/pair-mcp`.
3. **Restart your agent** so it picks up the new server.

## Pair

1. Open the project in VS Code, and start your agent **in the same folder** (or
   a subfolder of it).
2. Ask it to pair: *"Let's pair on adding a settings page."* In Claude Code,
   you can also run `/mcp__pair__start`. Say so if you want to learn the
   technology as you go: *"…I'm new to Svelte, explain as you go."*
3. The **Pair** panel opens in the secondary side bar, and the agent's cursor
   appears in your editor.

While you pair:

| To… | Do this |
|---|---|
| say something to the agent | type in the reply box, press Enter. Typing pauses playback. |
| ask about some code | select it in the editor, then reply: the selection goes along (× leaves it out) |
| let it run a command | the agent's tests and builds play in an *AI Pair* terminal; **Run**, **Allow for session**, or **Skip** in the panel |
| stop it right now | **Interrupt**, or just edit the code: any edit interrupts |
| look around | scroll or switch files. Playback pauses until you **Resume**, which brings you back to the agent's cursor |
| write a part yourself | **My turn**. The agent becomes the navigator and comments as you type. **Your turn** hands it back, with your reply if you typed one |
| change the pace | **Slow / Normal / Fast** |
| finish | **End**, or tell the agent you're done |

The cursor's color tells you what the agent is doing. It's yellow and pulsing
when it has just said something and waits for you to read it.

**Try it without an agent:** *AI Pair: Play Demo Session* plays a scripted
session that adds a small API to a demo Express app, in `ai-pair-demo/` in the
open folder.

## Settings

| Setting | |
|---|---|
| `aiPair.speed` | Overall playback speed (the panel's Slow / Normal / Fast set 0.6, 1, 1.6). |
| `aiPair.agentName` | The name on the agent's cursor. |
| `aiPair.timing` | Fine-tune any typing or pause duration, e.g. `{ "afterSelectMs": 900, "type": { "wordStartMs": 140 } }`. Every key is in [`timing.ts`](packages/core/src/timing.ts). |
| `aiPair.confirmCommands` | Ask before each command the agent runs in the terminal (default on). Off means the agent's `run` skips the harness's permission prompt. |

## Troubleshooting

- **The agent says `no_editor`.** Its working directory isn't inside a folder
  that's open in VS Code. Open that folder in VS Code, or start the agent in
  it.
- **The agent doesn't have the pair tools.** Restart the agent after setting
  it up. With the Claude Code CLI, `claude mcp list` should show `pair`. With
  `.mcp.json`, approve the server when Claude Code asks.
- **After updating the extension,** reload the VS Code window and restart the
  agent.

## How it works

```
agent (Claude Code, …) ──stdio MCP──▶ pair-mcp ──local WebSocket──▶ VS Code extension
```

The agent submits small batches of actions: say, move, select, type, point.
The extension plays them at a human pace and reports back exactly what
happened, including everything you did in the meantime. The agent plans its
next batch while you watch the current one, so there are no pauses between
thinking and acting. And it's never more than one batch ahead, so your
interruptions land immediately.

The design is written up in:

- [PROTOCOL.md](PROTOCOL.md): the tools and their exact semantics, as the agent sees them.
- [AGENT_GUIDE.md](AGENT_GUIDE.md): how the agent should pair, returned to it when a session starts.
- [DESIGN.md](DESIGN.md): what you see: the cursor, the panel, the timing.
- [ARCHITECTURE.md](ARCHITECTURE.md): the components and how they connect.

## Development

```
packages/
  protocol/   types shared by everything
  core/       editor-agnostic sessions, playback, and the local WebSocket server
  relay/      pair-mcp, the MCP server the agent runs
  vscode/     the extension, which ships the relay
```

```sh
npm install
npm test                  # unit and end-to-end tests
npm run typecheck
npm run build             # development build of the extension
npm run test:integration  # plays a session inside a real, isolated VS Code (macOS)
npm run package           # production build → ai-pair-<version>.vsix
```

To run your working copy, open the repository in VS Code and press F5, or:

```sh
code --extensionDevelopmentPath="$PWD/packages/vscode" <a project folder>
```

## License

[MIT](LICENSE)
