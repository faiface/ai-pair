// The editor side of the relay connection: a WebSocket server on localhost that forwards tool
// calls to the controller, and the discovery file that lets relays find it.

import { randomBytes, timingSafeEqual } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { WebSocketServer, type WebSocket } from "ws"
import {
  PROTOCOL_VERSION,
  ToolError,
  type Action,
  type Discovery,
  type EditorMessage,
  type RelayMessage,
  type ToolName,
} from "@ai-pair/protocol"
import type { Controller } from "./controller"

export type BridgeOptions = {
  /** Where discovery files live; see `discoveryDir()`. */
  dir: string
  workspaceFolders: () => string[]
}

export class Bridge {
  private server?: WebSocketServer
  private readonly token = randomBytes(24).toString("hex")
  private port = 0
  private lastFocused = Date.now()
  /** The relay connection whose agent started the current (or last) session. */
  private owner: WebSocket | null = null

  constructor(
    private readonly controller: Controller,
    private readonly options: BridgeOptions,
  ) {}

  get file(): string {
    return path.join(this.options.dir, `${process.pid}.json`)
  }

  async start(): Promise<void> {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 })
    this.server = server
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve)
      server.once("error", reject)
    })
    const address = server.address()
    this.port = typeof address === "object" && address ? address.port : 0
    server.on("connection", (ws) => this.accept(ws))
    this.writeDiscovery()
  }

  /** Call when the window gains focus, so relays prefer it among windows with the same folder. */
  focused(): void {
    this.lastFocused = Date.now()
    this.writeDiscovery()
  }

  /** Call when the workspace folders change. */
  writeDiscovery(): void {
    if (!this.server) return
    const discovery: Discovery = {
      pid: process.pid,
      workspaceFolders: this.options.workspaceFolders(),
      port: this.port,
      token: this.token,
      protocolVersion: PROTOCOL_VERSION,
      lastFocused: this.lastFocused,
    }
    fs.mkdirSync(this.options.dir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(this.file, JSON.stringify(discovery), { mode: 0o600 })
  }

  dispose(): void {
    try {
      fs.unlinkSync(this.file)
    } catch {
      // Already gone.
    }
    for (const client of this.server?.clients ?? []) client.terminate()
    this.server?.close()
    this.server = undefined
  }

  private accept(ws: WebSocket): void {
    let authenticated = false
    const calls = new Map<number, AbortController>()
    const send = (m: EditorMessage) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m))
    }

    ws.on("message", (data) => {
      let m: RelayMessage
      try {
        m = JSON.parse(String(data)) as RelayMessage
      } catch {
        return
      }
      if (!authenticated) {
        if (m.type !== "hello" || !this.tokenMatches(m.token)) {
          send({ type: "rejected", reason: "Authentication failed." })
          ws.close()
        } else if (m.protocolVersion !== PROTOCOL_VERSION) {
          send({
            type: "rejected",
            reason: `Protocol version mismatch (editor ${PROTOCOL_VERSION}, relay ${m.protocolVersion}). The extension was updated: reload the VS Code window and restart the agent.`,
          })
          ws.close()
        } else {
          authenticated = true
          send({ type: "welcome" })
        }
        return
      }
      if (m.type === "cancel") {
        calls.get(m.id)?.abort()
      } else if (m.type === "return") {
        if (this.owner === ws) this.controller.restore(m.report)
      } else if (m.type === "call") {
        const abort = new AbortController()
        calls.set(m.id, abort)
        this.dispatch(ws, m.tool, m.args ?? {}, abort.signal)
          .then(
            (result) => send({ type: "result", id: m.id, result }),
            (e: unknown) =>
              send({
                type: "error",
                id: m.id,
                code: e instanceof ToolError ? e.code : "internal",
                message: e instanceof Error ? e.message : String(e),
              }),
          )
          .finally(() => calls.delete(m.id))
      }
    })

    ws.on("close", () => {
      for (const abort of calls.values()) abort.abort()
      if (this.owner === ws) {
        this.owner = null
        this.controller.disconnect()
      }
    })
  }

  private async dispatch(ws: WebSocket, tool: ToolName, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const c = this.controller
    if (tool === "start") {
      if (c.isActive && this.owner !== ws) {
        throw new ToolError("session_active", "Another agent is already pairing in this editor window.")
      }
      const report = await c.start(optionalString(args.task), optionalString(args.cwd))
      this.owner = ws
      return report
    }
    if (this.owner !== ws) {
      throw new ToolError("no_session", "No pairing session is active. Call `start` to begin one.")
    }
    switch (tool) {
      case "step":
        if (!Array.isArray(args.actions)) throw new ToolError("invalid_arguments", "`actions` must be an array.")
        return c.step(args.actions as Action[], signal)
      case "listen":
        return c.listen(signal)
      case "end":
        return c.end(optionalString(args.summary), signal)
      case "read":
        if (typeof args.file !== "string") throw new ToolError("invalid_arguments", "`file` must be a string.")
        return c.read(args.file, optionalNumber(args.from_line), optionalNumber(args.to_line))
      default:
        throw new ToolError("invalid_arguments", `Unknown tool: ${String(tool)}`)
    }
  }

  private tokenMatches(token: unknown): boolean {
    if (typeof token !== "string") return false
    const a = Buffer.from(token)
    const b = Buffer.from(this.token)
    return a.length === b.length && timingSafeEqual(a, b)
  }
}

function optionalString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}

function optionalNumber(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined
}
