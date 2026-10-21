// Messages between the relay (pair-mcp) and the editor, over a local WebSocket.
// See "Discovery and connection" in ARCHITECTURE.md.

import * as os from "node:os"
import * as path from "node:path"
import type { AuthorReport, Report, ToolErrorCode } from "./index"

export const PROTOCOL_VERSION = 5

/** Written by each editor window to `<discoveryDir>/<pid>.json`. */
export type Discovery = {
  pid: number
  workspaceFolders: string[]
  port: number
  token: string
  protocolVersion: number
  /** Epoch milliseconds. */
  lastFocused: number
}

export function aiPairHome(): string {
  return process.env.AI_PAIR_HOME ?? path.join(os.homedir(), ".ai-pair")
}

export function discoveryDir(): string {
  return path.join(aiPairHome(), "windows")
}

/** The author's tools: it works in a private copy and records stages. */
export type AuthorTool = "start" | "stage" | "wait" | "tell_presenter"
/** The presenter's tools: it plays the author's stages in the programmer's editor. */
export type PresenterTool = "join" | "step" | "listen" | "read" | "tell_author"
export type ToolName = AuthorTool | PresenterTool | "end"

export type RelayMessage =
  | { type: "hello"; token: string; protocolVersion: number }
  | { type: "call"; id: number; tool: ToolName; args: Record<string, unknown> }
  | { type: "cancel"; id: number }
  /** A report that arrived for a call the agent had already cancelled: deliver it again. */
  | { type: "return"; report: Report }
  | { type: "return"; author: AuthorReport }

export type EditorMessage =
  | { type: "welcome" }
  | { type: "rejected"; reason: string }
  | { type: "result"; id: number; result: unknown }
  | { type: "error"; id: number; code: ToolErrorCode | "internal"; message: string }
