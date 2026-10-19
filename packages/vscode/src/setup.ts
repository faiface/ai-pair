// The launcher for pair-mcp, and connecting it to the programmer's agents.
// See "Starting a session" and "Distribution" in ARCHITECTURE.md.

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import * as vscode from "vscode"
import { aiPairHome } from "@ai-pair/protocol"
import { AGENTS, execProgram, SERVER, type Host } from "./agents"

function relayPath(extensionPath: string): string {
  return path.join(extensionPath, "dist", "relay.js")
}

/**
 * Writes a launcher at a fixed path that runs this version's relay with VS Code's own runtime,
 * so the agent's MCP configuration never changes and Node needn't be installed.
 */
export function writeLauncher(extensionPath: string): string {
  const bin = path.join(aiPairHome(), "bin")
  fs.mkdirSync(bin, { recursive: true })
  const relay = relayPath(extensionPath)
  if (process.platform === "win32") {
    const launcher = path.join(bin, "pair-mcp.cmd")
    fs.writeFileSync(launcher, `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" "${relay}" %*\r\n`)
    return launcher
  }
  const launcher = path.join(bin, "pair-mcp")
  fs.writeFileSync(launcher, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "${relay}" "$@"\n`, { mode: 0o755 })
  return launcher
}

/**
 * Offers the pair server to agents running in VS Code itself (Copilot), with no setup: it runs the
 * relay directly, in the workspace, which is how the relay finds this window.
 */
export function registerServerProvider(context: vscode.ExtensionContext): void {
  // Missing in editors built on an older VS Code.
  if (typeof vscode.lm?.registerMcpServerDefinitionProvider !== "function") return
  const changed = new vscode.EventEmitter<void>()
  context.subscriptions.push(
    changed,
    vscode.workspace.onDidChangeWorkspaceFolders(() => changed.fire()),
    vscode.lm.registerMcpServerDefinitionProvider("aiPair.pair", {
      onDidChangeMcpServerDefinitions: changed.event,
      provideMcpServerDefinitions: () => {
        const folder = vscode.workspace.workspaceFolders?.[0]
        if (!folder) return []
        const server = new vscode.McpStdioServerDefinition(
          SERVER,
          process.execPath,
          [relayPath(context.extensionPath)],
          { ELECTRON_RUN_AS_NODE: "1" },
          String(context.extension.packageJSON.version),
        )
        server.cwd = folder.uri
        return [server]
      },
    }),
  )
}

const host: Host = { home: os.homedir(), env: process.env, platform: process.platform, exec: execProgram }

export async function setUpAgent(launcher: string): Promise<void> {
  type Item = vscode.QuickPickItem & { id: string }
  const items: Item[] = AGENTS.map((agent) => ({
    id: agent.id,
    label: agent.label,
    description: agent.isSetUp(host, launcher) ? "set up" : agent.detect(host) ? "installed" : undefined,
    picked: agent.detect(host) && !agent.isSetUp(host, launcher),
  }))
  items.push({ id: "other", label: "Another agent", description: "Copy an MCP server configuration to the clipboard" })
  const picked = await vscode.window.showQuickPick(items, {
    title: "Which agents do you pair with?",
    placeHolder: "GitHub Copilot in VS Code needs no setup: it already has the pair server.",
    canPickMany: true,
  })
  if (!picked?.length) return

  const done: string[] = []
  for (const agent of AGENTS.filter((a) => picked.some((p) => p.id === a.id))) {
    try {
      await agent.setUp(host, launcher)
      done.push(agent.label)
    } catch (e) {
      void vscode.window.showErrorMessage(
        `Couldn't set up ${agent.label}: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
  }
  if (picked.some((p) => p.id === "other")) {
    const config = { mcpServers: { [SERVER]: { command: launcher, args: [] } } }
    await vscode.env.clipboard.writeText(JSON.stringify(config, null, 2))
    void vscode.window.showInformationMessage(
      `Copied. Add it to your agent's MCP configuration: a stdio server named "${SERVER}" running ${launcher}.`,
    )
  }
  if (done.length) {
    void vscode.window.showInformationMessage(
      `Set up ${list(done)}. Restart it, then ask it to pair in a folder that's open here.`,
    )
  }
}

/**
 * The panel's Start button: it only runs the chosen agent in a terminal in the workspace, the way
 * the programmer would, after giving it the pair server if it hasn't one. An open terminal is
 * reused only when it is free (nothing running in it) and already standing in the workspace;
 * otherwise a new one is made. Every agent is started the same way and stays its own app — its
 * model, its thinking, its screen.
 */
export class AgentStarter {
  /** Terminals with something running in them, watched through shell integration's word for it. */
  private readonly busy = new Set<vscode.Terminal>()

  constructor(
    private readonly launcher: string,
    private readonly state: vscode.Memento,
    /** The OMP extension that cuts interrupted `step` calls down to what played, in the model's history. */
    private readonly ompExtension: string,
  ) {
    vscode.window.onDidStartTerminalShellExecution((e) => this.busy.add(e.terminal))
    vscode.window.onDidEndTerminalShellExecution((e) => this.busy.delete(e.terminal))
    vscode.window.onDidCloseTerminal((t) => this.busy.delete(t))
  }

  start(): void {
    void this.run().catch((error: unknown) => {
      void vscode.window.showErrorMessage(`AI Pair couldn't start the agent: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  /** Chooses which agent Start runs, or a command of the programmer's own (any flags go there). */
  async pick(): Promise<void> {
    type Item = vscode.QuickPickItem & { id: string }
    const chosen = this.state.get<string>("aiPair.startAgent")
    const items: Item[] = AGENTS.filter((a) => a.run).map((agent) => ({
      id: agent.id,
      label: agent.label,
      description: [agent.run, agent.detect(host) ? "installed" : undefined, agent.id === chosen ? "chosen" : undefined].filter(Boolean).join(" · "),
    }))
    items.push({
      id: "custom",
      label: "Custom command…",
      description: this.state.get<string>("aiPair.startCommand") || "Any command, with the flags you want",
    })
    const picked = await vscode.window.showQuickPick(items, { title: "Which agent should Start run in a terminal?" })
    if (!picked) return
    if (picked.id === "custom") {
      const command = await vscode.window.showInputBox({
        prompt: "The command Start runs in a terminal in the workspace",
        value: this.state.get<string>("aiPair.startCommand") ?? "",
        placeHolder: "e.g. omp --thinking low",
      })
      if (!command?.trim()) return
      await this.state.update("aiPair.startCommand", command.trim())
    }
    await this.state.update("aiPair.startAgent", picked.id)
  }

  /** The chosen agent and the exact words for its terminal; a custom command is its programmer's. */
  private choice(): { label: string; command: string; agent?: (typeof AGENTS)[number] } {
    const id = this.state.get<string>("aiPair.startAgent")
    if (id === "custom") {
      const command = this.state.get<string>("aiPair.startCommand")
      if (command) return { label: "Custom command", command }
    }
    const agent = AGENTS.find((a) => a.id === id && a.run) ?? AGENTS.find((a) => a.run && a.detect(host)) ?? AGENTS.find((a) => a.run)!
    // OMP alone loads extensions, so it alone gets the history one: invisible glue, like its setup file.
    const command = agent.id === "omp" ? `omp -e "${this.ompExtension}"` : agent.run!
    return { label: agent.label, command, agent }
  }

  private async run(): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    if (!root) throw new Error("open a folder first, so the agent knows where to work.")
    const { label, command, agent } = this.choice()
    if (agent && !agent.isSetUp(host, this.launcher)) await agent.setUp(host, this.launcher)
    const open = this.freeHere(root)
    const terminal = open ?? vscode.window.createTerminal({ name: label, cwd: root })
    terminal.show()
    terminal.sendText(command)
  }

  /**
   * An open terminal Start may use: nothing running in it, and already standing in the workspace.
   * Both are shell integration's word, so a terminal it doesn't speak for is left alone.
   */
  private freeHere(root: string): vscode.Terminal | undefined {
    const base = process.platform === "win32" ? root.toLowerCase() : root
    const fits = (t: vscode.Terminal) => {
      const cwd = t.shellIntegration?.cwd?.fsPath
      if (!cwd || this.busy.has(t)) return false
      const dir = process.platform === "win32" ? cwd.toLowerCase() : cwd
      return dir === base || dir.startsWith(base + path.sep)
    }
    const active = vscode.window.activeTerminal
    return active && fits(active) ? active : vscode.window.terminals.find(fits)
  }
}

function list(names: string[]): string {
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
}
