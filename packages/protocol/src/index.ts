// Types of the agent-facing protocol. See PROTOCOL.md.

/**
 * Where a `move` goes: on `line`, exactly, a spot, `at`, or the end of the line. Without `line`,
 * on the cursor's line.
 */
export type MoveTarget = {
  file?: string
  /** The line the cursor lands on, from 1. Omitted: the cursor's line. */
  line?: number
  /** A spot on the line: the text around it, with `▌` where the cursor goes. */
  at?: string
  /** `line_end`: the end of the line. */
  to?: "line_end"
}

/**
 * The code a `select` or `point` takes: `text`, starting on `line`, exactly, or from `from`,
 * starting on it, through the first `through` after it. Without `line`, on the cursor's line.
 */
export type SpanTarget = {
  file?: string
  /** The line the code starts on, from 1. Omitted: the cursor's line. */
  line?: number
  text?: string
  from?: string
  through?: string
}

/**
 * Lines of the current stage still to write or take out, by their text: from the first that
 * contains `from` through the first after it that contains `through`. Without `from`, the first
 * left in the file; without `through`, to the end of its stretch, up to the next line of the
 * file the stage keeps. Without `file`, the cursor's file if the stage has anything left there,
 * or else the first file that has.
 */
export type PlanTarget = {
  file?: string
  from?: string
  through?: string
}

export type Action =
  | { move: MoveTarget }
  | { select: SpanTarget }
  /** The text, with `▌` where the cursor ends: what's after it is typed too, and stepped back over. */
  | { type: string }
  | { type_fast: string }
  | { delete: true }
  | { point: SpanTarget }
  | { run: string; wait?: number }
  /** Writes lines of the current stage into the file, as `type` would. `fast`: as `type_fast`. */
  | { write: PlanTarget & { fast?: boolean } }
  /** Takes lines out of the current stage, without touching the file. */
  | { drop: PlanTarget }

/**
 * One moment of a batch: words and the actions they go with, played together. `say` starts as
 * `do` starts and is spread over it; the next beat starts once both are done. Either may be
 * missing: a beat of only `say` talks, one of only `do` works quietly.
 */
export type Beat = { say?: string; do?: Action[] }

/** The keys that name an action. An action object has exactly one of them. */
export const ACTION_KINDS = ["move", "select", "type", "type_fast", "delete", "point", "run", "write", "drop"] as const

/** The action keys an object has; more than one means actions were combined by mistake. */
export function actionKinds(value: object): string[] {
  return Object.keys(value).filter((k) => (ACTION_KINDS as readonly string[]).includes(k))
}

/** What's wrong with a place's `line`, if anything. */
function lineProblem(line: unknown): string | undefined {
  if (line === undefined || (typeof line === "number" && Number.isInteger(line) && line >= 1)) return undefined
  return "`line` is a line number, from 1, exactly as your latest `read` or report shows it. Omit it for your cursor's line."
}

/** What's wrong with a `move`'s combination of fields, if anything. */
export function moveProblem(m: MoveTarget): string | undefined {
  const fields = m as Record<string, unknown>
  if ("before" in fields || "after" in fields) {
    return 'A spot is one text, `at`: the text around it, with ▌ where your cursor goes, e.g. `at: "import { ▌type Context"`.'
  }
  const line = lineProblem(m.line)
  if (line) return line
  if (m.to !== undefined && m.to !== "line_end") return '`to` is `"line_end"`: the end of the line.'
  if (m.at !== undefined && m.to !== undefined) return 'Give one place on the line: `at`, or `to: "line_end"`, not both.'
  if (m.at === undefined && m.to === undefined) return 'Give the place on the line: `at`, or `to: "line_end"`.'
  if (m.at !== undefined) return spotProblem(m.at)
  return undefined
}

/** What's wrong with a `select`'s or `point`'s combination of fields, if anything. */
export function spanProblem(span: SpanTarget): string | undefined {
  const fields = span as Record<string, unknown>
  if ("near_line" in fields) return "Give `line`: the line the code starts on, exactly as your latest `read` or report shows it."
  if ("to" in fields) return "The end of a range is `through`: `from` and `through` are both texts."
  const line = lineProblem(span.line)
  if (line) return line
  const range = span.from !== undefined || span.through !== undefined
  if (span.text !== undefined && range) return "Give `text`, or `from` and `through`, not both."
  if (range && (typeof span.from !== "string" || typeof span.through !== "string")) {
    return "A range is `from` and `through`, both texts: from the start of `from` through the end of the first `through` after it."
  }
  if (!range && typeof span.text !== "string") return "Give the code: `text`, or `from` and `through`."
  if (span.text === "" || span.from === "" || span.through === "") return "The code's text can't be empty."
  return undefined
}

/** What's wrong with a `write`'s or `drop`'s fields, if anything. */
export function planProblem(target: unknown, needsFrom: boolean): string | undefined {
  if (typeof target !== "object" || target === null) return "Give an object of texts: `{}` for the next lines left, or `from` and `through`."
  const fields = target as Record<string, unknown>
  for (const key of ["file", "from", "through"]) {
    const value = fields[key]
    if (value !== undefined && (typeof value !== "string" || value === "")) return `\`${key}\` is a text, not empty.`
  }
  if (needsFrom && fields.from === undefined) return "Give `from`: the text of the first line to drop, so nothing is dropped by mistake."
  return undefined
}

/** What's wrong with a spot's `at`, if anything: it needs exactly one cursor marker, and text around it. */
function spotProblem(at: string): string | undefined {
  const markers = markerCount(at)
  if (markers === 0) return '`at` marks where your cursor goes with ▌, e.g. `at: "import { ▌type Context"`.'
  if (markers > 1) {
    return `\`at\` has ${markers} ▌, but marks one spot: only where your cursor goes. Text copied from a report may carry the cursor's old ▌; leave that one out.`
  }
  if (at === CURSOR_MARKER) return "`at` needs text around ▌, to find the spot by."
  return undefined
}

/** What's wrong with the text of a `type`, if anything: it marks where the cursor ends with one ▌. */
export function typeProblem(text: unknown): string | undefined {
  if (Array.isArray(text)) return 'The text to type is one text, with ▌ where your cursor ends: `"f(▌)"`, or `"x▌"` with nothing after it.'
  if (typeof text !== "string") return "Give the text to type, with ▌ where your cursor ends."
  const markers = markerCount(text)
  if (markers === 0) return 'Mark where your cursor ends with ▌: `"f(▌)"`, or `"x▌"` with nothing after it.'
  if (markers > 1) return `The text to type has ${markers} ▌, but marks one place: where your cursor ends. A literal ▌ can't be typed.`
  // A `:`, `;` or `,` closes nothing, so after the ▌ it's what follows the close, typed early. The
  // agent then types it again once past the close, as in `def f(x)::`. A close on lines of its own,
  // a block's, is left alone: some languages end one with `;`.
  const after = text.slice(text.indexOf(CURSOR_MARKER) + CURSOR_MARKER.length)
  const early = /^([^\n]*?)([:;,]+)\s*$/.exec(after)
  if (early) {
    const [, close, punctuation] = early
    return `After ▌ goes only the close${close ? `, \`${close}\`` : ""}: \`${punctuation}\` closes nothing. Type it after stepping past the close, or it ends up there twice.`
  }
  return undefined
}

function markerCount(text: string): number {
  return text.split(CURSOR_MARKER).length - 1
}

export type Turn = "agent" | "user"

export type BatchStatus = "completed" | "interrupted" | "failed" | "discarded"

export type ErrorKind =
  | "no_line"
  | "not_found"
  | "ambiguous"
  | "line_not_seen"
  | "no_selection"
  | "no_cursor"
  | "not_your_turn"
  | "invalid_action"
  | "command_failed"
  | "command_declined"
  | "save_failed"

export type Candidate = { line: number; context: string }

export type RunResult = {
  command: string
  /** Absent when the command is still running, or its exit code couldn't be observed. */
  exit_code?: number
  output: string
  truncated?: true
  /** Still running: `wait` elapsed, or playback was interrupted. It keeps running in the terminal. */
  running?: true
  /** The terminal's shell, e.g. `pwsh` or `zsh`, when it's known. */
  shell?: string
}

/**
 * Marks the agent cursor: in a report's code, where a spot puts it, and where a `type` leaves it.
 * Spans ignore it, so code can be copied from a report as is.
 */
export const CURSOR_MARKER = "▌"

/**
 * Lines of a file as they read, with the agent cursor marked. Long code skips lines in the middle. A
 * newline at the end of the file ends its last line: there's no empty line after it, unless the
 * cursor is there.
 */
export type Code = {
  file: string
  lines: { number: number; text: string }[]
  /** Present when the lines reach the end of the file: whether a newline ends its last line. */
  end?: { final_newline: boolean }
}

export type BatchError = { kind: ErrorKind; message: string; candidates?: Candidate[] }

export type BatchResult = {
  id: number
  status: BatchStatus
  /** The code the batch produced, as it read when the batch ended; also just the cursor's line after a move. */
  code?: Code
  /** The error of a failed batch, about the first action in `unplayed`. */
  error?: BatchError
  /**
   * The beats that didn't play, verbatim, ready to resubmit. A beat cut short comes first, reduced to
   * what it didn't do: without its `say`, which was heard, and starting with what's left of an
   * interrupted `type`. A failed batch's failing action comes first.
   */
  unplayed?: Beat[]
  runs?: RunResult[]
  /** Files the batch edited that couldn't be saved: the buffer has the edits, the file on disk doesn't. */
  unsaved?: { file: string; error: string }[]
}

export type LineColumn = { line: number; column: number }

/** Code the programmer had selected when they wrote a message. */
export type Excerpt = {
  file: string
  from: LineColumn
  to: LineColumn
  text: string
  truncated?: true
}

export type Event =
  | { kind: "message"; text: string; selection?: Excerpt }
  /** `other`: not by the programmer, but by a tool, a formatter, or on disk. Only the programmer's interrupt. */
  | { kind: "edit"; file: string; diff: string; by: "programmer" | "other" }
  | { kind: "interrupt" }
  | { kind: "turn"; to: Turn; message?: string; selection?: Excerpt }
  | { kind: "end" }

export type Report = {
  batches: BatchResult[]
  /** The batch this `step` submitted, unless it's already finished and in `batches`. */
  submitted?: { id: number; status: "queued" | "playing" }
  /** How long the editor sat still, the queue run dry, while the agent wrote the batch this `step` submitted. Only when it was long. */
  stillMs?: number
  /**
   * The batch this `step` was given, if it wasn't queued: played in memory, from where the queued
   * batches leave off, `action` (from 1) of its `beat` (from 1) would fail. `code` is how the code
   * would read then.
   */
  rejected?: { beat: number; action: number; value: Action; error: BatchError; code?: Code }
  events: Event[]
  turn: Turn
  /** The agent cursor's line, when it isn't where the agent last saw it: in this report's code, or an earlier report. */
  cursor?: Code
  waiting?: true
  /** Playback is paused in the editor: batches are held, nothing plays, until the programmer resumes. */
  paused?: true
  /** A batch's `run` held until the programmer allows it: nothing after it plays until they answer. */
  confirming?: { id: number; command: string }
  /**
   * Whether the programmer hears the agent's `say`s spoken, or reads them: in the session's first
   * report, and in the next one whenever it changes.
   */
  voice?: "on" | "off"
  /**
   * The pairing mode the programmer picked for this session, fixed once it starts: in the
   * session's first report only. "learn" comes with `drive`: who does the work while learning.
   */
  mode?: "build" | "learn"
  /** With mode "learn": show = the agent drives and teaches, together = worked examples then the
   *  programmer tries the next one like it, try = the programmer drives, the agent navigates. */
  drive?: "show" | "together" | "try"
  /** Stages that began since the last report, in order, each with the author's notes. */
  briefs?: StageBrief[]
  /** The stage being played, as the queued batches leave it: whenever it changed since the last report. */
  stage?: StageView
  /** What the author told the presenter since the last report. */
  author?: string[]
}

export type StageBrief = { number: number; title: string; notes: string }

/** A stage, and what's left of it. See "Stages" in PROTOCOL.md. */
export type StageView = {
  number: number
  title: string
  /** How many stages the author has recorded so far. */
  of: number
  /** The author recorded its last stage: no more are coming. */
  last?: true
  /** What's left to write and take out, by file: none once the stage's code is all in. */
  left: StageFile[]
  /** Code of the stage the programmer's edits overrode, theirs kept: with the first report after it happened. */
  set_aside?: SetAside[]
}

/**
 * What's left of a stage in a file, in the order of the file, with lines around it as they read.
 * Lines in the file have their number; lines still to write have none, and go before the next line.
 */
export type StageFile = {
  file: string
  lines: { number?: number; text: string; change?: "write" | "remove" }[]
  /** How many more lines are left to write or take out, after the ones shown. */
  more?: number
  /** The stage deletes the file, once its lines are out. */
  delete?: true
}

export type SetAside = { file: string; stage: number; plan: string; kept: string }

/**
 * News for the author, who works out of sight in its copy while the presenter plays its stages.
 * The programmer's words go to the presenter, which passes on what's the author's to answer.
 */
export type AuthorEvent =
  /** An edit in the programmer's editor that wasn't the stage's code: `carried` into the copy, or not where it collided with the author's own changes. */
  | { kind: "edit"; file: string; diff: string; by: "programmer" | "presenter"; carried: boolean }
  /** What the presenter told the author. */
  | { kind: "told"; text: string }
  | ({ kind: "set_aside" } & SetAside)
  /**
   * Playback has caught up with the recorded stages: the programmer waits on the next, unless
   * `last`: it was the last, and the presenter wraps up.
   */
  | { kind: "caught_up"; stage: number; last?: true }
  | { kind: "presenter"; present: boolean }
  | { kind: "end"; summary?: string }

export type AuthorReport = {
  /** With `start`: where the author works, its private copy of the working directory. */
  copy?: string
  /** With `stage`: the number of the stage it recorded. */
  recorded?: number
  /** The stage being played in the editor, 0 before the first, and how many are recorded. */
  playing: number
  stages: number
  events: AuthorEvent[]
  /** With `start`, as in `Report`. */
  mode?: "build" | "learn"
  drive?: "show" | "together" | "try"
  ended?: true
}

export type FileContent = {
  file: string
  dirty: boolean
  /** As in `Code`: a newline at the end of the file ends its last line. An empty file has none. */
  lines: { number: number; text: string }[]
  /** Present when the lines reach the end of the file: whether a newline ends its last line. */
  end?: { final_newline: boolean }
}

export type ToolErrorCode = "no_session" | "session_active" | "no_editor" | "cancelled" | "invalid_arguments"

export class ToolError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
  ) {
    super(message)
  }
}

export * from "./wire"
