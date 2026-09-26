// The protocol state machine: sessions, the batch queue, playback, and reports.
// See PROTOCOL.md for the rules implemented here.

import type {
  Action,
  Anchor,
  BatchResult,
  Candidate,
  Code,
  ErrorKind,
  Event,
  Excerpt,
  FileContent,
  Report,
  RunResult,
  Turn,
  TypeText,
} from "@ai-pair/protocol"
import * as nodePath from "node:path"
import { actionKinds, CURSOR_MARKER, moveProblem, ToolError } from "@ai-pair/protocol"
import { resolveSpan, resolveSpot, type Resolution } from "./anchors"
import { fileDiff } from "./diff"
import type { AgentState, Change, CursorView, EditorPort, Focus, PanelPort, Ref, SharedSelection } from "./ports"
import { isLineStart, lineEnd, position, splitLines } from "./text"
import { Timeline } from "./timeline"
import { defaultTiming, withOverrides, type Timing, type TimingOverrides } from "./timing"
import { planTyping, readingTime } from "./typing"

export type Config = {
  maxBlockMs: number
  /** During the programmer's turn, how long after their last edit `listen` returns. */
  navigatorIdleMs: number
  timing: Timing
  random: () => number
  /** Ask the programmer before each `run`. */
  confirmCommands: boolean
  /** How long a `run` waits for its command by default, and at most. */
  runWaitMs: number
  maxRunWaitMs: number
}

export const defaultConfig: Config = {
  maxBlockMs: 45_000,
  navigatorIdleMs: 3000,
  timing: defaultTiming,
  random: Math.random,
  confirmCommands: true,
  runWaitMs: 120_000,
  maxRunWaitMs: 600_000,
}

type Batch = {
  id: number
  actions: Action[]
  state: "queued" | "playing" | "done"
  result?: BatchResult
}

/** Like `Event`, but edits usually get their diff when the report is taken. */
type PendingEvent = Exclude<Event, { kind: "edit" }> | { kind: "edit"; file: string; diff?: string }

type Session = {
  task?: string
  /** The agent's working directory, if it gave one: paths to and from the agent are relative to it. */
  root?: string
  turn: Turn
  /** Batches not yet finished; the head may be playing. */
  queue: Batch[]
  /** Finished batches not yet reported. */
  finished: BatchResult[]
  events: PendingEvent[]
  /** An unreported interruption or failure: new batches are discarded. */
  stale: boolean
  /** Text of each file edited by the programmer, as of the last report. */
  baselines: Map<string, string>
  latest: Map<string, string>
  cursor: { file: string; offset: number } | null
  selection: { start: number; end: number } | null
  point: { file: string; start: number; end: number } | null
  /** What the view follows: the cursor, or, right after a `point`, the pointed code. */
  focus: Focus
  /** The pointed code is in another file than the cursor, or far from it: looking back changes the view. */
  pointFar: boolean
  timeline: Timeline
  running: boolean
  reading: boolean
  /** A `run` whose command is executing. */
  commandRunning: boolean
  /** A `run` waiting for the programmer's go-ahead. */
  confirming?: { id: number; command: string; decide: (run: boolean) => void }
  /** Commands the programmer allowed to run without asking, until the session ends. */
  allowedCommands: Set<string>
  /** Ended by the programmer; the final report hasn't been delivered yet. */
  ended: boolean
  navigatorReady: boolean
  navigatorTimer?: ReturnType<typeof setTimeout>
  playing?: Playing
  /** The cursor's line as the agent last saw it in a report, so reports only show it when it changed. */
  seenCursor?: string
}

type Call = {
  kind: "step" | "listen" | "end"
  batch?: Batch
  summary?: string
  timer: ReturnType<typeof setTimeout>
  resolve: (report: Report) => void
  reject: (error: unknown) => void
}

/**
 * `consumed`: the action took effect, so it counts as played and isn't returned as unplayed.
 * `rest`: the action took effect in part; this is what's left of it.
 */
type Outcome =
  | { kind: "ok" }
  | { kind: "interrupted"; rest?: Action; consumed?: boolean }
  | { kind: "error"; error: ErrorKind; message: string; candidates?: Candidate[]; consumed?: boolean }

/** The batch being played: what it touched, for saving and for its report's code. */
type Playing = {
  touched: Set<string>
  runs: RunResult[]
  /** The text its edits changed, tracked through later edits. */
  span?: { file: string; start: number; end: number }
  moved: boolean
}

/** A report's code longer than this skips lines in the middle. */
const MAX_CODE_LINES = 40

const ok: Outcome = { kind: "ok" }

const cancelled = () => new ToolError("cancelled", "The call was cancelled.")

function fail(error: ErrorKind, message: string): Outcome {
  return { kind: "error", error, message }
}

function failed(r: Resolution & { ok: false }): Outcome {
  return { kind: "error", error: r.kind, message: r.message, candidates: r.candidates }
}

export class Controller {
  private session: Session | null = null
  private call: Call | null = null
  private chain: Promise<unknown> = Promise.resolve()
  private nextBatchId = 1
  private pauseReasons = new Set<string>()
  private speed = 1
  private lastPosted = ""
  private nextRunId = 1

  constructor(
    private readonly editor: EditorPort,
    private readonly panel: PanelPort,
    private config: Config = defaultConfig,
  ) {}

  // ---- Tools -------------------------------------------------------------

  start(task?: string, root?: string): Promise<Report> {
    return this.serialize(undefined, async () => {
      if (this.session && !this.session.ended) {
        throw new ToolError("session_active", "A pairing session is already active in this window.")
      }
      const s: Session = {
        task,
        // In the editor's spelling, so paths inside it are reported relative to it.
        root: root && this.editor.resolvePath(root),
        turn: "agent",
        queue: [],
        finished: [],
        events: [],
        stale: false,
        baselines: new Map(),
        latest: new Map(),
        cursor: null,
        selection: null,
        point: null,
        focus: "cursor",
        pointFar: false,
        timeline: new Timeline(this.pauseReasons.size > 0),
        running: false,
        reading: false,
        commandRunning: false,
        allowedCommands: new Set(),
        ended: false,
        navigatorReady: false,
      }
      this.session = s
      this.lastPosted = ""
      this.panel.post({ type: "session", active: true, task })
      this.render()
      return { batches: [], events: [], turn: s.turn }
    })
  }

  step(actions: Action[], signal?: AbortSignal): Promise<Report> {
    return this.serialize(signal, () => {
      const s = this.requireSession()
      // An empty batch only waits for the queued ones, so it isn't a batch of its own.
      if (actions.length === 0) return this.block("step", {}, signal)
      this.checkOneFile(s, actions)
      const batch: Batch = { id: this.nextBatchId++, actions, state: "queued" }
      if (s.stale || s.ended) {
        this.discard(s, batch)
      } else {
        s.queue.push(batch)
        this.kick(s)
      }
      return this.block("step", { batch }, signal)
    })
  }

  listen(signal?: AbortSignal): Promise<Report> {
    return this.serialize(signal, () => {
      this.requireSession()
      return this.block("listen", {}, signal)
    })
  }

  end(summary?: string, signal?: AbortSignal): Promise<Report> {
    return this.serialize(signal, () => {
      this.requireSession()
      return this.block("end", { summary }, signal)
    })
  }

  read(file: string, fromLine?: number, toLine?: number): Promise<FileContent> {
    const s = this.requireSession()
    const path = this.resolvePath(s, file)
    return (async () => {
      const lines = splitLines(await this.editor.getText(path))
      const from = Math.max(1, fromLine ?? 1)
      const to = Math.min(lines.length, toLine ?? lines.length)
      return {
        file: this.displayPath(s, path),
        dirty: await this.editor.isDirty(path),
        lines: lines.slice(from - 1, to).map((text, i) => ({ number: from + i, text })),
      }
    })()
  }

  /**
   * Puts a report back to be delivered again. For a report that raced with a cancellation: the
   * call returned just before the cancellation arrived, so the agent never saw the report.
   */
  restore(report: Report): void {
    const s = this.activeSession()
    if (!s) return
    s.finished.unshift(...report.batches)
    s.events.unshift(...report.events)
    if (report.events.length > 0 || report.batches.some((b) => b.status !== "completed")) s.stale = true
    this.update()
  }

  // ---- Programmer input --------------------------------------------------

  /** `selection`: code the programmer had selected, sent along with the message. */
  userMessage(text: string, selection?: SharedSelection): void {
    const s = this.activeSession()
    if (!s) return
    s.events.push(selection ? { kind: "message", text, selection: this.excerpt(s, selection) } : { kind: "message", text })
    this.panel.post({ type: "user", text, ref: selection && this.ref(selection) })
    this.interrupt(s)
    this.update()
  }

  userInterrupt(): void {
    const s = this.activeSession()
    if (!s) return
    s.events.push({ kind: "interrupt" })
    this.panel.post({ type: "interrupt" })
    this.interrupt(s)
    this.update()
  }

  /** A change the programmer made. `changes` are applied in order, each to the result of the previous. */
  userEdit(file: string, before: string, after: string, changes: Change[]): void {
    const s = this.activeSession()
    if (!s) return
    for (const change of changes) this.transformPositions(s, file, change)
    if (!s.baselines.has(file)) {
      s.baselines.set(file, before)
      s.events.push({ kind: "edit", file })
    }
    s.latest.set(file, after)
    if (s.turn === "agent") {
      this.interrupt(s)
    } else {
      clearTimeout(s.navigatorTimer)
      s.navigatorTimer = setTimeout(() => {
        s.navigatorReady = true
        this.pump()
      }, this.config.navigatorIdleMs)
    }
    this.update()
  }

  takeTurn(): void {
    const s = this.activeSession()
    if (!s || s.turn === "user") return
    s.turn = "user"
    s.focus = "cursor"
    s.events.push({ kind: "turn", to: "user" })
    this.panel.post({ type: "turn", to: "user" })
    this.interrupt(s)
    this.update()
  }

  handBack(message?: string, selection?: SharedSelection): void {
    const s = this.activeSession()
    if (!s || s.turn === "agent") return
    s.turn = "agent"
    clearTimeout(s.navigatorTimer)
    const event: Event = { kind: "turn", to: "agent" }
    if (message) event.message = message
    if (selection) event.selection = this.excerpt(s, selection)
    s.events.push(event)
    this.panel.post({ type: "turn", to: "agent", message, ref: selection && this.ref(selection) })
    this.interrupt(s)
    this.update()
  }

  endSession(): void {
    const s = this.activeSession()
    if (!s) return
    s.ended = true
    s.events.push({ kind: "end" })
    this.interrupt(s)
    this.panel.post({ type: "session", active: false, reason: "user" })
    this.update()
  }

  /** The agent is gone (the relay disconnected). */
  disconnect(): void {
    const s = this.session
    if (this.call) {
      clearTimeout(this.call.timer)
      this.call.reject(new ToolError("no_session", "Disconnected."))
      this.call = null
    }
    if (!s) return
    this.close(s)
    if (!s.ended) this.panel.post({ type: "session", active: false, reason: "disconnected" })
  }

  pause(reason = "user"): void {
    this.pauseReasons.add(reason)
    this.session?.timeline.pause()
    this.render()
  }

  /** Removes one pause reason, or all of them. Playback continues when none are left. */
  resume(reason?: string): void {
    if (this.pauseReasons.size === 0) return
    if (reason === undefined) this.pauseReasons.clear()
    else this.pauseReasons.delete(reason)
    if (this.pauseReasons.size > 0) return
    const s = this.session
    if (s) {
      if (s.turn === "agent" && (s.cursor || s.point)) this.editor.reveal()
      s.timeline.resume()
    }
    this.render()
  }

  setSpeed(speed: number): void {
    this.speed = speed
  }

  setConfirmCommands(confirm: boolean): void {
    this.config = { ...this.config, confirmCommands: confirm }
  }

  /**
   * The programmer's answer to a `run` waiting for confirmation. `remember`: run exactly this
   * command without asking for the rest of the session.
   */
  decideRun(id: number, run: boolean, remember = false): void {
    const s = this.session
    const c = s?.confirming
    if (c?.id !== id) return
    if (run && remember) s!.allowedCommands.add(c.command)
    c.decide(run)
  }

  /** Calibration: overrides on top of the default timing. */
  setTiming(overrides: TimingOverrides): void {
    this.config = { ...this.config, timing: withOverrides(defaultTiming, overrides) }
  }

  get isActive(): boolean {
    return this.activeSession() !== null
  }

  get isPaused(): boolean {
    return this.pauseReasons.size > 0
  }

  get turn(): Turn | null {
    return this.activeSession()?.turn ?? null
  }

  // ---- Calls and reports -------------------------------------------------

  /** Runs tool calls one at a time. A call cancelled while waiting its turn never runs. */
  private serialize<T>(signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
    const guarded = () => (signal?.aborted ? Promise.reject(cancelled()) : fn())
    const run = this.chain.then(guarded, guarded)
    this.chain = run.catch(() => {})
    return run
  }

  /** A batch edits one file: it names at most one (in `move` or `point`), and only before its first edit. */
  private checkOneFile(s: Session, actions: Action[]): void {
    let named: string | undefined
    let edited = false
    for (const action of actions) {
      // A malformed action fails when it plays, with its own error.
      if (typeof action !== "object" || action === null || actionKinds(action).length !== 1) continue
      if ("type" in action || "type_fast" in action || "delete" in action) edited = true
      const target: unknown = "move" in action ? action.move : "point" in action ? action.point : undefined
      const file = typeof target === "object" && target !== null && "file" in target ? target.file : undefined
      if (typeof file !== "string") continue
      const path = this.resolvePath(s, file)
      if (named !== undefined && path !== named) {
        throw new ToolError(
          "invalid_arguments",
          `A batch works in one file, but this one names ${this.displayPath(s, named)} and ${this.displayPath(s, path)}. Start a new batch where it switches files.`,
        )
      }
      if (named === undefined && edited) {
        throw new ToolError(
          "invalid_arguments",
          "A batch works in one file: name it (in `move` or `point`) before the batch's first edit. Start a new batch where it switches files.",
        )
      }
      named = path
    }
  }

  private requireSession(): Session {
    if (!this.session) {
      throw new ToolError("no_session", "No pairing session is active. Call `start` to begin one.")
    }
    return this.session
  }

  private activeSession(): Session | null {
    return this.session && !this.session.ended ? this.session : null
  }

  /**
   * Blocks until the call is ready to report. Cancelling releases the call without taking a
   * report, so nothing is lost: a submitted batch stays queued and is reported on the next call.
   */
  private block(kind: Call["kind"], opts: { batch?: Batch; summary?: string }, signal?: AbortSignal): Promise<Report> {
    return new Promise((resolve, reject) => {
      const call: Call = {
        kind,
        ...opts,
        resolve,
        reject,
        timer: setTimeout(() => this.finishCall(true), this.config.maxBlockMs),
      }
      this.call = call
      signal?.addEventListener("abort", () => {
        if (this.call !== call) return
        this.call = null
        clearTimeout(call.timer)
        reject(cancelled())
        this.render()
      })
      this.update()
    })
  }

  private ready(call: Call, s: Session): boolean {
    if (s.ended) return true
    // An interrupted batch finishes promptly; wait for it, so the report says what was typed.
    if (s.queue[0]?.state === "playing" && s.timeline.isInterrupted) return false
    switch (call.kind) {
      case "step":
        if (!call.batch) return s.queue.length === 0
        return call.batch.state === "done" || s.queue[0] === call.batch
      case "end":
        return s.queue.length === 0
      case "listen":
        if (s.finished.some((r) => r.status !== "completed")) return true
        if (s.queue.length > 0) return false
        if (s.turn === "agent") return s.events.length > 0
        return s.events.some((e) => e.kind !== "edit") || (s.navigatorReady && s.events.length > 0)
    }
  }

  private pump(): void {
    const call = this.call
    const s = this.session
    if (call && s && this.ready(call, s)) this.finishCall(false)
  }

  private finishCall(timedOut: boolean): void {
    const call = this.call
    if (!call) return
    this.call = null
    clearTimeout(call.timer)
    const s = this.session
    if (!s) {
      call.reject(new ToolError("no_session", "The session has ended."))
      return
    }
    const closing = s.ended || call.kind === "end"
    const report = this.snapshot(s, call, timedOut && !closing)
    if (closing) {
      this.close(s)
      if (call.kind === "end" && !s.ended) {
        this.panel.post({ type: "session", active: false, reason: "agent", summary: call.summary })
      }
    }
    this.render()
    void this.withCursor(s, report).then(call.resolve, () => call.resolve(report))
  }

  /** Adds the cursor's line to the report, unless it's where the agent last saw it, in a report's code or cursor. */
  private async withCursor(s: Session, report: Report): Promise<Report> {
    for (const b of report.batches) {
      const line = b.code?.lines.find((l) => l.text.includes(CURSOR_MARKER))
      if (b.code && line) s.seenCursor = `${b.code.file}:${line.number}:${line.text}`
    }
    if (!s.cursor) return report
    const cursor = await this.code(s, { touched: new Set(), runs: [], moved: true })
    const line = cursor?.lines[0]
    if (!cursor || !line) return report
    const key = `${cursor.file}:${line.number}:${line.text}`
    if (key === s.seenCursor) return report
    s.seenCursor = key
    return { ...report, cursor }
  }

  private snapshot(s: Session, call: Call, waiting: boolean): Report {
    const batches = s.finished.sort((a, b) => a.id - b.id)
    const events: Event[] = []
    for (const e of s.events) {
      if (e.kind !== "edit") {
        events.push(e)
        continue
      }
      if (e.diff !== undefined) {
        events.push({ kind: "edit", file: e.file, diff: e.diff })
        continue
      }
      const before = s.baselines.get(e.file) ?? ""
      const after = s.latest.get(e.file) ?? before
      if (before === after) continue
      const file = this.displayPath(s, e.file)
      events.push({ kind: "edit", file, diff: fileDiff(file, before, after) })
    }
    s.finished = []
    s.events = []
    s.baselines = new Map()
    s.latest = new Map()
    s.stale = false
    s.navigatorReady = false

    const report: Report = { batches, events, turn: s.turn }
    const b = call.batch
    if (b && b.state !== "done") report.submitted = { id: b.id, status: b.state }
    if (waiting) report.waiting = true
    return report
  }

  /** The lines the batch changed, extended to the cursor's line, with the cursor marked. */
  private async code(s: Session, p: Playing): Promise<Code | undefined> {
    const file = p.span?.file ?? (p.moved ? s.cursor?.file : undefined)
    if (!file) return undefined
    const text = await this.editor.getText(file)
    const lines = splitLines(text)
    const at = s.cursor?.file === file ? position(text, s.cursor.offset) : undefined
    let from = at?.line ?? Infinity
    let to = at?.line ?? -Infinity
    if (p.span) {
      // Text ending with a newline changed the lines up to it, not the one after.
      const end = p.span.end > p.span.start && isLineStart(text, p.span.end) ? p.span.end - 1 : p.span.end
      from = Math.min(from, position(text, p.span.start).line)
      to = Math.max(to, position(text, end).line)
    }
    const numbers: number[] = []
    for (let n = from; n <= to; n++) {
      const long = to - from + 1 > MAX_CODE_LINES
      if (!long || n < from + MAX_CODE_LINES / 2 || n > to - MAX_CODE_LINES / 2 || n === at?.line) numbers.push(n)
    }
    return {
      file: this.displayPath(s, file),
      lines: numbers.map((n) => {
        const line = lines[n - 1] ?? ""
        if (n !== at?.line) return { number: n, text: line }
        return { number: n, text: line.slice(0, at.column - 1) + CURSOR_MARKER + line.slice(at.column - 1) }
      }),
    }
  }

  private close(s: Session): void {
    if (this.session === s) this.session = null
    s.timeline.interrupt()
    clearTimeout(s.navigatorTimer)
    this.editor.renderPoint(null)
    this.render()
  }

  // ---- Queue ---------------------------------------------------------------

  private discard(s: Session, batch: Batch): void {
    batch.state = "done"
    batch.result = { id: batch.id, status: "discarded", unplayed: batch.actions }
    s.finished.push(batch.result)
  }

  /** Stops playback and discards everything queued behind it. */
  private interrupt(s: Session): void {
    s.stale = true
    for (const b of s.queue) if (b.state === "queued") this.discard(s, b)
    s.queue = s.queue.filter((b) => b.state !== "done")
    s.timeline.interrupt()
  }

  private update(): void {
    this.render()
    this.pump()
  }

  // ---- Playback ------------------------------------------------------------

  private kick(s: Session): void {
    if (!s.running) void this.run(s)
  }

  private async run(s: Session): Promise<void> {
    s.running = true
    try {
      while (this.session === s) {
        const batch = s.queue[0]
        if (!batch) break
        this.startHead(s)
        this.render()
        const playing: Playing = { touched: new Set(), runs: [], moved: false }
        s.playing = playing
        const result = await this.play(s, batch, playing)
        s.playing = undefined
        if (playing.runs.length > 0) result.runs = playing.runs
        if (result.status !== "discarded") {
          try {
            const code = await this.code(s, playing)
            if (code) result.code = code
          } catch {
            // The file is gone; the report just can't show it.
          }
        }
        for (const file of playing.touched) {
          try {
            await this.editor.save(file)
          } catch {
            // Saving is best effort; the buffer is still the truth.
          }
        }
        if (this.session !== s) break
        batch.state = "done"
        batch.result = result
        s.queue = s.queue.filter((b) => b !== batch)
        s.finished.push(result)
        if (result.status !== "completed") this.interrupt(s)
        // Mark the next batch as playing before reporting, so the report says so.
        this.startHead(s)
        this.update()
      }
    } finally {
      s.running = false
    }
  }

  private startHead(s: Session): void {
    const head = s.queue[0]
    if (head?.state !== "queued") return
    head.state = "playing"
    s.timeline.reset()
  }

  private async play(s: Session, batch: Batch, playing: Playing): Promise<BatchResult> {
    const { id, actions } = batch
    for (let i = 0; i < actions.length; i++) {
      if (s.timeline.isInterrupted) return this.stopped(batch, actions.slice(i), i > 0)
      let outcome: Outcome
      try {
        outcome = await this.perform(s, actions[i]!, playing)
      } catch (e) {
        outcome = fail("invalid_action", e instanceof Error ? e.message : String(e))
      }
      const rest = actions.slice(i + 1)
      if (outcome.kind === "interrupted") {
        if (outcome.consumed) return this.stopped(batch, rest, true)
        if (outcome.rest) return this.stopped(batch, [outcome.rest, ...rest], true)
        return this.stopped(batch, actions.slice(i), i > 0)
      }
      if (outcome.kind === "error") {
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
  private stopped(batch: Batch, unplayed: Action[], effect: boolean): BatchResult {
    const result: BatchResult = { id: batch.id, status: effect ? "interrupted" : "discarded" }
    if (unplayed.length > 0) result.unplayed = unplayed
    return result
  }

  private delay(s: Session, ms: number): Promise<boolean> {
    return s.timeline.sleep(ms / this.speed)
  }

  private async perform(s: Session, action: Action, playing: Playing): Promise<Outcome> {
    const kinds = actionKinds(action)
    if (kinds.length > 1) {
      return fail("invalid_action", `One action per object, got ${kinds.map((k) => `\`${k}\``).join(" and ")}: make them separate actions, in order.`)
    }
    if (s.turn === "user" && !("say" in action) && !("point" in action)) {
      return fail("not_your_turn", "During the programmer's turn, only `say` and `point` are allowed.")
    }

    // An action at the cursor brings the view back to it from the code last pointed at. A far jump
    // back gets a far move's pause, before anything happens there; a `move` has its own.
    const cursorAction = !("say" in action) && !("point" in action) && !("run" in action)
    const lookingBack = cursorAction && s.focus === "point"
    const farBack = lookingBack && s.pointFar
    if (lookingBack) {
      s.focus = "cursor"
      if (farBack && !("move" in action) && s.cursor) {
        await this.editor.show(s.cursor.file)
        this.render()
        if (!(await this.delay(s, this.config.timing.afterMoveFarMs))) return { kind: "interrupted" }
      }
      this.render()
    }

    if ("say" in action) {
      this.panel.post({ type: "say", text: action.say })
      const ms = readingTime(action.say, this.config.timing.reading) / this.speed
      s.reading = true
      this.panel.post({ type: "reading", ms })
      this.render()
      await s.timeline.sleep(ms)
      s.reading = false
      this.render()
      return ok
    }

    if ("move" in action) {
      const m = action.move
      const problem = moveProblem(m)
      if (problem) return fail("invalid_action", problem)
      const file = m.file !== undefined ? this.resolvePath(s, m.file) : s.cursor?.file
      if (!file) return fail("no_file", "The agent cursor isn't in a file yet; give `file`.")
      const relative = m.lines !== undefined || m.to === "end"
      if (relative && s.cursor?.file !== file) {
        return fail("no_file", "`lines` and `to: \"end\"` move relative to your cursor, in its file.")
      }
      const t = this.config.timing
      if (!(await this.delay(s, t.beforeMoveMs))) return { kind: "interrupted" }
      await this.editor.show(file)
      const text = await this.editor.getText(file)
      let offset: number
      if (relative) {
        const line = position(text, s.cursor!.offset).line + (m.lines ?? 0)
        offset = lineEnd(text, Math.max(1, Math.min(splitLines(text).length, line)))
      } else if (m.to === "file_end") offset = text.length
      else if (m.before === undefined || m.after === undefined) offset = 0
      else {
        const r = resolveSpot(text, { before: m.before, after: m.after, near_line: m.near_line })
        if (!r.ok) return failed(r)
        offset = r.range.start
      }
      const near =
        !farBack &&
        s.cursor?.file === file &&
        Math.abs(position(text, s.cursor.offset).line - position(text, offset).line) <= t.nearLines
      s.cursor = { file, offset }
      s.selection = null
      playing.moved = true
      this.render()
      // The pause is after the move, so the programmer sees where the cursor went before anything happens there.
      await this.delay(s, near ? t.afterMoveNearMs : t.afterMoveFarMs)
      return ok
    }

    if ("select" in action) {
      if (!s.cursor) return fail("no_file", "The agent cursor isn't in a file yet; `move` first.")
      if (!(await this.delay(s, this.config.timing.beforeSelectMs))) return { kind: "interrupted" }
      await this.editor.show(s.cursor.file)
      const r = resolveSpan(await this.editor.getText(s.cursor.file), action.select)
      if (!r.ok) return failed(r)
      s.selection = r.range
      s.cursor.offset = r.range.end
      playing.moved = true
      this.render()
      await this.delay(s, this.config.timing.afterSelectMs)
      return ok
    }

    if ("type" in action || "type_fast" in action) {
      const fast = "type_fast" in action
      const parts: unknown = fast ? action.type_fast : action.type
      if (!Array.isArray(parts) || parts.length !== 2 || !parts.every((p) => typeof p === "string")) {
        return fail("invalid_action", "Give the text to type as two parts, `[before, after]`: the cursor ends between them.")
      }
      return this.type(s, parts as TypeText, fast, playing)
    }

    if ("delete" in action) {
      if (!s.cursor || !s.selection) return fail("no_selection", "Nothing is selected; `select` first.")
      const { file } = s.cursor
      const { start, end } = s.selection
      await this.editor.show(file)
      this.clearPoint(s)
      s.cursor.offset = start
      s.selection = null
      this.touch(playing, file, start, end - start, 0)
      await this.editor.edit(file, start, end - start, "", { undoStopBefore: true, undoStopAfter: true })
      this.render()
      await this.delay(s, this.config.timing.afterDeleteMs)
      return ok
    }

    if ("point" in action) {
      const p = action.point
      const file = p.file !== undefined ? this.resolvePath(s, p.file) : s.cursor?.file
      if (!file) return fail("no_file", "The agent cursor isn't in a file yet; give `file`.")
      if (s.turn === "agent") await this.editor.show(file)
      const text = await this.editor.getText(file)
      const r = resolveSpan(text, p)
      if (!r.ok) return failed(r)
      s.point = { file, ...r.range }
      if (s.turn === "agent") {
        // The view goes to the pointed code, so the `say` about it plays while the programmer looks at it.
        const cursorLine = s.cursor?.file === file ? position(text, s.cursor.offset).line : undefined
        const pointLine = position(text, r.range.start).line
        s.pointFar = cursorLine === undefined || Math.abs(cursorLine - pointLine) > this.config.timing.nearLines
        s.focus = "point"
      }
      this.editor.renderPoint(s.point)
      this.render()
      this.panel.post({ type: "point", file: this.editor.displayPath(file), line: position(text, r.range.start).line })
      await this.delay(s, this.config.timing.afterPointMs)
      return ok
    }

    if ("run" in action) return this.runCommand(s, action, playing)

    return fail("invalid_action", `Unknown action: ${JSON.stringify(action)}`)
  }

  private async runCommand(s: Session, action: { run: string; wait?: number }, playing: Playing): Promise<Outcome> {
    const command = action.run
    if (typeof command !== "string" || command.trim() === "") return fail("invalid_action", "`run` needs a command.")
    const id = this.nextRunId++
    const signal = s.timeline.signal

    if (this.config.confirmCommands && !s.allowedCommands.has(command)) {
      this.panel.post({ type: "run", id, command, phase: "confirm" })
      s.reading = true
      this.render()
      const go = await new Promise<boolean>((resolve) => {
        const abort = () => resolve(false)
        s.confirming = {
          id,
          command,
          decide: (run) => {
            signal.removeEventListener("abort", abort)
            resolve(run)
          },
        }
        signal.addEventListener("abort", abort, { once: true })
      })
      s.confirming = undefined
      s.reading = false
      this.render()
      if (!go || signal.aborted) {
        this.panel.post({ type: "run", id, command, phase: "declined" })
        if (signal.aborted) return { kind: "interrupted" }
        return fail("command_declined", "The programmer declined to run this command.")
      }
    }

    const requested = action.wait !== undefined ? action.wait * 1000 : this.config.runWaitMs
    const waitMs = Math.max(0, Math.min(this.config.maxRunWaitMs, requested))
    this.panel.post({ type: "run", id, command, phase: "running" })
    s.commandRunning = true
    this.render()
    let outcome
    try {
      outcome = await this.editor.runCommand(command, { cwd: s.root ?? this.editor.resolvePath("."), waitMs, signal })
    } catch (e) {
      this.panel.post({ type: "run", id, command, phase: "declined" })
      throw e
    } finally {
      s.commandRunning = false
      this.render()
    }
    if (outcome.notStarted) {
      this.panel.post({ type: "run", id, command, phase: "declined" })
      return { kind: "interrupted" }
    }

    const result: RunResult = { command, output: outcome.output }
    if (outcome.exitCode !== undefined && !outcome.running) result.exit_code = outcome.exitCode
    if (outcome.truncated) result.truncated = true
    if (outcome.running) result.running = true
    if (outcome.shell) result.shell = outcome.shell
    playing.runs.push(result)
    const phase = outcome.running ? "background" : "done"
    this.panel.post({ type: "run", id, command, phase, exitCode: result.exit_code })

    if (outcome.running && signal.aborted) return { kind: "interrupted", consumed: true }
    if (result.exit_code !== undefined && result.exit_code !== 0) {
      return { kind: "error", error: "command_failed", message: `The command exited with ${result.exit_code}.`, consumed: true }
    }
    return ok
  }

  /** Types `before`, then `after`, then steps back to between them. */
  private async type(s: Session, [before, after]: TypeText, fast: boolean, playing: Playing): Promise<Outcome> {
    if (!s.cursor) return fail("no_file", "The agent cursor isn't in a file yet; `move` first.")
    const cursor = s.cursor
    await this.editor.show(cursor.file)
    this.clearPoint(s)

    const doc = await this.editor.getText(cursor.file)
    const eol = await this.editor.eol(cursor.file)
    const insertAt = s.selection ? s.selection.start : cursor.offset
    const { timing } = this.config
    const scale = fast ? timing.fastFactor : 1
    const chunks = planTyping(before + after, timing.type, isLineStart(doc, insertAt), this.config.random, scale)

    if (chunks.length === 0 && s.selection) chunks.push({ text: "", delay: 0 })
    let typed = ""
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!
      if (!(await this.delay(s, chunk.delay))) {
        if (typed === "") return { kind: "interrupted" }
        const rest: TypeText =
          typed.length <= before.length ? [before.slice(typed.length), after] : ["", after.slice(typed.length - before.length)]
        return { kind: "interrupted", rest: fast ? { type_fast: rest } : { type: rest } }
      }
      const insert = eol === "\n" ? chunk.text : chunk.text.replaceAll("\n", eol)
      const start = s.selection ? s.selection.start : cursor.offset
      const deleteLength = s.selection ? s.selection.end - s.selection.start : 0
      // Move the cursor before awaiting, so programmer edits arriving meanwhile transform the right position.
      cursor.offset = start + insert.length
      s.selection = null
      this.touch(playing, cursor.file, start, deleteLength, insert.length)
      await this.editor.edit(cursor.file, start, deleteLength, insert, {
        undoStopBefore: i === 0,
        undoStopAfter: i === chunks.length - 1,
      })
      typed += chunk.text
      this.render()
    }
    if (after !== "") {
      // Into the pair just closed: a move within sight, so the same pause as one.
      cursor.offset -= eol === "\n" ? after.length : after.replaceAll("\n", eol).length
      this.render()
      await this.delay(s, timing.afterMoveNearMs * scale)
    }
    return ok
  }

  private clearPoint(s: Session): void {
    if (!s.point) return
    s.point = null
    this.editor.renderPoint(null)
  }

  private transformPositions(s: Session, file: string, change: Change): void {
    const map = (pos: number): number => {
      if (pos <= change.offset) return pos
      if (pos >= change.offset + change.deleteLength) return pos + change.text.length - change.deleteLength
      return change.offset + change.text.length
    }
    if (s.cursor?.file === file) s.cursor.offset = map(s.cursor.offset)
    if (s.cursor?.file === file && s.selection) {
      s.selection = { start: map(s.selection.start), end: map(s.selection.end) }
    }
    if (s.point?.file === file) s.point = { file, start: map(s.point.start), end: map(s.point.end) }
    const span = s.playing?.span
    if (span?.file === file) s.playing!.span = { file, start: map(span.start), end: map(span.end) }
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

  // ---- Shared selections ---------------------------------------------------

  private excerpt(s: Session, selection: SharedSelection): Excerpt {
    return { ...selection, file: this.displayPath(s, selection.file) }
  }

  private ref(selection: SharedSelection): Ref {
    return { file: this.editor.displayPath(selection.file), line: selection.from.line, endLine: selection.to.line }
  }

  // ---- Paths ---------------------------------------------------------------

  private resolvePath(s: Session, file: string): string {
    return this.editor.resolvePath(s.root ? nodePath.resolve(s.root, file) : file)
  }

  private displayPath(s: Session, file: string): string {
    if (!s.root) return this.editor.displayPath(file)
    const rel = nodePath.relative(s.root, file)
    return rel.startsWith("..") || nodePath.isAbsolute(rel) ? file : rel
  }

  // ---- Rendering -----------------------------------------------------------

  private cursorView(s: Session): CursorView | null {
    if (!s.cursor) return null
    return s.selection ? { ...s.cursor, selection: s.selection } : { ...s.cursor }
  }

  private state(): AgentState {
    const s = this.session
    if (!s || s.turn === "user") return "navigator"
    if (this.pauseReasons.size > 0) return "paused"
    if (s.queue.length > 0) return s.reading ? "read" : s.commandRunning ? "running" : "typing"
    return this.call?.kind === "listen" ? "listening" : "thinking"
  }

  private render(): void {
    const s = this.activeSession()
    const state = this.state()
    this.editor.renderCursor(s ? this.cursorView(s) : null, state, s?.focus ?? "cursor")
    if (!s) return
    const paused = this.pauseReasons.size > 0
    const key = `${state}/${s.turn}/${paused}`
    if (key === this.lastPosted) return
    this.lastPosted = key
    this.panel.post({ type: "state", state, turn: s.turn, paused })
  }
}
