// The IntelliJ plugin ↔ host protocol: one JSON object per line, the plugin writing to the host's
// stdin and reading its stdout. Files are absolute paths in the OS's own form; offsets are into the
// document text, in UTF-16 code units (the same as a JVM String's).

import type {
  AgentState,
  Change,
  CommandOutcome,
  CursorView,
  EditOptions,
  Focus,
  PanelEvent,
  SharedSelection,
  TimingOverrides,
} from "@ai-pair/core"

/** The first line the plugin writes. */
export type Init = {
  type: "init"
  root: string
  workspaceFolders: string[]
  speed: number
  timing: TimingOverrides
  confirmCommands: boolean
}

/** The editor methods that answer, by name: their arguments. */
export type Calls = {
  getText: { file: string }
  eol: { file: string }
  isDirty: { file: string }
  show: { file: string }
  /**
   * `seen` is the `version` of the file's last `userEdit` or `otherEdit` the host had when it planned the edit. The
   * changes after that one are the plugin's to shift it through, as if the edit had come first, as `core` assumes.
   */
  edit: { file: string; offset: number; deleteLength: number; text: string; options: EditOptions; seen: number }
  save: { file: string }
  runCommand: { command: string; cwd: string; waitMs: number }
  /** Not an `EditorPort` method: the host changed these files on disk (the demo's setup), so bring the IDE up to date. */
  refresh: { files: string[] }
}

/** What each call answers with. */
export type Results = {
  getText: string
  eol: string
  isDirty: boolean
  show: null
  edit: null
  save: null
  runCommand: CommandOutcome
  refresh: null
}

/** Rendering and narration, which don't answer. */
export type Notices = {
  renderCursor: { cursor: CursorView | null; state: AgentState; focus: Focus }
  renderPoint: { point: { file: string; start: number; end: number } | null }
  reveal: {}
  follow: {}
  post: { event: PanelEvent }
}

/** What the programmer does, for the controller. */
export type Commands = {
  /** `version` counts the document's changes that weren't the agent's, the programmer's and others', this one included. */
  userEdit: { file: string; before: string; changes: Change[]; version: number }
  /** A change the programmer didn't make: a reload from disk, or one made during the agent's save. */
  otherEdit: { file: string; before: string; changes: Change[]; version: number }
  userMessage: { text: string; selection?: SharedSelection }
  userInterrupt: {}
  pause: { reason?: string }
  resume: { reason?: string }
  togglePause: {}
  takeTurn: {}
  handBack: { message?: string; selection?: SharedSelection }
  toggleTurn: { message?: string; selection?: SharedSelection }
  endSession: {}
  decideRun: { id: number; run: boolean; remember?: boolean }
  setSpeed: { speed: number }
  setTiming: { overrides: TimingOverrides }
  setConfirmCommands: { confirm: boolean }
  focused: {}
  setWorkspaceFolders: { folders: string[] }
  playDemo: {}
}

/** One message per method of `T`. */
type Tagged<T, Type extends string> = { [M in keyof T]: { type: Type; method: M; args: T[M] } }[keyof T]

/** Plugin → host. */
export type PluginMessage =
  | Init
  | { type: "result"; id: number; result: unknown }
  | { type: "error"; id: number; message: string }
  | Tagged<Commands, "command">

/** Host → plugin. */
/** `ready.panel` is the narration panel's page, VS Code's own (packages/vscode/src/panelHtml.ts). */
export type HostMessage =
  | { type: "ready"; discovery: string ; panel: string }
  | (Tagged<Calls, "call"> & { id: number })
  | { type: "cancel"; id: number }
  | Tagged<Notices, "notice">
