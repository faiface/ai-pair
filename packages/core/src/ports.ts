// What the core needs from the editor and the narration panel.

import type { Excerpt, Turn } from "@ai-pair/protocol"

export type AgentState = "typing" | "read" | "running" | "thinking" | "paused" | "listening" | "navigator"

/** What follow mode keeps in the programmer's view: the agent cursor, or the code it last pointed at. */
export type Focus = "cursor" | "point"

export type CursorView = {
  file: string
  offset: number
  selection?: { start: number; end: number }
}

export type EditOptions = { undoStopBefore: boolean; undoStopAfter: boolean }

export type CommandOutcome = {
  /** Absent while still running, or when the terminal couldn't report it. */
  exitCode?: number
  output: string
  truncated?: boolean
  running?: boolean
  /** The terminal's shell, e.g. `pwsh` or `zsh`, when it's known. */
  shell?: string
  /** Interrupted before the command was sent to the terminal. */
  notStarted?: boolean
}

export type RunOptions = {
  /** Directory to run in (absolute). */
  cwd: string
  /** Stop waiting after this long; the command keeps running. */
  waitMs: number
  /** Aborted when playback is interrupted: stop waiting, leave the command running. */
  signal: AbortSignal
}

/** An excerpt whose `file` is absolute, as the editor knows it. */
export type SharedSelection = Excerpt

export type Ref = { file: string; line: number; endLine: number }

/** Files are absolute paths; offsets are into the document text. */
export interface EditorPort {
  /**
   * Absolute path for a path given by the agent (absolute or workspace-relative), in the same
   * canonical form the editor reports files in (e.g. VS Code lowercases the Windows drive letter).
   */
  resolvePath(file: string): string
  /** How to name a file to the agent. */
  displayPath(file: string): string
  /** Buffer contents if open, otherwise from disk. */
  getText(file: string): Promise<string>
  /** The line ending the editor stores in the file, "\n" or "\r\n", known even for an empty buffer. */
  eol(file: string): Promise<string>
  isDirty(file: string): Promise<boolean>
  /** Opens the file (creating it empty if missing) and makes it the visible editor. */
  show(file: string): Promise<void>
  edit(file: string, offset: number, deleteLength: number, text: string, options: EditOptions): Promise<void>
  save(file: string): Promise<void>
  renderCursor(cursor: CursorView | null, state: AgentState, focus: Focus): void
  renderPoint(point: { file: string; start: number; end: number } | null): void
  /** Brings the programmer's view back to what it follows. */
  reveal(): void
  /** Runs a command in a terminal the programmer can see. */
  runCommand(command: string, options: RunOptions): Promise<CommandOutcome>
}

export type PanelEvent =
  | { type: "session"; active: true; task?: string }
  | { type: "session"; active: false; reason: "agent" | "user" | "disconnected"; summary?: string }
  | { type: "say"; text: string }
  | { type: "reading"; ms: number }
  | { type: "state"; state: AgentState; turn: Turn; paused: boolean }
  | { type: "user"; text: string; ref?: Ref }
  | { type: "turn"; to: Turn; message?: string; ref?: Ref }
  | { type: "interrupt" }
  | { type: "point"; file: string; line: number }
  | {
      type: "run"
      id: number
      command: string
      phase: "confirm" | "running" | "done" | "declined" | "background"
      exitCode?: number
    }

export interface PanelPort {
  post(event: PanelEvent): void
}

/** A change to a document, in the coordinates of the text before it. */
export type Change = { offset: number; deleteLength: number; text: string }
