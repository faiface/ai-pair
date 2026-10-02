// The editor, on the other side of the link: the IntelliJ plugin does the real work.

import * as nodePath from "node:path"
import type { Writable } from "node:stream"
import {
  withinFolder,
  type AgentState,
  type CommandOutcome,
  type CursorView,
  type EditOptions,
  type EditorPort,
  type Focus,
  type RunOptions,
} from "@ai-pair/core"
import type { Calls, HostMessage, Notices, Results } from "./wire"

export class Link {
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private closed = false

  constructor(private readonly output: Writable) {}

  send(m: HostMessage): void {
    if (!this.closed) this.output.write(JSON.stringify(m) + "\n")
  }

  call<M extends keyof Calls>(method: M, args: Calls[M], signal?: AbortSignal): Promise<Results[M]> {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error("The IDE disconnected."))
      const id = this.nextId++
      this.pending.set(id, { resolve, reject } as Pending)
      this.send({ type: "call", id, method, args } as HostMessage)
      signal?.addEventListener("abort", () => this.send({ type: "cancel", id }), { once: true })
    })
  }

  notify<M extends keyof Notices>(method: M, args: Notices[M]): void {
    this.send({ type: "notice", method, args } as HostMessage)
  }

  /** Settles the call a `result` or `error` answers. */
  answer(id: number, result: unknown, error?: string): void {
    const pending = this.pending.get(id)
    this.pending.delete(id)
    if (error === undefined) pending?.resolve(result)
    else pending?.reject(new Error(error))
  }

  /** The plugin is gone: fail every call still waiting, and send nothing more. */
  close(): void {
    this.closed = true
    for (const pending of this.pending.values()) pending.reject(new Error("The IDE disconnected."))
    this.pending.clear()
  }
}

type Pending = { resolve: (result: unknown) => void; reject: (error: Error) => void }

export class RemoteEditor implements EditorPort {
  constructor(
    private readonly link: Link,
    private readonly root: string,
    public folders: string[],
  ) {}

  resolvePath(file: string): string {
    const resolved = nodePath.resolve(this.root, file)
    for (const folder of this.folders) {
      const inside = withinFolder(folder, resolved)
      if (inside) return inside
    }
    return resolved
  }

  displayPath(file: string): string {
    const rel = nodePath.relative(this.root, file)
    return rel.startsWith("..") || nodePath.isAbsolute(rel) ? file : rel
  }

  getText(file: string): Promise<string> {
    return this.link.call("getText", { file })
  }

  eol(file: string): Promise<string> {
    return this.link.call("eol", { file })
  }

  isDirty(file: string): Promise<boolean> {
    return this.link.call("isDirty", { file })
  }

  async show(file: string): Promise<void> {
    await this.link.call("show", { file })
  }

  async edit(file: string, offset: number, deleteLength: number, text: string, options: EditOptions): Promise<void> {
    await this.link.call("edit", { file, offset, deleteLength, text, options })
  }

  async save(file: string): Promise<void> {
    await this.link.call("save", { file })
  }

  renderCursor(cursor: CursorView | null, state: AgentState, focus: Focus): void {
    this.link.notify("renderCursor", { cursor, state, focus })
  }

  renderPoint(point: { file: string; start: number; end: number } | null): void {
    this.link.notify("renderPoint", { point })
  }

  reveal(): void {
    this.link.notify("reveal", {})
  }

  runCommand(command: string, options: RunOptions): Promise<CommandOutcome> {
    return this.link.call("runCommand", { command, cwd: options.cwd, waitMs: options.waitMs }, options.signal)
  }

  /** Not part of `EditorPort`: brings files the host changed on disk into the IDE. */
  async refresh(files: string[]): Promise<void> {
    await this.link.call("refresh", { files })
  }
}
