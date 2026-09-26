// The agent's `run` commands: played in a terminal the programmer can see, output captured
// through shell integration. See `run` in PROTOCOL.md.

import * as path from "node:path"
import * as vscode from "vscode"
import { samePath, terminalText, type CommandOutcome, type RunOptions } from "@ai-pair/core"

/** How long a new terminal gets to report shell integration before the command is just typed in. */
const SHELL_INTEGRATION_MS = 5000
/** Output kept for the agent: the tail, where the result and the errors are. */
const MAX_OUTPUT = 12_000
/** After the command ends, how long its output stream gets to drain. */
const DRAIN_MS = 500

type Owned = { terminal: vscode.Terminal; cwd: string; busy: boolean }

export class PairTerminals implements vscode.Disposable {
  private readonly owned: Owned[] = []
  private readonly disposables: vscode.Disposable[]

  constructor() {
    this.disposables = [
      vscode.window.onDidCloseTerminal((t) => {
        const i = this.owned.findIndex((o) => o.terminal === t)
        if (i !== -1) this.owned.splice(i, 1)
      }),
    ]
  }

  async run(command: string, options: RunOptions): Promise<CommandOutcome> {
    const owned = this.acquire(options.cwd)
    owned.busy = true
    const { terminal } = owned
    terminal.show(true)

    const integration = await shellIntegration(terminal, options.signal)
    if (options.signal.aborted) {
      owned.busy = false
      return { output: "", notStarted: true }
    }
    if (!integration) {
      // Without shell integration we can't tell when it ends, so the terminal is never reused.
      terminal.sendText(command)
      return { output: "[output not captured: this terminal has no shell integration]" }
    }

    let execution: vscode.TerminalShellExecution | undefined
    let exitCode: number | undefined
    const ended = new Promise<void>((resolve) => {
      const done = () => {
        onEnd.dispose()
        onClose.dispose()
        resolve()
      }
      const onEnd = vscode.window.onDidEndTerminalShellExecution((e) => {
        if (e.execution !== execution) return
        exitCode = e.exitCode
        done()
      })
      const onClose = vscode.window.onDidCloseTerminal((t) => {
        if (t === terminal) done()
      })
    })
    void ended.then(() => (owned.busy = false))

    const started = integration.executeCommand(command)
    execution = started
    const output = new Tail(MAX_OUTPUT * 4)
    const drained = (async () => {
      for await (const data of started.read()) output.push(data)
    })().catch(() => {})

    const finished = await Promise.race([ended.then(() => true), stopWaiting(options.waitMs, options.signal, ended)])
    if (finished) await Promise.race([drained, delay(DRAIN_MS)])

    const text = terminalText(output.text)
    const outcome: CommandOutcome = { output: text.length > MAX_OUTPUT ? text.slice(-MAX_OUTPUT) : text }
    if (terminal.state.shell) outcome.shell = terminal.state.shell
    if (output.dropped || text.length > MAX_OUTPUT) outcome.truncated = true
    if (finished) {
      if (exitCode !== undefined) outcome.exitCode = exitCode
    } else {
      outcome.running = true
    }
    return outcome
  }

  private acquire(cwd: string): Owned {
    const idle = this.owned.find((o) => {
      const at = o.terminal.shellIntegration?.cwd?.fsPath ?? o.cwd
      return !o.busy && o.terminal.exitStatus === undefined && samePath(path.resolve(at), path.resolve(cwd))
    })
    if (idle) return idle
    const terminal = vscode.window.createTerminal({ name: "AI Pair", cwd, iconPath: new vscode.ThemeIcon("comment-discussion") })
    const owned: Owned = { terminal, cwd, busy: false }
    this.owned.push(owned)
    return owned
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose()
  }
}

function shellIntegration(terminal: vscode.Terminal, signal: AbortSignal): Promise<vscode.TerminalShellIntegration | undefined> {
  if (terminal.shellIntegration) return Promise.resolve(terminal.shellIntegration)
  return new Promise((resolve) => {
    const done = (value: vscode.TerminalShellIntegration | undefined) => {
      listener.dispose()
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
      resolve(value)
    }
    const abort = () => done(undefined)
    const listener = vscode.window.onDidChangeTerminalShellIntegration((e) => {
      if (e.terminal === terminal) done(e.shellIntegration)
    })
    const timer = setTimeout(() => done(terminal.shellIntegration), SHELL_INTEGRATION_MS)
    signal.addEventListener("abort", abort, { once: true })
  })
}

/** Resolves `false` when the wait is over or playback is interrupted. */
function stopWaiting(ms: number, signal: AbortSignal, ended: Promise<void>): Promise<false> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false)
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve(false)
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener("abort", done, { once: true })
    void ended.then(done)
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Keeps the last `max` characters of a stream. */
class Tail {
  text = ""
  dropped = false
  constructor(private readonly max: number) {}
  push(data: string): void {
    this.text += data
    if (this.text.length > this.max) {
      this.text = this.text.slice(-this.max)
      this.dropped = true
    }
  }
}

