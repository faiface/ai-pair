// The protocol state machine: sessions, the batch queue, and reports. Playing a batch is player.ts.
// See PROTOCOL.md for the rules implemented here.

import type {
  AuthorEvent,
  AuthorReport,
  Beat,
  BatchResult,
  Event,
  Excerpt,
  FileContent,
  Report,
  RunResult,
  SetAside,
  StageBrief,
  StageFile,
  StageView,
  Turn,
} from "@ai-pair/protocol"
import { CURSOR_MARKER, ToolError } from "@ai-pair/protocol"
import { fileDiff } from "./diff"
import { LineIds, type Sighting } from "./lines"
import { StagePlan, type FileView, type ReadFile, type StageRecord } from "./plan"
import { agentPath, displayPath, Player, programOf, sayPlans, type Scene } from "./player"
import type { AgentState, Change, CopyFactory, CopyPort, CursorView, EditorPort, KeysPort, PanelPort, Ref, SharedSelection, VoicePort } from "./ports"
import { followChange, rehearse, type Rehearsal } from "./rehearsal"
import { fileLines } from "./text"
import { Timeline } from "./timeline"
import { defaultTiming, withOverrides, type Timing, type TimingOverrides } from "./timing"

export type Config = {
  maxBlockMs: number
  /** During the programmer's turn, how long after their last edit `listen` returns. */
  navigatorIdleMs: number
  /**
   * How far ahead of playback the agent may work: `step` returns at once while fewer than this
   * many batches wait in front of the new one, not yet playing. 0 waits for each batch.
   */
  workAheadBatches: number
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
  workAheadBatches: 2,
  timing: defaultTiming,
  random: Math.random,
  confirmCommands: true,
  runWaitMs: 120_000,
  maxRunWaitMs: 600_000,
}

/** What the voice asks when a `run` waits for the programmer's go-ahead. */
const CONFIRM_ASK = "Okay to run it? Allow it in the panel."

/**
 * How long the editor may sit still between batches, while the agent writes the next, before the
 * agent is told: a beat is natural, longer reads to the programmer as the session being stuck.
 */
const STILL_NOTE_MS = 5000

/**
 * How many lines left of a stage each report shows, per file: the presenter writes from the top
 * of what's left, so the rest can wait, and a long new file isn't repeated whole in every report.
 */
const STAGE_LINES_SHOWN = 60

/** What the agent last heard that it now has to answer: it picks the words the voice fills its thinking with. */
type News = "ran" | "failed" | "message" | "interrupted" | "drained"

/**
 * Said by the voice, not the agent, when the agent goes quiet to think: a person at the desk
 * would make a sound, not sit in silence. Fitted to what it's answering, and short, so they never
 * hold back the agent's own words for long. They never say what a run printed: what to make of
 * it is the agent's to say. `long`: still thinking, a while later.
 */
const FILLERS: Record<News | "long", string[]> = {
  ran: ["Okay, let me think about that.", "Alright. One moment.", "Mm. Let me see."],
  failed: ["Let me look at why.", "Hmm. Let me see what went wrong.", "Okay, let me find the cause."],
  message: ["Okay, one moment.", "Mm, let me think.", "Alright, give me a second."],
  interrupted: ["Okay, let me rethink this.", "Sure. Give me a moment.", "Got it. Let me rework that."],
  drained: ["One sec.", "Just a moment.", "Let me think about the next bit."],
  long: ["Still working it out.", "Bear with me, almost there.", "Still thinking this one through."],
}
/**
 * How long the agent may think in silence before the voice fills it. When the editor ran out of
 * written batches, a beat is the agent's to take.
 */
const FILL_FIRST_MS: Record<News, number> = { ran: 3000, failed: 3000, message: 3000, interrupted: 3000, drained: STILL_NOTE_MS }
/** And again after that, at most. */
const FILL_AGAIN_MS = 15_000
const MAX_FILLS = 2

type Batch = {
  id: number
  beats: Beat[]
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
  /** When the queue ran dry while the agent was off writing, not waiting: the editor is still until its next batch. */
  stillSince?: number
  /** How long the editor sat still before the batch just submitted, to tell the agent. */
  stillMs?: number
  /** The voice as the agent was last told of it: whether it's on. */
  toldVoice?: boolean
  /** What the agent was last given to answer, or is writing ahead of; none for a quiet heartbeat. */
  news?: News
  /** The voice's fillers in this stretch of the agent thinking: how many so far, and the next. */
  fills: number
  fillTimer?: NodeJS.Timeout
  /** Takes back a filler not yet heard, once the agent has its own words. */
  takeBackFill?: () => void
  /** The filler said last, so the next one is a different one. */
  lastFill?: string
  /** How it pairs, as picked when it started. */
  mode: Mode
  /** The author's side: its private copy, the stages it recorded, and its news. */
  author: Author
  /** The stage being played, and what's left of it, as the editor reads now. */
  plan: StagePlan
  /** Stages begun and not yet told to the presenter, with their notes. */
  briefs: StageBrief[]
  /** The last stage the presenter was told of. */
  briefed: number
  /** What the author told the presenter, not yet reported. */
  told: string[]
  /** The stage view as last reported, so it's only reported again when it changed. */
  shownStage?: string
  /** The stage as last worked out for a report, with the queued batches played, still has code to put in. */
  stageLeft: boolean
  /** Code of the stages set aside for the programmer's: as told already, and not yet told to the presenter. */
  asideTold: Set<string>
  aside: SetAside[]
  /** Starting stages, one at a time: two at once could start the same one twice. */
  advancing: Promise<void>
}

/** The author's side of a session. */
type Author = {
  copy: CopyPort
  /** Shared with every plan, which reads the stages from it as they're recorded. */
  stages: StageRecord[]
  /** The snapshot the next stage is told apart from: the last stage's, or the copy as it was made. */
  last: string
  /** It recorded its last stage: none are coming, unless it records more. */
  done: boolean
  events: AuthorEvent[]
  /** Edits in the editor that aren't a stage's code, still to carry into the copy, in order. */
  carry: Carry[]
  /** The programmer paused after editing: their edits are news for a waiting author. */
  settled: boolean
  settleTimer?: NodeJS.Timeout
  /** The last stage the author was told playback caught up with. */
  caughtUp: number
}

type Carry = { file: string; before: string; after: string; by: "programmer" | "presenter" }

type Mode = { kind: "build" | "learn"; drive?: "show" | "together" | "try" }

type AuthorCall = {
  timer: NodeJS.Timeout
  resolve: (report: AuthorReport) => void
  reject: (error: unknown) => void
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
  /** The session that ended last, so its author's next call hears it ended instead of failing. */
  private retired: Session | null = null
  private call: Call | null = null
  private chain: Promise<unknown> = Promise.resolve()
  /** The author's calls run in turn, apart from the presenter's: each waits on its own. */
  private authorCall: AuthorCall | null = null
  private authorChain: Promise<unknown> = Promise.resolve()
  private nextBatchId = 1
  private pauseReasons = new Set<string>()
  private speed = 1
  /** The mode the next session runs in; fixed for a session once it starts. */
  private mode: Mode = { kind: "build" }
  private voice: VoicePort | undefined
  private keys: KeysPort | undefined
  private lastPosted = ""
  /** After a session with stages: each file they changed as the author left it, to compare with the code. */
  private preparedFiles: Array<{ file: string; text?: string }> = []

  constructor(
    private readonly editor: EditorPort,
    private readonly panel: PanelPort,
    private readonly copies: CopyFactory,
    private config: Config = defaultConfig,
  ) {}

  // ---- Tools -------------------------------------------------------------

  /** The author starts a session, and gets its private copy of the workspace to work in. */
  start(task?: string, root?: string, signal?: AbortSignal): Promise<AuthorReport> {
    return this.serialize(
      signal,
      async () => {
        if (this.session && !this.session.ended) {
          throw new ToolError("session_active", "A pairing session is already active in this window.")
        }
        // In the editor's spelling, so paths inside it are reported relative to it.
        const folder = root && this.editor.resolvePath(root)
        const copy = await this.copies(folder ?? this.editor.resolvePath("."))
        const scene: Scene = {
          root: folder,
          turn: "agent",
          cursor: null,
          selection: null,
          point: null,
          focus: "cursor",
          pointFar: false,
          allowed: { all: false, programs: new Set() },
        }
        const timeline = new Timeline(this.pauseReasons.size > 0)
        const lines = LineIds.editor()
        const stages: StageRecord[] = []
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
            voice: () => (this.voice?.ready ? this.voice : undefined),
            keys: () => this.keys,
            lines,
            plan: () => s.plan,
            offPlan: (file, before, after) => {
              this.toCarry(s, file, before, after, "presenter")
              this.settle(s)
            },
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
          fills: 0,
          mode: this.mode,
          author: { copy, stages, last: copy.base, done: false, events: [], carry: [], settled: false, caughtUp: 0 },
          plan: new StagePlan(stages),
          briefs: [],
          briefed: 0,
          told: [],
          stageLeft: false,
          asideTold: new Set(),
          aside: [],
          advancing: Promise.resolve(),
        }
        this.session = s
        this.retired = null
        this.preparedFiles = []
        this.lastPosted = ""
        this.panel.post({ type: "session", active: true, task })
        this.render()
        return { copy: copy.root, playing: 0, stages: 0, events: [], mode: s.mode.kind, ...(s.mode.drive ? { drive: s.mode.drive } : {}) }
      },
      true,
    )
  }

  /**
   * The author records its copy as it is now as the next stage: what changed since the stage
   * before, with its notes for the presenter. `last`: it's the last, unless more are recorded.
   */
  stage(title: string, notes: string, last?: boolean, signal?: AbortSignal): Promise<AuthorReport> {
    return this.serialize(
      signal,
      async () => {
        const s = this.authorSession()
        if (this.session !== s || s.ended) return this.authorReport(s)
        const a = s.author
        const snapshot = await a.copy.snapshot()
        const changes = (await a.copy.changes(a.last, snapshot)).map((c) => ({ ...c, file: this.editor.resolvePath(c.file) }))
        if (changes.length === 0) {
          throw new ToolError("invalid_arguments", `Nothing changed in your copy since ${a.stages.length > 0 ? `stage ${a.stages.length}` : "you started"}: a stage is the work since the one before.`)
        }
        a.last = snapshot
        a.done = last === true
        const record: StageRecord = { number: a.stages.length + 1, title, notes, snapshot, changes }
        a.stages.push(record)
        await this.advance(s)
        return this.authorReport(s, { recorded: record.number })
      },
      true,
    )
  }

  /** The author waits for news: the programmer's words and edits, the presenter's, or playback catching up. */
  wait(signal?: AbortSignal): Promise<AuthorReport> {
    return this.serialize(
      signal,
      () => {
        const s = this.authorSession()
        return new Promise<AuthorReport>((resolve, reject) => {
          const call: AuthorCall = { resolve, reject, timer: setTimeout(() => this.finishAuthor(s), this.config.maxBlockMs) }
          this.authorCall = call
          signal?.addEventListener("abort", () => {
            if (this.authorCall !== call) return
            this.authorCall = null
            clearTimeout(call.timer)
            reject(cancelled())
          })
          this.authorPump()
        })
      },
      true,
    )
  }

  /** The author tells the presenter something, which it hears in its next report. */
  tellPresenter(text: string, signal?: AbortSignal): Promise<AuthorReport> {
    return this.serialize(
      signal,
      async () => {
        const s = this.authorSession()
        if (this.session === s && !s.ended) {
          s.told.push(text)
          this.pump()
        }
        return this.authorReport(s)
      },
      true,
    )
  }

  /** The presenter joins the session the author started: its first report, with the stages so far. */
  join(signal?: AbortSignal): Promise<Report> {
    return this.serialize(signal, async () => {
      const s = this.requireSession()
      s.author.events.push({ kind: "presenter", present: true })
      this.authorPump()
      // A presenter joining again starts afresh: it's told everything a first report tells,
      // including the notes of the stage being played.
      s.shownStage = undefined
      s.toldVoice = undefined
      const current = s.author.stages[s.briefed - 1]
      if (current && s.briefs.length === 0) s.briefs.push({ number: current.number, title: current.title, notes: current.notes })
      const report: Report = { ...this.snapshot(s, undefined, false), mode: s.mode.kind, ...(s.mode.drive ? { drive: s.mode.drive } : {}) }
      this.render()
      return this.complete(s, report)
    })
  }

  /** The presenter tells the author something, which it hears at once if it's waiting. */
  tellAuthor(text: string): void {
    const s = this.requireSession()
    s.author.events.push({ kind: "told", text })
    this.authorPump()
  }

  /** The presenter's connection closed; the author's stays, and hears it. */
  presenterLeft(): void {
    const s = this.activeSession()
    if (!s) return
    s.author.events.push({ kind: "presenter", present: false })
    this.authorPump()
  }

  step(beats: Beat[], signal?: AbortSignal): Promise<Report> {
    return this.serialize(signal, async () => {
      const s = this.requireSession()
      // An empty batch only waits for the queued ones, so it isn't a batch of its own.
      if (beats.length === 0) return this.block("step", {}, signal)
      // Played in memory first, so what would fail is reported now, not when the batch plays.
      const rehearsal = s.stale || s.ended ? undefined : await this.rehearse(s, beats)
      // An interruption arriving meanwhile discards it, like any batch planned without knowing about it.
      const current = rehearsal && !s.stale && !s.ended
      if (current && rehearsal.result.status === "failed") return this.reject(s, beats, rehearsal)
      const batch: Batch = { id: this.nextBatchId++, beats, state: "queued", after: rehearsal?.after }
      if (current) {
        s.queue.push(batch)
        if (s.stillSince !== undefined && Date.now() - s.stillSince >= STILL_NOTE_MS) s.stillMs = Date.now() - s.stillSince
        s.stillSince = undefined
        // Its words are made now, while the batches before it play, so it starts talking at once.
        const voice = this.voice?.ready ? this.voice : undefined
        if (voice) for (const { say, spanMs } of sayPlans(beats, this.config.timing)) voice.prepare(say, spanMs / this.speed)
        this.kick(s)
      } else {
        this.discard(s, batch)
      }
      return this.block("step", { batch }, signal)
    })
  }

  listen(signal?: AbortSignal): Promise<Report> {
    return this.serialize(signal, () => {
      const s = this.requireSession()
      // Waiting on the programmer on purpose: the editor's stillness from here on isn't the agent's.
      s.stillSince = undefined
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
    if (report.briefs) s.briefs.unshift(...report.briefs)
    if (report.author) s.told.unshift(...report.author)
    if (report.stage) s.shownStage = undefined
    if (report.stage?.set_aside) s.aside.unshift(...report.stage.set_aside)
    this.update()
  }

  /** As `restore`, for a report of the author's. */
  restoreAuthor(report: AuthorReport): void {
    const s = this.session ?? this.retired
    if (!s) return
    s.author.events.unshift(...report.events)
    this.authorPump()
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
    // The stage is looked at at once: a line of it they type and then delete again is theirs to
    // delete, and dropped, not written back.
    if (s.plan.has(file)) s.plan.view(file, after, s.lines.of(file, after))
    if (!s.stale) {
      for (const { after: r } of s.queue) if (r?.plan?.has(file) && !r.texts.has(file)) r.plan.view(file, after, r.lines.of(file, after))
    }
    this.toCarry(s, file, before, after, "programmer")
    this.settle(s)
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
    // They may have written what was left of the stage.
    void this.advance(s)
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
    s.author.events.push({ kind: "end" })
    this.interrupt(s)
    this.panel.post({ type: "session", active: false, reason: "user" })
    this.update()
    this.authorPump()
  }

  /** The agent is gone: the connection that started the session closed. */
  disconnect(): void {
    const s = this.session
    for (const call of [this.call, this.authorCall]) {
      if (!call) continue
      clearTimeout(call.timer)
      call.reject(new ToolError("no_session", "Disconnected."))
    }
    this.call = null
    this.authorCall = null
    if (!s) return
    this.close(s)
    if (!s.ended) this.panel.post({ type: "session", active: false, reason: "disconnected" })
  }

  pause(reason = "user"): void {
    const was = this.pauseReasons.size
    this.pauseReasons.add(reason)
    this.session?.timeline.pause()
    this.render()
    // The programmer's own Pause is told to a waiting agent at once — its report says paused —
    // instead of leaving it to wonder at the next heartbeat why nothing is playing.
    if (was === 0 && reason === "user") this.wakeWaiting()
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
    // And a waiting agent hears at once that things move again.
    this.wakeWaiting()
  }

  /** Answers a waiting `step` or `listen` now, with the report as it stands. Never an `end`. */
  private wakeWaiting(): void {
    if (this.call && this.call.kind !== "end") this.finishCall(false)
  }

  setSpeed(speed: number): void {
    this.speed = speed
  }

  /** How the next session pairs: build it, or learn it (with who does the work). A session that's
   *  already running keeps the mode it started in. */
  setMode(kind: "build" | "learn", drive?: "show" | "together" | "try"): void {
    this.mode = { kind, ...(kind === "learn" ? { drive: drive ?? "show" } : {}) }
  }

  /** The voice that speaks each `say`, or none. Changing it cuts off anything being said. */
  setVoice(voice: VoicePort | undefined): void {
    if (this.voice !== voice) this.voice?.stop()
    this.voice = voice
  }

  /** The key sounds told of each keystroke of the agent's, or none. */
  setKeys(keys: KeysPort | undefined): void {
    this.keys = keys
  }

  setConfirmCommands(confirm: boolean): void {
    this.config = { ...this.config, confirmCommands: confirm }
  }

  /** How far ahead of playback the agent may work, in batches waiting to play; 0 waits for each batch. */
  setWorkAhead(batches: number): void {
    this.config = { ...this.config, workAheadBatches: Math.max(0, Math.round(batches)) }
    this.update()
  }

  /**
   * The programmer's answer to a `run` waiting for confirmation. `allow`: for the rest of the
   * session, run without asking every command of this one's program, or every command.
   */
  decideRun(id: number, run: boolean, allow?: "program" | "all"): void {
    const s = this.session
    const c = s?.confirming
    if (c?.id !== id) return
    const program = programOf(c.command)
    if (run && allow === "all") s!.scene.allowed.all = true
    else if (run && allow === "program" && program !== undefined) s!.scene.allowed.programs.add(program)
    c.decide(run)
  }

  /** Waits for the programmer's answer to a `run`, or an interruption. */
  private confirm(s: Session, id: number, command: string): Promise<boolean> {
    const signal = s.timeline.signal
    // Once they've answered, asking is stale: words still queued or sounding are taken back.
    const asked = new AbortController()
    return new Promise<boolean>((resolve) => {
      const abort = () => resolve(false)
      // Said, not only shown: the programmer's eyes are on the code, and nothing plays until they answer.
      if (this.voice?.ready) void this.voice.speak(CONFIRM_ASK, undefined, undefined, asked.signal)
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
      asked.abort()
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

  /**
   * Runs tool calls one at a time: the presenter's in one line, the author's in another. A call
   * cancelled while waiting its turn never runs.
   */
  private serialize<T>(signal: AbortSignal | undefined, fn: () => Promise<T>, author = false): Promise<T> {
    const guarded = () => (signal?.aborted ? Promise.reject(cancelled()) : fn())
    const run = (author ? this.authorChain : this.chain).then(guarded, guarded)
    if (author) this.authorChain = run.catch(() => {})
    else this.chain = run.catch(() => {})
    return run
  }

  /** Plays a batch in memory, from where the queued batches leave off, or the editor as it is. */
  private rehearse(s: Session, beats: Beat[]): ReturnType<typeof rehearse> {
    const from = s.queue.at(-1)?.after ?? { scene: s.scene, texts: new Map(), gone: new Set<string>(), lines: s.lines, plan: s.plan, edits: new Set<string>() }
    return rehearse(this.editor, this.config, from, beats, (file, line, id) => s.seen.get(file)?.get(line) === id)
  }

  /** Reports a batch that played in memory failed, without queuing it; nothing else changes. */
  private async reject(s: Session, beats: Beat[], rehearsal: Awaited<ReturnType<typeof rehearse>>): Promise<Report> {
    const rehearsed = rehearsal.result
    // The failing action leads what didn't play, so the beats and actions before it played.
    const unplayed = rehearsed.unplayed ?? []
    const beat = beats.length - unplayed.length + 1
    const left = unplayed[0]?.do ?? []
    const actions = beats[beat - 1]?.do ?? []
    const action = actions.length - left.length + 1
    const rejected: NonNullable<Report["rejected"]> = { beat, action, value: actions[action - 1]!, error: rehearsed.error! }
    if (rehearsed.code) rejected.code = rehearsed.code
    for (const sighting of rehearsal.sightings) this.saw(s, rehearsal.after.lines, sighting)
    const report = { ...this.snapshot(s, undefined, false), rejected }
    this.render()
    return this.complete(s, report)
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
        // Waiting with an empty batch is waiting for what played, and a run's output (or a failure)
        // is what it waits for: it comes as soon as it lands, not after the batches queued behind it.
        // A stage starting, or the author's words, are news to go on with.
        if (!call.batch) {
          return s.queue.length === 0 || s.briefs.length > 0 || s.told.length > 0 || s.finished.some((r) => r.status !== "completed" || (r.runs?.length ?? 0) > 0)
        }
        return call.batch.state !== "queued" || this.room(s, call.batch)
      case "end":
        return s.queue.length === 0
      case "listen":
        // A failure, or a run's output, is news the agent is waiting for even while listening for
        // the programmer: without this, a run it waits on with `listen` — as it's told to — would
        // only reach it at the heartbeat. Its own finished typing is not news; `listen` stays the
        // programmer's.
        if (s.finished.some((r) => r.status !== "completed" || (r.runs?.length ?? 0) > 0)) return true
        // So is a stage starting, or the author's words.
        if (s.briefs.length > 0 || s.told.length > 0) return true
        if (s.queue.length > 0) return false
        // Its batches have all played, and the stage still has code to put in: the editor stands
        // still while the presenter has work. Waiting on here, it would sit out the whole wait,
        // say beside a `step` sent in the same turn whose report already told it a stage began.
        // Only as its batches finish: the `listen` after waits for the programmer, say for an answer.
        if (s.scene.turn === "agent" && s.stageLeft && s.finished.length > 0) return true
        if (s.scene.turn === "agent") return s.events.some(interrupting)
        // The programmer's edits during their turn wait until they pause typing.
        return s.events.some((e) => e.kind !== "edit") || (s.navigatorReady && s.events.some(interrupting))
    }
  }

  /**
   * The agent may work ahead of `batch`: few enough batches wait in front of it, not yet playing,
   * that writing more now is unlikely to be thrown away. A count, not a guess at playing time: the
   * agent is held only once the queue is full.
   */
  private room(s: Session, batch: Batch): boolean {
    let waiting = 0
    for (const b of s.queue) {
      if (b === batch) break
      if (b.state === "queued") waiting++
    }
    return waiting < this.config.workAheadBatches
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
      this.close(s, call.summary)
      if (call.kind === "end" && !s.ended) {
        this.panel.post({ type: "session", active: false, reason: "agent", summary: call.summary })
      }
    }
    this.render()
    void this.complete(s, report).then(call.resolve, () => call.resolve(report))
  }

  /**
   * Finishes a report: the stages that started, with their notes, what the author said, what's
   * left of the stage if that changed, and the cursor.
   */
  private async complete(s: Session, report: Report): Promise<Report> {
    if (this.session === s) {
      await this.advance(s)
      if (s.briefs.length > 0) report.briefs = s.briefs.splice(0)
      if (s.told.length > 0) report.author = s.told.splice(0)
      const stage = await this.stageView(s)
      s.stageLeft = (stage?.left.length ?? 0) > 0
      const key = stage && JSON.stringify(stage)
      if (stage && key !== s.shownStage) {
        report.stage = stage
        s.shownStage = key
      }
    }
    return this.withCursor(s, report)
  }

  // ---- Stages --------------------------------------------------------------

  /**
   * Starts the stages that are in, once the one before is all written, as the queued batches will
   * leave the code, or as the editor has it when none are queued. One call at a time: two at once
   * could start the same stage twice.
   */
  private advance(s: Session): Promise<void> {
    const run = s.advancing.then(async () => {
      if (this.session !== s) return
      const tail = s.stale ? undefined : s.queue.at(-1)?.after
      const plan = tail?.plan ?? s.plan
      for (const stage of await plan.advance(this.reader(tail), tail?.lines ?? s.lines)) this.started(s, stage)
      // Code set aside as a stage started is told to both, once, though it may start again.
      for (const a of plan.setAside) {
        const key = `${a.stage}\0${a.file}\0${a.plan}`
        if (s.asideTold.has(key)) continue
        s.asideTold.add(key)
        const told = { ...a, file: this.displayPath(s, a.file) }
        s.aside.push(told)
        s.author.events.push({ kind: "set_aside", ...told })
        this.authorPump()
      }
      await this.caughtUp(s)
    })
    s.advancing = run.catch(() => {})
    return s.advancing
  }

  /** A stage started: the presenter is told of it, with the author's notes, and the panel marks it. */
  private started(s: Session, stage: StageRecord): void {
    // Started again, on the editor's code after the batches that started it were interrupted.
    if (stage.number <= s.briefed) return
    s.briefed = stage.number
    s.briefs.push({ number: stage.number, title: stage.title, notes: stage.notes })
    this.panel.post({ type: "stage", number: stage.number, title: stage.title })
    // Binary files can't be typed: they're put in place as the stage starts.
    for (const c of stage.changes) if (c.binary) void s.author.copy.restore(stage.snapshot, c.file).catch(() => {})
    this.pump()
  }

  /** Tells the author, once, that the editor has all of the stages it recorded: the programmer waits on it. */
  private async caughtUp(s: Session): Promise<void> {
    const a = s.author
    const n = s.plan.number
    if (n === 0 || n !== a.stages.length || a.caughtUp >= n || s.queue.length > 0) return
    const left = await s.plan.left(this.reader(), s.lines)
    if (left.some((v) => v.pending > 0 || v.remove) || a.caughtUp >= n) return
    a.caughtUp = n
    a.events.push(a.done ? { kind: "caught_up", stage: n, last: true } : { kind: "caught_up", stage: n })
    this.authorPump()
  }

  /** The stage being played, and what's left of it, as the queued batches will leave the code. */
  private async stageView(s: Session): Promise<StageView | undefined> {
    const tail = s.stale ? undefined : s.queue.at(-1)?.after
    const plan = tail?.plan ?? s.plan
    const stage = plan.current
    if (!stage) return undefined
    const read = this.reader(tail)
    const lines = tail?.lines ?? s.lines
    const left: StageFile[] = []
    for (const view of await plan.left(read, lines)) {
      if (view.pending === 0 && !view.remove) continue
      left.push(this.stageFile(s, view, (await read(view.file)) ?? "", lines))
    }
    const result: StageView = { number: stage.number, title: stage.title, of: s.author.stages.length, left }
    if (s.author.done) result.last = true
    if (s.aside.length > 0) result.set_aside = s.aside.splice(0)
    return result
  }

  /**
   * What's left of a stage in a file, as the presenter is shown it: each line to write or take
   * out, with the line of the file on either side. Only so many: the rest is counted.
   */
  private stageFile(s: Session, view: FileView, text: string, lines: LineIds): StageFile {
    const shown = new Set<number>()
    let pending = 0
    view.items.forEach((item, i) => {
      if (item.kind !== "write" && item.kind !== "remove") return
      if (++pending > STAGE_LINES_SHOWN) return
      for (let j = Math.max(0, i - 1); j <= Math.min(view.items.length - 1, i + 1); j++) shown.add(j)
    })
    const out: StageFile["lines"] = []
    const numbers: number[] = []
    for (const i of [...shown].sort((a, b) => a - b)) {
      const item = view.items[i]!
      if (item.kind === "write") {
        out.push({ text: item.text, change: "write" })
        continue
      }
      out.push(item.kind === "remove" ? { number: item.line, text: item.text, change: "remove" } : { number: item.line, text: view.lines[item.line - 1]! })
      numbers.push(item.line)
    }
    // Lines it was shown it may go to by number, as with any code it's shown.
    this.saw(s, lines, { file: view.file, text, lines: numbers })
    const file: StageFile = { file: this.displayPath(s, view.file), lines: out }
    if (pending > STAGE_LINES_SHOWN) file.more = pending - STAGE_LINES_SHOWN
    if (view.remove) file.delete = true
    return file
  }

  /** Reads files as the batch played in memory left them, or the editor has them: none if they don't exist. */
  private reader(after?: Rehearsal): ReadFile {
    return async (file) => {
      if (after?.gone.has(file)) return undefined
      const text = after?.texts.get(file)
      if (text !== undefined) return text
      try {
        return await this.editor.getText(file)
      } catch {
        return undefined
      }
    }
  }

  /** Each file the stages changed as the author left it, after a session with stages: to compare with the code. */
  get prepared(): ReadonlyArray<{ file: string; text?: string }> {
    return this.preparedFiles
  }

  // ---- The author ----------------------------------------------------------

  /** The session the author's calls are about: the active one, or the one that just ended. */
  private authorSession(): Session {
    const s = this.session ?? this.retired
    if (!s) throw new ToolError("no_session", "No pairing session is active. Call `start` to begin one.")
    return s
  }

  /** Answers a waiting author once there's news for it. */
  private authorPump(): void {
    const s = this.session ?? this.retired
    if (!this.authorCall || !s) return
    if (this.session !== s || s.ended || s.author.events.length > 0 || s.author.settled) this.finishAuthor(s)
  }

  private finishAuthor(s: Session): void {
    const call = this.authorCall
    if (!call) return
    this.authorCall = null
    clearTimeout(call.timer)
    void this.authorReport(s).then(call.resolve, call.reject)
  }

  /** Everything the author hasn't heard yet. Edits in the editor are carried into its copy first. */
  private async authorReport(s: Session, extra: { recorded?: number } = {}): Promise<AuthorReport> {
    const a = s.author
    const live = this.session === s && !s.ended
    if (live) await this.carry(s)
    a.settled = false
    const report: AuthorReport = { ...extra, playing: s.plan.number, stages: a.stages.length, events: a.events.splice(0) }
    if (!live) report.ended = true
    return report
  }

  /** Brings the edits made in the editor since the author last heard into its copy, and tells it of them. */
  private async carry(s: Session): Promise<void> {
    const a = s.author
    for (const e of a.carry.splice(0)) {
      const carried = await a.copy.carry(e.file, e.before, e.after).catch(() => false)
      const file = this.displayPath(s, e.file)
      a.events.push({ kind: "edit", file, diff: fileDiff(file, e.before, e.after), by: e.by, carried })
    }
  }

  /** An edit in the editor that isn't a stage's code, for the author's copy: one after another to a file is one. */
  private toCarry(s: Session, file: string, before: string, after: string, by: Carry["by"]): void {
    const last = s.author.carry.findLast((c) => c.file === file)
    if (last?.after !== before) {
      s.author.carry.push({ file, before, after, by })
      return
    }
    last.after = after
    if (by === "programmer") last.by = by
  }

  /** Edits are news for a waiting author once they pause, not with each keystroke. */
  private settle(s: Session): void {
    const a = s.author
    clearTimeout(a.settleTimer)
    a.settleTimer = setTimeout(() => {
      a.settled = true
      this.authorPump()
    }, this.config.navigatorIdleMs)
  }

  /** Keeps what the stages prepared, to compare with the code, and removes the copy. */
  private async retire(s: Session): Promise<void> {
    const a = s.author
    const last = a.stages.at(-1)
    try {
      if (last) {
        const changes = await a.copy.changes(a.copy.base, last.snapshot)
        this.preparedFiles = changes.flatMap((c) => (c.binary ? [] : [{ file: this.editor.resolvePath(c.file), text: c.after }]))
        if (this.preparedFiles.length > 0) this.panel.post({ type: "compare" })
      }
    } finally {
      await a.copy.dispose()
    }
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
    if (this.pauseReasons.size > 0) report.paused = true
    if (s.stillMs !== undefined) report.stillMs = s.stillMs
    s.stillMs = undefined
    // Named by its batch: the agent knows batches, not the panel's command ids.
    if (s.confirming && s.queue[0]) report.confirming = { id: s.queue[0].id, command: s.confirming.command }
    const voice = this.voice?.enabled === true
    if (s.toldVoice !== voice) report.voice = voice ? "on" : "off"
    s.toldVoice = voice
    // What the agent now has to answer, for the voice to fill its thinking with the right words.
    s.news = events.some((e) => e.kind === "message" || e.kind === "turn")
      ? "message"
      : batches.some((r) => r.status === "failed" && (r.runs?.length ?? 0) > 0)
        ? "failed"
        : batches.some((r) => (r.runs?.length ?? 0) > 0)
          ? "ran"
          : events.some((e) => e.kind === "interrupt" || (e.kind === "edit" && e.by === "programmer")) || batches.some((r) => r.status !== "completed")
            ? "interrupted"
            : undefined
    return report
  }

  private close(s: Session, summary?: string): void {
    if (this.session === s) this.session = null
    this.retired = s
    s.timeline.interrupt()
    this.voice?.stop()
    clearTimeout(s.navigatorTimer)
    clearTimeout(s.fillTimer)
    clearTimeout(s.author.settleTimer)
    this.editor.renderPoint(null)
    this.render()
    // The programmer ending it told the author already.
    if (!s.ended) s.author.events.push(summary ? { kind: "end", summary } : { kind: "end" })
    this.authorPump()
    void this.retire(s).catch(() => {})
  }

  // ---- Queue ---------------------------------------------------------------

  private discard(s: Session, batch: Batch): void {
    batch.state = "done"
    batch.result = { id: batch.id, status: "discarded", unplayed: batch.beats }
    s.finished.push(batch.result)
  }

  /** Stops playback and discards everything queued behind it. */
  private interrupt(s: Session): void {
    s.stale = true
    for (const b of s.queue) if (b.state === "queued") this.discard(s, b)
    s.queue = s.queue.filter((b) => b.state !== "done")
    s.timeline.interrupt()
    this.voice?.stop()
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
        const { result, sightings } = await s.player.play(batch.id, batch.beats)
        if (this.session !== s) break
        // It played as it did in memory, so the lines it typed are the ones later batches were
        // rehearsed with, and the stage is as it left it.
        if (result.status === "completed" && batch.after) {
          s.lines.adopt(batch.after.lines)
          if (batch.after.plan) s.plan = batch.after.plan
        }
        for (const sighting of sightings) this.saw(s, s.lines, sighting)
        batch.state = "done"
        batch.result = result
        s.queue = s.queue.filter((b) => b !== batch)
        s.finished.push(result)
        if (result.status !== "completed") this.interrupt(s)
        // Mark the next batch as playing before reporting, so the report says so.
        this.startHead(s)
        // Run dry with no call waiting: the agent is writing the next batch while the editor sits still.
        if (result.status === "completed" && s.queue.length === 0 && this.call === null && s.scene.turn === "agent") {
          s.stillSince = Date.now()
          s.news = "drained"
        }
        this.update()
        void this.advance(s)
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
    this.fillSilence(s, state)
    const paused = this.pauseReasons.size > 0
    const ahead = s.queue.filter((b) => b.state === "queued").length
    // Between calls the agent is at work: thinking, or writing the batches ahead.
    const working = s.scene.turn === "agent" && this.call === null
    const key = `${state}/${s.scene.turn}/${paused}/${ahead}/${working}`
    if (key === this.lastPosted) return
    this.lastPosted = key
    this.panel.post({ type: "state", state, turn: s.scene.turn, paused, ahead, working })
  }

  /**
   * While the agent thinks with the editor still, after something it has to answer, the voice makes
   * the small sound a person would: a few seconds in, and once more if it goes on. A stretch ends
   * when the agent's words come, or it waits on the programmer; a filler not yet heard is taken back.
   */
  private fillSilence(s: Session, state: AgentState): void {
    if (state !== "thinking" || this.call !== null || s.news === undefined) {
      clearTimeout(s.fillTimer)
      s.fillTimer = undefined
      s.fills = 0
      s.takeBackFill?.()
      s.takeBackFill = undefined
      return
    }
    if (s.fillTimer !== undefined || s.fills >= MAX_FILLS) return
    // Picked and made now, while the wait runs, so it's heard on time; never the last one again.
    const words = FILLERS[s.fills === 0 ? s.news : "long"].filter((w) => w !== s.lastFill)
    const text = words[Math.floor(this.config.random() * words.length)]!
    if (this.voice?.ready) this.voice.prepare(text, 0)
    s.fillTimer = setTimeout(
      () => {
        s.fillTimer = undefined
        const voice = this.voice
        if (this.session !== s || !voice?.ready) return
        s.fills++
        s.lastFill = text
        let heard = false
        const taken = new AbortController()
        void voice.speak(text, undefined, () => (heard = true), taken.signal)
        s.takeBackFill = () => {
          if (!heard) taken.abort()
        }
        this.fillSilence(s, this.state())
      },
      s.fills > 0 ? FILL_AGAIN_MS : FILL_FIRST_MS[s.news],
    )
  }
}
