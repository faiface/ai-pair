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
  /** For a command still running: settles when it ends, with its exit code if the terminal reported one. */
  exited?: Promise<number | undefined>
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
  /** Deletes the file, closing it in the editor: a stage that removes it, once its lines are out. */
  deleteFile(file: string): Promise<void>
  renderCursor(cursor: CursorView | null, state: AgentState, focus: Focus): void
  renderPoint(point: { file: string; start: number; end: number } | null): void
  /** Brings the programmer's view back to what it follows. */
  reveal(): void
  /** Keeps what the view follows in view, after a keystroke, move, selection or point of the agent changed it. */
  follow(): void
  /** Runs a command in a terminal the programmer can see. */
  runCommand(command: string, options: RunOptions): Promise<CommandOutcome>
}

export type PanelEvent =
  | { type: "session"; active: true; task?: string }
  | { type: "session"; active: false; reason: "agent" | "user" | "disconnected"; summary?: string }
  | { type: "say"; text: string }
  | { type: "reading"; ms: number }
  | {
      type: "state"
      state: AgentState
      turn: Turn
      paused: boolean
      /** Batches written and waiting behind the one playing. */
      ahead: number
      /** The agent is working on its next call, not waiting in one: thinking, or writing ahead. */
      working: boolean
    }
  | { type: "user"; text: string; ref?: Ref }
  | { type: "turn"; to: Turn; message?: string; ref?: Ref }
  | { type: "interrupt" }
  | { type: "point"; file: string; line: number }
  | {
      type: "run"
      id: number
      command: string
      /** `exited`: a command left running in the background has ended since. */
      phase: "confirm" | "running" | "done" | "declined" | "background" | "exited"
      exitCode?: number
      /** With `confirm`: the program the command runs, which the programmer can allow for the session. */
      program?: string
    }
  /** A stage of the author's starts playing: the panel marks where. */
  | { type: "stage"; number: number; title: string }
  /** The session ended with stages played: the prepared version can be compared with the code. */
  | { type: "compare" }

export interface PanelPort {
  post(event: PanelEvent): void
}

/**
 * The agent's voice, when there is one: it speaks a `say` out loud instead of leaving it to be read.
 * `speak` settles when the words have been spoken, or dropped, or stopped; it never rejects playback.
 * `spanMs` is how long the work the `say` covers will take to play: spread the words across it, so
 * talking and typing run together and finish about together. `onStart` is called once, when the
 * first words are heard — or when they never will be (dropped, stopped, failed) — since making
 * speech takes a moment, and the typing a `say` covers must not run ahead of its words.
 * `signal` takes back just these words, cut off if they're sounding: they've gone stale.
 */
export interface VoicePort {
  /** Loaded and able to speak now. Not ready, playback falls back to the reading pause. */
  readonly ready: boolean
  /** The programmer turned it on: they listen to the agent's words, even while the voice still loads. */
  readonly enabled: boolean
  speak(text: string, spanMs?: number, onStart?: () => void, signal?: AbortSignal): Promise<void>
  /**
   * Starts making a `say`'s speech before it is spoken: called when its batch is queued, with the
   * span `speak` will get, so the words are ready when the batch starts. `stop` drops what's made.
   */
  prepare(text: string, spanMs: number): void
  /** Cuts off what is being said and drops what is queued: interrupted words are stale words. */
  stop(): void
}

/**
 * Key sounds, when they are on: told of each keystroke of the agent's as it lands. `text` is what
 * the keystroke put in (a newline comes with the indent after it), or `"\b"` for a deletion.
 */
export interface KeysPort {
  press(text: string): void
}

/** A change to a document, in the coordinates of the text before it. */
export type Change = { offset: number; deleteLength: number; text: string }

/** A file a stage changes, as it reads before and after it: `undefined` where it doesn't exist. */
export type StageChange = { file: string; before?: string; after?: string; binary?: true }

/**
 * The author's private copy of the workspace, where it does the real work, unseen. It records the
 * copy as it goes, in snapshots: each stage is one. Files are named by their absolute paths in the
 * workspace, never in the copy, except `root`.
 */
export interface CopyPort {
  /** Where the author works: the copy's counterpart of the workspace folder it was made for. */
  readonly root: string
  /** The snapshot of the copy as it was made, the workspace as it was then. */
  readonly base: string
  /** Records the copy as it is now, and returns the snapshot's id. */
  snapshot(): Promise<string>
  /** The files that differ between two snapshots, with their texts, or only `binary` for a binary file. */
  changes(from: string, to: string): Promise<StageChange[]>
  /** Writes a snapshot's version of a binary file over the workspace's, or deletes it if the snapshot has none. */
  restore(snapshot: string, file: string): Promise<void>
  /**
   * Brings a change made in the workspace, `before` to `after`, into the copy's file. Where the
   * author has since changed the same lines, the author's version stays: false then, or if the file
   * is gone from the copy.
   */
  carry(file: string, before: string, after: string): Promise<boolean>
  /** Removes the copy. */
  dispose(): Promise<void>
}

/** Makes a private copy of the workspace folder `root`, as it is on disk. */
export type CopyFactory = (root: string) => Promise<CopyPort>
