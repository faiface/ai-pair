// The protocol state machine: sessions, the batch queue, and reports. Playing a batch is player.ts.
// See PROTOCOL.md for the rules implemented here.

import type { Action, BatchResult, Event, Excerpt, FileContent, Report, Turn } from "@ai-pair/protocol"
import { actionKinds, CURSOR_MARKER, ToolError } from "@ai-pair/protocol"
import { fileDiff } from "./diff"
import { LineIds, type Sighting } from "./lines"
import { agentPath, displayPath, Player, type Scene } from "./player"
import type { AgentState, Change, CursorView, EditorPort, PanelPort, Ref, SharedSelection } from "./ports"
import { followChange, rehearse, type Rehearsal } from "./rehearsal"
import { fileLines } from "./text"
import { Timeline } from "./timeline"
import { defaultTiming, withOverrides, type Timing, type TimingOverrides } from "./timing"

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
  /** What it leaves behind, played in memory when it was queued: where the next batch is rehearsed from. */
  after?: Rehearsal
}

/** Like `Event`, but edits usually get their diff when the report is taken. */
type PendingEvent = Exclude<Event, { kind: "edit" }> | EditEvent

/** `interrupted`: a change the programmer didn't make, to a file the playing or queued batches edit. */
type EditEvent = { kind: "edit"; file: string; by: "programmer" | "other"; diff?: string; interrupted?: true }

/** Everything interrupts, except changes the programmer didn't make to files no batch is going to edit. */
function interrupting(e: PendingEvent): boolean {
  return e.kind !== "edit" || e.by === "programmer" || e.interrupted === true
}

type Session = {
  task?: string
  scene: Scene
  player: Player
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
  timeline: Timeline
  running: boolean
  /** A `run` waiting for the programmer's go-ahead. */
  confirming?: { id: number; command: string; decide: (run: boolean) => void }
  /** Ended by the programmer; the final report hasn't been delivered yet. */
  ended: boolean
  navigatorReady: boolean
  navigatorTimer?: ReturnType<typeof setTimeout>
  /** The cursor's line as the agent last saw it in a report, so reports only show it when it changed. */
  seenCursor?: string
  /** The identities of the lines of the files in the editor. */
  lines: LineIds
  /** For each file, the line the agent was last shown at each number, by its identity. */
  seen: Map<string, Map<number, number>>
}

type Call = {
  kind: "step" | "listen" | "end"
  batch?: Batch
  summary?: string
  timer: ReturnType<typeof setTimeout>
  resolve: (report: Report) => void
  reject: (error: unknown) => void
}

const cancelled = () => new ToolError("cancelled", "The call was cancelled.")

export class Controller {
  private session: Session | null = null
  private call: Call | null = null
  private chain: Promise<unknown> = Promise.resolve()
  private nextBatchId = 1
  private pauseReasons = new Set<string>()
  private speed = 1
  private lastPosted = ""

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
      const scene: Scene = {
        // In the editor's spelling, so paths inside it are reported relative to it.
        root: root && this.editor.resolvePath(root),
        turn: "agent",
        cursor: null,
        selection: null,
        point: null,
        focus: "cursor",
        pointFar: false,
        allowedCommands: new Set(),
      }
      const timeline = new Timeline(this.pauseReasons.size > 0)
      const lines = LineIds.editor()
      const s: Session = {
        task,
        scene,
        player: new Player(scene, {
          editor: this.editor,
          panel: this.panel,
          pacing: timeline,
          config: () => this.config,
          speed: () => this.speed,
          render: () => this.render(),
          confirm: (id, command) => this.confirm(s, id, command),
          lines,
        }),
        queue: [],
        finished: [],
        events: [],
        stale: false,
        baselines: new Map(),
        latest: new Map(),
        timeline,
        running: false,
        ended: false,
        navigatorReady: false,
        lines,
        seen: new Map(),
      }
      this.session = s
      this.lastPosted = ""
      this.panel.post({ type: "session", active: true, task })
      this.render()
      return { batches: [], events: [], turn: scene.turn }
    })
  }

  step(actions: Action[], signal?: AbortSignal): Promise<Report> {
    return this.serialize(signal, async () => {
      const s = this.requireSession()
      // An empty batch only waits for the queued ones, so it isn't a batch of its own.
      if (actions.length === 0) return this.block("step", {}, signal)
      // Played in memory first, so what would fail is reported now, not when the batch plays.
      const rehearsal = s.stale || s.ended ? undefined : await this.rehearse(s, actions)
      // An interruption arriving meanwhile discards it, like any batch planned without knowing about it.
      const current = rehearsal && !s.stale && !s.ended
      if (current && rehearsal.result.status === "failed") return this.reject(s, actions, rehearsal)
      const batch: Batch = { id: this.nextBatchId++, actions, state: "queued", after: rehearsal?.after }
      if (current) {
        s.queue.push(batch)
        this.kick(s)
      } else {
        this.discard(s, batch)
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
      const planned = this.planned(s, path)
      const text = planned ?? (await this.editor.getText(path))
      const { lines, finalNewline } = fileLines(text)
      const from = Math.max(1, fromLine ?? 1)
      const to = Math.min(lines.length, toLine ?? lines.length)
      const numbers = Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i)
      // As the queued batches leave the file, if they edit it.
      this.saw(s, planned !== undefined ? s.queue.at(-1)!.after!.lines : s.lines, { file: path, text, lines: numbers })
      const content: FileContent = {
        file: this.displayPath(s, path),
        dirty: await this.editor.isDirty(path),
        lines: lines.slice(from - 1, to).map((text, i) => ({ number: from + i, text })),
      }
      if (to === lines.length) content.end = { final_newline: finalNewline }
      return content
    })()
  }

  /**
   * The text of a file as it will be once the queued batches have played, if they edit it: they
   * were played in memory when queued. Not after an interruption, which discards what they'd do.
   */
  private planned(s: Session, path: string): string | undefined {
    if (s.stale) return undefined
    return s.queue.at(-1)?.after?.texts.get(path)
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
    if (report.events.some(interrupting) || report.batches.some((b) => b.status !== "completed")) s.stale = true
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
    this.recordEdit(s, file, before, after, changes, "programmer")
    if (s.scene.turn === "agent") {
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

  /**
   * A change the programmer didn't make: by a tool, a formatter, or on disk. It interrupts if the
   * playing or queued batches edit the file, since they were planned against the text before it.
   * Otherwise it's just reported, and the queued rehearsals follow it.
   */
  otherEdit(file: string, before: string, after: string, changes: Change[]): void {
    const s = this.activeSession()
    if (!s) return
    const planned = s.queue.some((b) => b.after?.edits.has(file))
    // Before recordEdit moves the editor's line identities, which the rehearsals' start from.
    if (!planned) for (const b of s.queue) if (b.after) followChange(b.after, file, before, after, changes)
    this.recordEdit(s, file, before, after, changes, "other")
    if (planned) {
      const e = s.events.find((e): e is EditEvent => e.kind === "edit" && e.file === file && e.diff === undefined)
      if (e) e.interrupted = true
      this.interrupt(s)
    }
    this.update()
  }

  /** Edits to a file are reported as one diff, as the programmer's if any of them was. */
  private recordEdit(s: Session, file: string, before: string, after: string, changes: Change[], by: EditEvent["by"]): void {
    s.lines.of(file, before)
    for (const change of changes) {
      s.player.transform(file, change)
      s.lines.apply(file, change)
    }
    if (!s.baselines.has(file)) {
      s.baselines.set(file, before)
      s.events.push({ kind: "edit", file, by })
    } else if (by === "programmer") {
      const pending = s.events.find((e): e is EditEvent => e.kind === "edit" && e.file === file && e.diff === undefined)
      if (pending) pending.by = "programmer"
    }
    s.latest.set(file, after)
  }

  takeTurn(): void {
    const s = this.activeSession()
    if (!s || s.scene.turn === "user") return
    s.scene.turn = "user"
    s.scene.focus = "cursor"
    s.events.push({ kind: "turn", to: "user" })
    this.panel.post({ type: "turn", to: "user" })
    this.interrupt(s)
    this.update()
  }

  handBack(message?: string, selection?: SharedSelection): void {
    const s = this.activeSession()
    if (!s || s.scene.turn === "agent") return
    s.scene.turn = "agent"
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
      if (s.scene.turn === "agent" && (s.scene.cursor || s.scene.point)) this.editor.reveal()
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
    if (run && remember) s!.scene.allowedCommands.add(c.command)
    c.decide(run)
  }

  /** Waits for the programmer's answer to a `run`, or an interruption. */
  private confirm(s: Session, id: number, command: string): Promise<boolean> {
    const signal = s.timeline.signal
    return new Promise<boolean>((resolve) => {
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
    }).finally(() => {
      s.confirming = undefined
    })
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
    return this.activeSession()?.scene.turn ?? null
  }

  // ---- Calls and reports -------------------------------------------------

  /** Runs tool calls one at a time. A call cancelled while waiting its turn never runs. */
  private serialize<T>(signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
    const guarded = () => (signal?.aborted ? Promise.reject(cancelled()) : fn())
    const run = this.chain.then(guarded, guarded)
    this.chain = run.catch(() => {})
    return run
  }

  /** Plays a batch in memory, from where the queued batches leave off, or the editor as it is. */
  private rehearse(s: Session, actions: Action[]): ReturnType<typeof rehearse> {
    const from = s.queue.at(-1)?.after ?? { scene: s.scene, texts: new Map(), lines: s.lines, edits: new Set<string>() }
    return rehearse(this.editor, this.config, from, actions, (file, line, id) => s.seen.get(file)?.get(line) === id)
  }

  /** Reports a batch that played in memory failed, without queuing it; nothing else changes. */
  private async reject(s: Session, actions: Action[], rehearsal: Awaited<ReturnType<typeof rehearse>>): Promise<Report> {
    const rehearsed = rehearsal.result
    const index = actions.length - (rehearsed.unplayed?.length ?? 0) + 1
    const rejected: NonNullable<Report["rejected"]> = { index, action: actions[index - 1]!, error: rehearsed.error! }
    if (rehearsed.code) rejected.code = rehearsed.code
    for (const sighting of rehearsal.sightings) this.saw(s, rehearsal.after.lines, sighting)
    const report = { ...this.snapshot(s, undefined, false), rejected }
    this.render()
    return this.withCursor(s, report)
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
        if (s.scene.turn === "agent") return s.events.some(interrupting)
        // The programmer's edits during their turn wait until they pause typing.
        return s.events.some((e) => e.kind !== "edit") || (s.navigatorReady && s.events.some(interrupting))
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
    const report = this.snapshot(s, call.batch, timedOut && !closing)
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
    if (!s.scene.cursor) return report
    const shown = await s.player.code({ moved: true })
    const line = shown?.code.lines.find((l) => l.text.includes(CURSOR_MARKER))
    if (!shown || !line) return report
    const key = `${shown.code.file}:${line.number}:${line.text}`
    if (key === s.seenCursor) return report
    s.seenCursor = key
    this.saw(s, s.lines, shown.sighting)
    return { ...report, cursor: shown.code }
  }

  /**
   * The agent is shown lines: it knows which line each number is, while it stays that line's.
   * `lines`: of the version shown, which may be a batch's, as it will play or would have.
   */
  private saw(s: Session, lines: LineIds, { file, text, lines: numbers }: Sighting): void {
    const ids = lines.of(file, text)
    let seen = s.seen.get(file)
    if (!seen) s.seen.set(file, (seen = new Map()))
    for (const n of numbers) {
      const id = ids[n - 1]
      if (id !== undefined) seen.set(n, id)
    }
  }

  /** Takes everything not yet reported. `submitted`: the batch the call submitted, if any. */
  private snapshot(s: Session, submitted: Batch | undefined, waiting: boolean): Report {
    const batches = s.finished.sort((a, b) => a.id - b.id)
    const events: Event[] = []
    for (const e of s.events) {
      if (e.kind !== "edit") {
        events.push(e)
        continue
      }
      if (e.diff !== undefined) {
        events.push({ kind: "edit", file: e.file, diff: e.diff, by: e.by })
        continue
      }
      const before = s.baselines.get(e.file) ?? ""
      const after = s.latest.get(e.file) ?? before
      if (before === after) continue
      const file = this.displayPath(s, e.file)
      events.push({ kind: "edit", file, diff: fileDiff(file, before, after), by: e.by })
    }
    s.finished = []
    s.events = []
    s.baselines = new Map()
    s.latest = new Map()
    s.stale = false
    s.navigatorReady = false

    const report: Report = { batches, events, turn: s.scene.turn }
    const b = submitted
    if (b && b.state !== "done") report.submitted = { id: b.id, status: b.state }
    if (waiting) report.waiting = true
    return report
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
        const { result, sightings } = await s.player.play(batch.id, batch.actions)
        if (this.session !== s) break
        // It played as it did in memory, so the lines it typed are the ones later batches were rehearsed with.
        if (result.status === "completed" && batch.after) s.lines.adopt(batch.after.lines)
        for (const sighting of sightings) this.saw(s, s.lines, sighting)
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

  // ---- Shared selections ---------------------------------------------------

  private excerpt(s: Session, selection: SharedSelection): Excerpt {
    return { ...selection, file: this.displayPath(s, selection.file) }
  }

  private ref(selection: SharedSelection): Ref {
    return { file: this.editor.displayPath(selection.file), line: selection.from.line, endLine: selection.to.line }
  }

  // ---- Paths ---------------------------------------------------------------

  private resolvePath(s: Session, file: string): string {
    return agentPath(this.editor, s.scene.root, file)
  }

  private displayPath(s: Session, file: string): string {
    return displayPath(this.editor, s.scene.root, file)
  }

  // ---- Rendering -----------------------------------------------------------

  private cursorView(s: Session): CursorView | null {
    if (!s.scene.cursor) return null
    return s.scene.selection ? { ...s.scene.cursor, selection: s.scene.selection } : { ...s.scene.cursor }
  }

  private state(): AgentState {
    const s = this.session
    if (!s || s.scene.turn === "user") return "navigator"
    if (this.pauseReasons.size > 0) return "paused"
    if (s.queue.length > 0) return s.player.reading ? "read" : s.player.commandRunning ? "running" : "typing"
    return this.call?.kind === "listen" ? "listening" : "thinking"
  }

  private render(): void {
    const s = this.activeSession()
    const state = this.state()
    this.editor.renderCursor(s ? this.cursorView(s) : null, state, s?.scene.focus ?? "cursor")
    if (!s) return
    const paused = this.pauseReasons.size > 0
    const key = `${state}/${s.scene.turn}/${paused}`
    if (key === this.lastPosted) return
    this.lastPosted = key
    this.panel.post({ type: "state", state, turn: s.scene.turn, paused })
  }
}
