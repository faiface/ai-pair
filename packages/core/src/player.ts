// Playing batches: what each action does, at a human pace. The same code plays a batch in the
// programmer's editor and, to check it before it's queued, in memory (see rehearsal.ts).

import type { Action, BatchResult, Candidate, Code, ErrorKind, RunResult, SpanTarget, Turn } from "@ai-pair/protocol"
import * as nodePath from "node:path"
import { actionKinds, CURSOR_MARKER, moveProblem, spanProblem, typeProblem } from "@ai-pair/protocol"
import { resolveSpan, resolveSpot, spanCandidates, spotCandidates, type Resolution } from "./places"
import type { Config } from "./controller"
import type { LineIds, Sighting } from "./lines"
import type { Change, EditorPort, Focus, PanelPort } from "./ports"
import { fileLines, isLineStart, lineEnd, lineText, position } from "./text"
import type { Pacing } from "./timeline"
import { planTyping, readingTime } from "./typing"

/** What playback reads and changes. */
export type Scene = {
  /** The agent's working directory, if it gave one: paths to and from the agent are relative to it. */
  root?: string
  turn: Turn
  cursor: { file: string; offset: number } | null
  selection: { start: number; end: number } | null
  point: { file: string; start: number; end: number } | null
  /** What the view follows: the cursor, or, right after a `point`, the pointed code. */
  focus: Focus
  /** The pointed code is in another file than the cursor, or far from it: looking back changes the view. */
  pointFar: boolean
  /** Commands the programmer allowed to run without asking, until the session ends. */
  allowedCommands: Set<string>
}

/** Where actions take effect: the programmer's editor, or a copy of it in memory. */
export type Stage = {
  editor: EditorPort
  panel: PanelPort
  pacing: Pacing
  config(): Config
  speed(): number
  /** Shows the agent cursor and state after a change. */
  render(): void
  /** Waits for the programmer to allow or decline a command. */
  confirm(id: number, command: string): Promise<boolean>
  /** The identities of the lines of the files played in. */
  lines: LineIds
  /**
   * Whether the line numbered `line` in `file` is the one the agent was last shown there, by its
   * identity. Given, a `move` only goes to a line the agent knows the number of.
   */
  knows?(file: string, line: number, id: number): boolean
}

type Range = { file: string; start: number; end: number }

/**
 * `consumed`: the action took effect, so it counts as played and isn't returned as unplayed.
 * `rest`: the action took effect in part; this is what's left of it.
 */
type Outcome =
  | { kind: "ok" }
  | { kind: "interrupted"; rest?: Action; consumed?: boolean }
  | { kind: "error"; error: ErrorKind; message: string; candidates?: Candidate[]; consumed?: boolean; sighting?: Sighting }

/** The batch being played: what it touched, for saving and for its report's code. */
type Playing = {
  touched: Set<string>
  runs: RunResult[]
  /** The lines its report shows. */
  sightings: Sighting[]
  /** The file it names, in `move`, `select` or `point`, and whether it has edited yet. */
  named?: string
  edited: boolean
  /** The text its edits changed, tracked through later edits. */
  span?: Range
  moved: boolean
}

/** A report's code longer than this skips lines in the middle. */
const MAX_CODE_LINES = 40

/** Lines of context around a report's code, above and below. */
const CONTEXT_LINES = 3

const ok: Outcome = { kind: "ok" }

/** Shared by all players, so the panel never sees two commands with one id. */
let nextRunId = 1

function fail(error: ErrorKind, message: string): Outcome {
  return { kind: "error", error, message }
}

/** `file` and `text`: where the resolution failed, so the lines it lists are shown. */
function failed(r: Resolution & { ok: false }, file: string, text: string, shown: number[] = []): Outcome {
  const lines = [...shown, ...(r.candidates ?? []).map((c) => c.line)]
  const outcome: Outcome = { kind: "error", error: r.kind, message: r.message, candidates: r.candidates }
  if (lines.length > 0) outcome.sighting = { file, text, lines }
  return outcome
}

/** Absolute path for a path from the agent: relative to its working directory, if it gave one. */
export function agentPath(editor: EditorPort, root: string | undefined, file: string): string {
  return editor.resolvePath(root ? nodePath.resolve(root, file) : file)
}

/** How to name a file to the agent. */
export function displayPath(editor: EditorPort, root: string | undefined, file: string): string {
  if (!root) return editor.displayPath(file)
  const rel = nodePath.relative(root, file)
  return rel.startsWith("..") || nodePath.isAbsolute(rel) ? file : rel
}

function mapThrough(change: Change): (pos: number) => number {
  return (pos) => {
    if (pos <= change.offset) return pos
    if (pos >= change.offset + change.deleteLength) return pos + change.text.length - change.deleteLength
    return change.offset + change.text.length
  }
}

/** Keeps a scene's cursor, selection and pointed code in place through a change to `file`. */
export function transformScene(s: Scene, file: string, change: Change): void {
  const map = mapThrough(change)
  // In place: typing holds this cursor object.
  if (s.cursor?.file === file) s.cursor.offset = map(s.cursor.offset)
  if (s.cursor?.file === file && s.selection) {
    s.selection = { start: map(s.selection.start), end: map(s.selection.end) }
  }
  if (s.point?.file === file) s.point = { file, start: map(s.point.start), end: map(s.point.end) }
}

export class Player {
  /** In a reading pause, or waiting for the programmer to allow a command. */
  reading = false
  /** A `run` whose command is executing. */
  commandRunning = false
  private playing?: Playing

  constructor(
    readonly scene: Scene,
    private readonly stage: Stage,
  ) {}

  /** Plays a batch, saves the files it edited, and says how it went, and which lines that shows. */
  async play(id: number, actions: Action[]): Promise<{ result: BatchResult; sightings: Sighting[] }> {
    const playing: Playing = { touched: new Set(), runs: [], sightings: [], edited: false, moved: false }
    this.playing = playing
    let result: BatchResult
    try {
      result = await this.actions(id, actions, playing)
    } finally {
      this.playing = undefined
    }
    if (playing.runs.length > 0) result.runs = playing.runs
    if (result.status !== "discarded") {
      try {
        const shown = await this.code(playing)
        if (shown) {
          result.code = shown.code
          playing.sightings.push(shown.sighting)
        }
      } catch {
        // The file is gone; the report just can't show it.
      }
    }
    const unsaved = await this.save(playing)
    // A `save_failed` error already names them.
    if (unsaved.length > 0 && result.error?.kind !== "save_failed") result.unsaved = unsaved
    return { result, sightings: playing.sightings }
  }

  /** The lines changed in `span`, extended to the cursor's line, with context around, and the cursor marked. */
  async code({ span, moved }: { span?: Range; moved: boolean }): Promise<{ code: Code; sighting: Sighting } | undefined> {
    const s = this.scene
    const file = span?.file ?? (moved ? s.cursor?.file : undefined)
    if (!file) return undefined
    const text = await this.stage.editor.getText(file)
    const { lines, finalNewline } = fileLines(text)
    const at = s.cursor?.file === file ? position(text, s.cursor.offset) : undefined
    let from = at?.line ?? Infinity
    let to = at?.line ?? -Infinity
    if (span) {
      // Text ending with a newline changed the lines up to it, not the one after.
      const end = span.end > span.start && isLineStart(text, span.end) ? span.end - 1 : span.end
      from = Math.min(from, position(text, span.start).line)
      to = Math.max(to, position(text, end).line)
    }
    // The empty line after a final newline isn't one of the file's lines, but the cursor may be on it.
    const last = lines.length
    from = Math.max(1, from - CONTEXT_LINES)
    to = Math.min(Math.max(last, at?.line ?? 0), to + CONTEXT_LINES)
    const numbers: number[] = []
    for (let n = from; n <= to; n++) {
      const long = to - from + 1 > MAX_CODE_LINES
      if (!long || n < from + MAX_CODE_LINES / 2 || n > to - MAX_CODE_LINES / 2 || n === at?.line) numbers.push(n)
    }
    const code: Code = {
      file: this.displayPath(file),
      lines: numbers.map((n) => {
        const line = lines[n - 1] ?? ""
        if (n !== at?.line) return { number: n, text: line }
        return { number: n, text: line.slice(0, at.column - 1) + CURSOR_MARKER + line.slice(at.column - 1) }
      }),
    }
    if (to >= last) code.end = { final_newline: finalNewline }
    return { code, sighting: { file, text, lines: numbers } }
  }

  /** Keeps the positions playback holds in place through a change someone else made. */
  transform(file: string, change: Change): void {
    transformScene(this.scene, file, change)
    const map = mapThrough(change)
    const span = this.playing?.span
    if (span?.file === file) this.playing!.span = { file, start: map(span.start), end: map(span.end) }
  }

  private async actions(id: number, actions: Action[], playing: Playing): Promise<BatchResult> {
    for (let i = 0; i < actions.length; i++) {
      if (this.stage.pacing.isInterrupted) return this.stopped(id, actions.slice(i), i > 0)
      let outcome: Outcome
      try {
        outcome = await this.perform(actions[i]!, playing)
      } catch (e) {
        outcome = fail("invalid_action", e instanceof Error ? e.message : String(e))
      }
      const rest = actions.slice(i + 1)
      if (outcome.kind === "interrupted") {
        if (outcome.consumed) return this.stopped(id, rest, true)
        if (outcome.rest) return this.stopped(id, [outcome.rest, ...rest], true)
        return this.stopped(id, actions.slice(i), i > 0)
      }
      if (outcome.kind === "error") {
        if (outcome.sighting) playing.sightings.push(outcome.sighting)
        const result: BatchResult = { id, status: "failed", error: { kind: outcome.error, message: outcome.message } }
        if (outcome.candidates) result.error!.candidates = outcome.candidates
        const unplayed = outcome.consumed ? rest : actions.slice(i)
        if (unplayed.length > 0) result.unplayed = unplayed
        return result
      }
    }
    return { id, status: "completed" }
  }

  /** An interrupted batch. With no visible effect yet, it counts as discarded. */
  private stopped(id: number, unplayed: Action[], effect: boolean): BatchResult {
    const result: BatchResult = { id, status: effect ? "interrupted" : "discarded" }
    if (unplayed.length > 0) result.unplayed = unplayed
    return result
  }

  private delay(ms: number): Promise<boolean> {
    return this.stage.pacing.sleep(ms / this.stage.speed())
  }

  private async perform(action: Action, playing: Playing): Promise<Outcome> {
    const s = this.scene
    const { editor, panel } = this.stage
    const timing = this.stage.config().timing
    const kinds = actionKinds(action)
    if (kinds.length > 1) {
      return fail("invalid_action", `One action per object, got ${kinds.map((k) => `\`${k}\``).join(" and ")}: make them separate actions, in order.`)
    }
    const named = this.names(action, playing)
    if (typeof named === "object") return named
    if (s.turn === "user" && !("say" in action) && !("point" in action)) {
      return fail("not_your_turn", "During the programmer's turn, only `say` and `point` are allowed.")
    }

    // An action at the cursor brings the view back to it from the code last pointed at. A far jump
    // back gets a far move's pause, before anything happens there; one to another file has its own.
    const cursorAction = !("say" in action) && !("point" in action) && !("run" in action)
    const lookingBack = cursorAction && s.focus === "point"
    const farBack = lookingBack && s.pointFar
    if (lookingBack) {
      s.focus = "cursor"
      if (farBack && !("move" in action) && named === undefined && s.cursor) {
        await editor.show(s.cursor.file)
        this.stage.render()
        if (!(await this.delay(timing.afterMoveFarMs))) return { kind: "interrupted" }
      }
      this.stage.render()
    }

    if ("say" in action) {
      panel.post({ type: "say", text: action.say })
      const ms = readingTime(action.say, timing.reading) / this.stage.speed()
      this.reading = true
      panel.post({ type: "reading", ms })
      this.stage.render()
      await this.stage.pacing.sleep(ms)
      this.reading = false
      this.stage.render()
      return ok
    }

    if ("move" in action) {
      const m = action.move
      const problem = moveProblem(m)
      if (problem) return fail("invalid_action", problem)
      const file = this.fileOf(m)
      if (!file) return fail("no_cursor", "Your cursor isn't in a file yet; give `file`.")
      if (!(await this.delay(timing.beforeMoveMs))) return { kind: "interrupted" }
      await editor.show(file)
      const at = m.at
      const where = await this.locate(file, m.line, "move", at === undefined ? undefined : (text) => spotCandidates(text, at))
      if ("kind" in where) return where
      const { text, line } = where
      let offset: number
      if (m.to === "line_end") offset = lineEnd(text, line)
      else {
        const r = resolveSpot(text, { at: m.at!, line })
        // A spot not on its line says what the line reads.
        if (!r.ok) return failed(r, file, text, r.kind === "not_found" ? [line] : [])
        offset = r.range.start
      }
      const near =
        !farBack &&
        s.cursor?.file === file &&
        Math.abs(position(text, s.cursor.offset).line - position(text, offset).line) <= timing.nearLines
      s.cursor = { file, offset }
      s.selection = null
      playing.moved = true
      this.stage.render()
      // The pause is after the move, so the programmer sees where the cursor went before anything happens there.
      await this.delay(near ? timing.afterMoveNearMs : timing.afterMoveFarMs)
      return ok
    }

    if ("select" in action) {
      const target = action.select
      const problem = spanProblem(target)
      if (problem) return fail("invalid_action", problem)
      const file = this.fileOf(target)
      if (!file) return fail("no_cursor", "Your cursor isn't in a file yet; give `file`.")
      if (!(await this.delay(timing.beforeSelectMs))) return { kind: "interrupted" }
      await editor.show(file)
      const span = await this.span(file, target, "select")
      if ("kind" in span) return span
      s.cursor = { file, offset: span.end }
      s.selection = { start: span.start, end: span.end }
      playing.moved = true
      this.stage.render()
      await this.delay(timing.afterSelectMs)
      return ok
    }

    if ("type" in action || "type_fast" in action) {
      const fast = "type_fast" in action
      const text: unknown = fast ? action.type_fast : action.type
      const problem = typeProblem(text)
      if (problem) return fail("invalid_action", problem)
      const [before, after] = (text as string).split(CURSOR_MARKER) as [string, string]
      return this.type(before, after, fast, playing)
    }

    if ("delete" in action) {
      if (!s.cursor || !s.selection) return fail("no_selection", "Nothing is selected; `select` first.")
      const { file } = s.cursor
      const { start, end } = s.selection
      playing.edited = true
      await editor.show(file)
      this.stage.lines.of(file, await editor.getText(file))
      this.clearPoint()
      s.cursor.offset = start
      s.selection = null
      this.touch(playing, file, start, end - start, 0)
      await this.edit(file, { offset: start, deleteLength: end - start, text: "" }, { undoStopBefore: true, undoStopAfter: true })
      this.stage.render()
      await this.delay(timing.afterDeleteMs)
      return ok
    }

    if ("point" in action) {
      const target = action.point
      const problem = spanProblem(target)
      if (problem) return fail("invalid_action", problem)
      const file = this.fileOf(target)
      if (!file) return fail("no_cursor", "Your cursor isn't in a file yet; give `file`.")
      if (s.turn === "agent") await editor.show(file)
      const span = await this.span(file, target, "point")
      if ("kind" in span) return span
      s.point = { file, start: span.start, end: span.end }
      const pointLine = position(span.text, span.start).line
      if (s.turn === "agent") {
        // The view goes to the pointed code, so the `say` about it plays while the programmer looks at it.
        const cursorLine = s.cursor?.file === file ? position(span.text, s.cursor.offset).line : undefined
        s.pointFar = cursorLine === undefined || Math.abs(cursorLine - pointLine) > timing.nearLines
        s.focus = "point"
      }
      editor.renderPoint(s.point)
      this.stage.render()
      panel.post({ type: "point", file: editor.displayPath(file), line: pointLine })
      await this.delay(timing.afterPointMs)
      return ok
    }

    if ("run" in action) return this.runCommand(action, playing)

    return fail("invalid_action", `Unknown action: ${JSON.stringify(action)}`)
  }

  private async runCommand(action: { run: string; wait?: number }, playing: Playing): Promise<Outcome> {
    const s = this.scene
    const { editor, panel } = this.stage
    const config = this.stage.config()
    const command = action.run
    if (typeof command !== "string" || command.trim() === "") return fail("invalid_action", "`run` needs a command.")
    // Commands read files from disk, so the batch's edits so far go there first.
    const unsaved = await this.save(playing)
    if (unsaved.length > 0) {
      const which = unsaved.map((u) => `${u.file} (${u.error})`).join(", ")
      return fail(
        "save_failed",
        `Couldn't save ${which}, so the command didn't run: it would read the old file from disk. Ask the programmer to resolve it in the editor, which offers to compare or overwrite, then run it again.`,
      )
    }
    const id = nextRunId++
    const signal = this.stage.pacing.signal

    if (config.confirmCommands && !s.allowedCommands.has(command)) {
      panel.post({ type: "run", id, command, phase: "confirm" })
      this.reading = true
      this.stage.render()
      const go = await this.stage.confirm(id, command)
      this.reading = false
      this.stage.render()
      if (!go || signal.aborted) {
        panel.post({ type: "run", id, command, phase: "declined" })
        if (signal.aborted) return { kind: "interrupted" }
        return fail("command_declined", "The programmer declined to run this command.")
      }
    }

    const requested = action.wait !== undefined ? action.wait * 1000 : config.runWaitMs
    const waitMs = Math.max(0, Math.min(config.maxRunWaitMs, requested))
    panel.post({ type: "run", id, command, phase: "running" })
    this.commandRunning = true
    this.stage.render()
    let outcome
    try {
      outcome = await editor.runCommand(command, { cwd: s.root ?? editor.resolvePath("."), waitMs, signal })
    } catch (e) {
      panel.post({ type: "run", id, command, phase: "declined" })
      throw e
    } finally {
      this.commandRunning = false
      this.stage.render()
    }
    if (outcome.notStarted) {
      panel.post({ type: "run", id, command, phase: "declined" })
      return { kind: "interrupted" }
    }

    const result: RunResult = { command, output: outcome.output }
    if (outcome.exitCode !== undefined && !outcome.running) result.exit_code = outcome.exitCode
    if (outcome.truncated) result.truncated = true
    if (outcome.running) result.running = true
    if (outcome.shell) result.shell = outcome.shell
    playing.runs.push(result)
    const phase = outcome.running ? "background" : "done"
    panel.post({ type: "run", id, command, phase, exitCode: result.exit_code })
    // The panel keeps showing it as running until it ends, whenever that is.
    if (outcome.running) {
      void outcome.exited?.then(
        (exitCode) => panel.post({ type: "run", id, command, phase: "exited", exitCode }),
        () => {},
      )
    }

    if (outcome.running && signal.aborted) return { kind: "interrupted", consumed: true }
    if (result.exit_code !== undefined && result.exit_code !== 0) {
      return { kind: "error", error: "command_failed", message: `The command exited with ${result.exit_code}.`, consumed: true }
    }
    return ok
  }

  /** Types `before`, then `after`, then steps back to between them: to where the text had its `▌`. */
  private async type(before: string, after: string, fast: boolean, playing: Playing): Promise<Outcome> {
    const s = this.scene
    const { editor } = this.stage
    if (!s.cursor) return fail("no_cursor", "Your cursor isn't in a file yet; `move` first.")
    const cursor = s.cursor
    playing.edited = true
    await editor.show(cursor.file)
    this.clearPoint()

    const doc = await editor.getText(cursor.file)
    this.stage.lines.of(cursor.file, doc)
    const eol = await editor.eol(cursor.file)
    const insertAt = s.selection ? s.selection.start : cursor.offset
    const { timing, random } = this.stage.config()
    const scale = fast ? timing.fastFactor : 1
    const chunks = planTyping(before + after, timing.type, isLineStart(doc, insertAt), random, scale)

    if (chunks.length === 0 && s.selection) chunks.push({ text: "", delay: 0 })
    let typed = ""
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!
      if (!(await this.delay(chunk.delay))) {
        if (typed === "") return { kind: "interrupted" }
        const rest =
          typed.length <= before.length
            ? before.slice(typed.length) + CURSOR_MARKER + after
            : CURSOR_MARKER + after.slice(typed.length - before.length)
        return { kind: "interrupted", rest: fast ? { type_fast: rest } : { type: rest } }
      }
      const insert = eol === "\n" ? chunk.text : chunk.text.replaceAll("\n", eol)
      const start = s.selection ? s.selection.start : cursor.offset
      const deleteLength = s.selection ? s.selection.end - s.selection.start : 0
      // Move the cursor before awaiting, so programmer edits arriving meanwhile transform the right position.
      cursor.offset = start + insert.length
      s.selection = null
      this.touch(playing, cursor.file, start, deleteLength, insert.length)
      await this.edit(cursor.file, { offset: start, deleteLength, text: insert }, {
        undoStopBefore: i === 0,
        undoStopAfter: i === chunks.length - 1,
      })
      typed += chunk.text
      this.stage.render()
    }
    if (after !== "") {
      // Into the pair just closed: a move within sight, so the same beat before it, and pause after,
      // as one. Interrupted, it still steps back: all of the text was typed.
      await this.delay(timing.beforeMoveMs * scale)
      cursor.offset -= eol === "\n" ? after.length : after.replaceAll("\n", eol).length
      this.stage.render()
      await this.delay(timing.afterMoveNearMs * scale)
    }
    return ok
  }

  /** Edits a file, which its lines' identities follow. */
  private edit(file: string, change: Change, options: { undoStopBefore: boolean; undoStopAfter: boolean }): Promise<void> {
    this.stage.lines.apply(file, change)
    return this.stage.editor.edit(file, change.offset, change.deleteLength, change.text, options)
  }

  /** The file an action names, or the cursor's. */
  private fileOf(target: { file?: string }): string | undefined {
    return target.file !== undefined ? this.resolvePath(target.file) : this.scene.cursor?.file
  }

  /**
   * The file an action names, if any, checked against the rest of its batch: a batch works in one
   * file, which it names before its first edit.
   */
  private names(action: Action, playing: Playing): string | undefined | Outcome {
    const target: unknown = "move" in action ? action.move : "select" in action ? action.select : "point" in action ? action.point : undefined
    const file = typeof target === "object" && target !== null && "file" in target ? target.file : undefined
    if (typeof file !== "string") return undefined
    const path = this.resolvePath(file)
    if (playing.named !== undefined && path !== playing.named) {
      return fail(
        "invalid_action",
        `A batch works in one file, but this one names ${this.displayPath(playing.named)} and ${this.displayPath(path)}. Start a new batch where it switches files.`,
      )
    }
    if (playing.named === undefined && playing.edited) {
      return fail(
        "invalid_action",
        "A batch works in one file: name it (in `move`, `select` or `point`) before the batch's first edit. Start a new batch where it switches files.",
      )
    }
    playing.named = path
    return path
  }

  /**
   * The line an action goes to, in `file`: `line`, exactly, if it's a line the agent was shown
   * there, or the cursor's line. `find`: where the text the action looks for is, to list it if the
   * line isn't one the agent knows; none for the end of a line.
   */
  private async locate(
    file: string,
    line: number | undefined,
    action: string,
    find: ((text: string) => Candidate[]) | undefined,
  ): Promise<{ text: string; line: number } | Outcome> {
    const s = this.scene
    const text = await this.stage.editor.getText(file)
    if (line === undefined) {
      // The cursor's line, which may be the empty one after a final newline, if it's there.
      if (s.cursor?.file !== file) return fail("invalid_action", `Give \`line\`: without it, a \`${action}\` is on your cursor's line, in its file.`)
      return { text, line: position(text, s.cursor.offset).line }
    }
    // An empty file has one line, the empty one; a newline at the end doesn't start another.
    const lines = Math.max(1, fileLines(text).lines.length)
    if (line > lines) {
      const has = lines === 1 ? "1 line" : `${lines} lines`
      return fail("no_line", `There's no line ${line}: ${this.displayPath(file)} has ${has}.`)
    }
    return this.unseen(file, text, line, action === "move" ? "the spot" : "the text", find) ?? { text, line }
  }

  /** The code a `select` or `point` takes, in `file`. */
  private async span(file: string, target: SpanTarget, action: string): Promise<{ text: string; start: number; end: number } | Outcome> {
    const find = target.text ?? target.from!
    const where = await this.locate(file, target.line, action, (text) => spanCandidates(text, find))
    if ("kind" in where) return where
    const { text, line } = where
    const r = resolveSpan(text, { ...target, line })
    // Code not on its line says what the line reads.
    if (!r.ok) return failed(r, file, text, r.kind === "not_found" && r.candidates ? [line] : [])
    return { text, ...r.range }
  }

  /**
   * An action on a line whose number the agent may have worked out instead of being shown, if it
   * isn't one it knows. Says what the line reads now, and where what it looks for is, which it's
   * shown then. An empty file's one line needs no showing.
   */
  private unseen(file: string, text: string, line: number, what: string, find: ((text: string) => Candidate[]) | undefined): Outcome | undefined {
    const { knows, lines } = this.stage
    if (!knows || text === "" || knows(file, line, lines.of(file, text)[line - 1]!)) return undefined
    const candidates = find?.(text) ?? []
    const reads = `line ${line} reads ${JSON.stringify(lineText(text, line))}`
    const where = !find ? "." : candidates.length > 0 ? `, and ${what} is on these lines:` : `, and ${what} isn't anywhere in the file.`
    const outcome: Outcome = {
      kind: "error",
      error: "line_not_seen",
      message: `You haven't seen line ${line} of ${this.displayPath(file)} in an up-to-date \`read\` or report, so its number may be off: take line numbers from them, never work them out. Now, ${reads}${where}`,
      sighting: { file, text, lines: [line, ...candidates.map((c) => c.line)] },
    }
    if (candidates.length > 0) outcome.candidates = candidates
    return outcome
  }

  /** Saves the files the batch has edited, so tools reading from disk see them; returns the ones it couldn't. */
  private async save(playing: Playing): Promise<{ file: string; error: string }[]> {
    const unsaved: { file: string; error: string }[] = []
    for (const file of playing.touched) {
      try {
        await this.stage.editor.save(file)
      } catch (e) {
        unsaved.push({ file: this.displayPath(file), error: e instanceof Error ? e.message : String(e) })
      }
    }
    return unsaved
  }

  private clearPoint(): void {
    if (!this.scene.point) return
    this.scene.point = null
    this.stage.editor.renderPoint(null)
  }

  /** Records an edit of the batch: the file to save, and the text it changed for the report. */
  private touch(p: Playing, file: string, start: number, removed: number, inserted: number): void {
    p.touched.add(file)
    const map = (pos: number): number => {
      if (pos <= start) return pos
      if (pos >= start + removed) return pos + inserted - removed
      return start + inserted
    }
    const span = p.span?.file === file ? p.span : undefined
    p.span = span
      ? { file, start: Math.min(map(span.start), start), end: Math.max(map(span.end), start + inserted) }
      : { file, start, end: start + inserted }
  }

  private resolvePath(file: string): string {
    return agentPath(this.stage.editor, this.scene.root, file)
  }

  private displayPath(file: string): string {
    return displayPath(this.stage.editor, this.scene.root, file)
  }
}
