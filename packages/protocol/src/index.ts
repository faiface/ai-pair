// Types of the agent-facing protocol. See PROTOCOL.md.

export type Anchor = {
  text: string
  near_line?: number
  direction?: "forward" | "backward"
}

export type Span = Anchor | { from: Anchor; to: Anchor }

export type MoveTarget = (Partial<Anchor> & { position?: "file_start" | "file_end" }) & {
  file?: string
  at?: "start" | "end"
  /** Relative: this many lines down (negative: up) from the cursor, to the end of that line. */
  lines?: number
}

export type Action =
  | { say: string }
  | { move: MoveTarget }
  | { select: Span }
  | { type: string }
  | { type_fast: string }
  | { delete: true }
  | { point: Span & { file?: string } }
  | { run: string; wait?: number }

/** The keys that name an action. An action object has exactly one of them. */
export const ACTION_KINDS = ["say", "move", "select", "type", "type_fast", "delete", "point", "run"] as const

/** The action keys an object has; more than one means actions were combined by mistake. */
export function actionKinds(value: object): string[] {
  return Object.keys(value).filter((k) => (ACTION_KINDS as readonly string[]).includes(k))
}

export type Turn = "agent" | "user"

export type BatchStatus = "completed" | "interrupted" | "failed" | "discarded"

export type ErrorKind =
  | "anchor_not_found"
  | "anchor_ambiguous"
  | "no_selection"
  | "no_file"
  | "not_your_turn"
  | "invalid_action"
  | "command_failed"
  | "command_declined"

export type Candidate = { line: number; context: string }

export type RunResult = {
  index: number
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

export type BatchResult = {
  id: number
  status: BatchStatus
  played: number
  partial?: { index: number; typed: string }
  unplayed?: Action[]
  error?: { index: number; kind: ErrorKind; message?: string; candidates?: Candidate[] }
  runs?: RunResult[]
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
  | { kind: "edit"; file: string; diff: string }
  | { kind: "interrupt" }
  | { kind: "turn"; to: Turn; message?: string; selection?: Excerpt }
  | { kind: "end" }

export type CursorInfo = {
  file: string
  line: number
  column: number
  selection?: { from: { line: number; column: number }; to: { line: number; column: number } }
}

export type Report = {
  batches: BatchResult[]
  submitted?: { id: number; status: "queued" | "playing" | BatchStatus }
  events: Event[]
  turn: Turn
  cursor?: CursorInfo
  waiting?: true
}

export type FileContent = {
  file: string
  dirty: boolean
  lines: { number: number; text: string }[]
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
