import * as nodePath from "node:path"
import { vi } from "vitest"
import { Controller, defaultConfig, type Config } from "../src/controller"
import type {
  AgentState,
  CommandOutcome,
  CursorView,
  EditOptions,
  EditorPort,
  Focus,
  PanelEvent,
  PanelPort,
  RunOptions,
} from "../src/ports"

/** `/project` in this platform's form (`C:\project` on Windows), as the controller resolves it. */
const ROOT = nodePath.resolve("/project")

export class FakeEditor implements EditorPort {
  files = new Map<string, string>()
  dirty = new Set<string>()
  saved: string[] = []
  edits: { file: string; offset: number; deleteLength: number; text: string; options: EditOptions }[] = []
  shown: string[] = []
  cursor: CursorView | null = null
  state: AgentState | null = null
  point: { file: string; start: number; end: number } | null = null
  controller!: Controller

  resolvePath(file: string): string {
    return nodePath.resolve(ROOT, file)
  }
  displayPath(file: string): string {
    const rel = nodePath.relative(ROOT, file)
    return rel.startsWith("..") || nodePath.isAbsolute(rel) ? file : rel
  }
  async getText(file: string): Promise<string> {
    const text = this.files.get(file)
    if (text === undefined) throw new Error(`No such file: ${file}`)
    return text
  }
  /** Files the editor stores with CRLF, whatever they contain so far. */
  crlf = new Set<string>()
  async eol(file: string): Promise<string> {
    return this.crlf.has(file) ? "\r\n" : "\n"
  }
  async isDirty(file: string): Promise<boolean> {
    return this.dirty.has(file)
  }
  async show(file: string): Promise<void> {
    if (!this.files.has(file)) this.files.set(file, "")
    if (this.shown.at(-1) !== file) this.shown.push(file)
  }
  async edit(file: string, offset: number, deleteLength: number, text: string, options: EditOptions): Promise<void> {
    const old = await this.getText(file)
    this.files.set(file, old.slice(0, offset) + text + old.slice(offset + deleteLength))
    this.dirty.add(file)
    this.edits.push({ file, offset, deleteLength, text, options })
  }
  async save(file: string): Promise<void> {
    this.dirty.delete(file)
    this.saved.push(file)
  }
  focus: Focus = "cursor"
  renderCursor(cursor: CursorView | null, state: AgentState, focus: Focus): void {
    this.cursor = cursor
    this.state = state
    this.focus = focus
  }
  renderPoint(point: { file: string; start: number; end: number } | null): void {
    this.point = point
  }
  reveals = 0
  reveal(): void {
    this.reveals++
  }

  commands: { command: string; options: RunOptions }[] = []
  /**
   * How each command behaves: its terminal takes `startMs` to get ready, then the command takes `ms`
   * and exits with `exitCode`, having printed `output`.
   */
  commandScript: Record<string, { ms: number; startMs?: number; exitCode?: number; output?: string }> = {}
  async runCommand(command: string, options: RunOptions): Promise<CommandOutcome> {
    const script = this.commandScript[command] ?? { ms: 0, exitCode: 0 }
    if (script.startMs) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, script.startMs)
        options.signal.addEventListener("abort", () => resolve())
      })
      if (options.signal.aborted) return { output: "", notStarted: true }
    }
    this.commands.push({ command, options })
    const output = script.output ?? ""
    const finished = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(script.ms <= options.waitMs), Math.min(script.ms, options.waitMs))
      options.signal.addEventListener("abort", () => {
        clearTimeout(timer)
        resolve(false)
      })
    })
    return finished ? { exitCode: script.exitCode, output, shell: "bash" } : { output, running: true }
  }

  /** The programmer types into a file. */
  userEdit(name: string, offset: number, deleteLength: number, text: string): void {
    const file = this.resolvePath(name)
    const before = this.files.get(file) ?? ""
    const after = before.slice(0, offset) + text + before.slice(offset + deleteLength)
    this.files.set(file, after)
    this.controller.userEdit(file, before, after, [{ offset, deleteLength, text }])
  }

  text(name: string): string {
    return this.files.get(this.resolvePath(name)) ?? ""
  }
}

export class FakePanel implements PanelPort {
  events: PanelEvent[] = []
  post(event: PanelEvent): void {
    this.events.push(event)
  }
  says(): string[] {
    return this.events.flatMap((e) => (e.type === "say" ? [e.text] : []))
  }
}

/** Deterministic timing: no jitter, round numbers, no pauses except before moves and selections. */
export const testConfig: Config = {
  ...defaultConfig,
  timing: {
    type: { charMs: 100, jitter: 0.25, wordStartMs: 0, punctuationMs: 0, openBracketMs: 0, newlineMs: 0 },
    fastFactor: 0.1,
    reading: { msPerWord: 100, minMs: 500, maxMs: 2000 },
    beforeMoveMs: 100,
    afterMoveNearMs: 0,
    afterMoveFarMs: 0,
    nearLines: 15,
    beforeSelectMs: 100,
    afterSelectMs: 0,
    afterDeleteMs: 0,
    afterPointMs: 0,
  },
  navigatorIdleMs: 1000,
  random: () => 0.5,
}

export function setup(files: Record<string, string> = {}, config: Partial<Config> = {}) {
  const editor = new FakeEditor()
  const panel = new FakePanel()
  for (const [name, text] of Object.entries(files)) editor.files.set(editor.resolvePath(name), text)
  const controller = new Controller(editor, panel, { ...testConfig, ...config })
  editor.controller = controller
  return { editor, panel, controller }
}

/** Tracks a promise so tests can check whether it has settled yet. */
export function track<T>(promise: Promise<T>) {
  const t = { done: false, value: undefined as T | undefined, error: undefined as unknown }
  promise.then(
    (v) => {
      t.done = true
      t.value = v
    },
    (e) => {
      t.done = true
      t.error = e
    },
  )
  return t
}

/** Advances fake time until the promise settles. */
export async function until<T>(promise: Promise<T>, maxMs = 120_000): Promise<T> {
  const t = track(promise)
  for (let elapsed = 0; !t.done && elapsed < maxMs; elapsed += 10) {
    await vi.advanceTimersByTimeAsync(10)
  }
  if (!t.done) throw new Error(`Still pending after ${maxMs} ms`)
  if (t.error !== undefined) throw t.error
  return t.value as T
}

export async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}
