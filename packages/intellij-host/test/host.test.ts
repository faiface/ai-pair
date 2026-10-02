// End to end: MCP client → relay → WebSocket → the host's Bridge and Controller → stdio → a fake
// plugin, which does the editing with core's fake editor.

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { createInterface } from "node:readline"
import { PassThrough } from "node:stream"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { afterEach, beforeEach, expect, it } from "vitest"
import { FakeEditor, testConfig } from "../../core/test/fake"
import { EditorLink } from "../../relay/src/link"
import { createServer } from "../../relay/src/server"
import { SERVER, TODOS } from "../../vscode/src/demoScript"
import { runHost } from "../src/host"
import type { HostMessage, PluginMessage } from "../src/wire"

type Call = Extract<HostMessage, { type: "call" }>

/** Plays the IntelliJ plugin, with core's fake editor. */
class FakePlugin {
  readonly editor = new FakeEditor()
  readonly notices: HostMessage[] = []
  readonly done: Promise<void>
  readonly ready: Promise<string>
  private readonly toHost = new PassThrough()
  private readonly fromHost = new PassThrough()
  private readonly running = new Map<number, AbortController>()

  constructor(dir: string) {
    this.done = runHost(this.toHost, this.fromHost, dir)
    this.ready = new Promise((resolve) => {
      createInterface({ input: this.fromHost }).on("line", (line) => {
        const m = JSON.parse(line) as HostMessage
        if (m.type === "ready") resolve(m.discovery)
        else if (m.type === "call") void this.answer(m)
        else if (m.type === "cancel") this.running.get(m.id)?.abort()
        else this.notices.push(m)
      })
    })
  }

  send(m: PluginMessage): void {
    this.toHost.write(JSON.stringify(m) + "\n")
  }

  quit(): Promise<void> {
    if (!this.toHost.writableEnded) this.toHost.end()
    return this.done
  }

  private async answer(call: Call): Promise<void> {
    try {
      this.send({ type: "result", id: call.id, result: await this.perform(call) })
    } catch (e) {
      this.send({ type: "error", id: call.id, message: String(e) })
    }
  }

  private perform(call: Call): Promise<unknown> {
    const e = this.editor
    switch (call.method) {
      case "getText":
        return e.getText(call.args.file)
      case "eol":
        return e.eol(call.args.file)
      case "isDirty":
        return e.isDirty(call.args.file)
      case "show":
        return e.show(call.args.file)
      case "edit": {
        const { file, offset, deleteLength, text, options } = call.args
        return e.edit(file, offset, deleteLength, text, options)
      }
      case "save":
        return e.save(call.args.file)
      case "runCommand": {
        const { command, cwd, waitMs } = call.args
        const abort = new AbortController()
        this.running.set(call.id, abort)
        return e.runCommand(command, { cwd, waitMs, signal: abort.signal }).finally(() => this.running.delete(call.id))
      }
      case "refresh":
        // Like the VFS: what's on disk replaces what the editor had.
        for (const file of call.args.files) {
          if (fs.existsSync(file)) e.files.set(file, fs.readFileSync(file, "utf8"))
          else e.files.delete(file)
        }
        return Promise.resolve(null)
    }
  }
}

const root = path.resolve("/project")
const fast = {
  ...testConfig.timing,
  type: { ...testConfig.timing.type, charMs: 0.5 },
  reading: { msPerWord: 1, minMs: 5, maxMs: 5 },
  beforeMoveMs: 5,
  beforeSelectMs: 5,
}

let dir: string
let plugin: FakePlugin
let client: Client

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-pair-"))
  plugin = new FakePlugin(dir)
  plugin.editor.files.set(path.join(root, "src", "a.ts"), "")
  plugin.send({ type: "init", root, workspaceFolders: [root], speed: 1, timing: fast, confirmCommands: false })
  await plugin.ready
  const cwd = path.join(root, "src")
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await createServer(new EditorLink(cwd, dir), "THE GUIDE", cwd).connect(serverSide)
  client = new Client({ name: "test", version: "0" })
  await client.connect(clientSide)
})

afterEach(async () => {
  await client.close()
  await plugin.quit()
  fs.rmSync(dir, { recursive: true, force: true })
})

async function call(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const result = await client.callTool({ name, arguments: args })
  return (result.content as { text: string }[])[0]!.text
}

it("plays a batch in the plugin's editor", async () => {
  await call("start", { task: "test" })
  await call("step", { actions: [{ move: { file: "a.ts", line: 1, to: "line_end" } }, { type: "hi▌" }] })
  expect(await call("step", { actions: [] })).toMatch(/Batch 1 completed/)
  expect(plugin.editor.text("src/a.ts")).toBe("hi")
  expect(plugin.notices).toContainEqual(expect.objectContaining({ method: "renderCursor" }))
})

it("forwards the programmer's messages to the agent", async () => {
  await call("start", { task: "test" })
  const listening = call("listen")
  plugin.send({ type: "command", method: "userMessage", args: { text: "hello from IntelliJ" } })
  expect(await listening).toMatch(/hello from IntelliJ/)
})

it("removes its discovery file when the IDE goes away", async () => {
  const discovery = await plugin.ready
  expect(fs.existsSync(discovery)).toBe(true)
  await plugin.quit()
  expect(fs.existsSync(discovery)).toBe(false)
})

it("plays the demo, with its files set up on disk and refreshed in the IDE", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ai-pair-"))
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "ai-pair-demo-"))
  const server = path.join(project, SERVER)
  const todos = path.join(project, TODOS)
  // Left over from an earlier run, on disk and in the editor.
  fs.mkdirSync(path.dirname(todos), { recursive: true })
  fs.writeFileSync(todos, "stale")
  const demo = new FakePlugin(home)
  demo.editor.files.set(server, "stale")
  demo.editor.files.set(todos, "stale")
  demo.send({ type: "init", root: project, workspaceFolders: [project], speed: 20, timing: fast, confirmCommands: false })
  await demo.ready
  try {
    demo.send({ type: "command", method: "playDemo", args: {} })
    const sessions = () => demo.notices.filter((m) => m.type === "notice" && m.method === "post" && m.args.event.type === "session")
    for (let i = 0; i < 1000 && sessions().length < 2; i++) await new Promise((r) => setTimeout(r, 20))
    expect(sessions()).toHaveLength(2)
    // The last lines the script types: it played through without stopping early.
    expect(demo.editor.files.get(todos)).toMatch(/^export interface Todo \{[^]*export function listTodos\(\): Todo\[\] \{\n  return todos;\n\}\n$/)
    expect(demo.editor.files.get(server)).toContain('import { createTodo, listTodos } from "./todos";')
  } finally {
    await demo.quit()
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(project, { recursive: true, force: true })
  }
}, 30_000)
