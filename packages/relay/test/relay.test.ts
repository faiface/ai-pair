// End to end through MCP: client → relay → WebSocket → bridge → controller → fake editor.

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Bridge, Controller } from "@ai-pair/core"
import { FakeEditor, FakePanel, testConfig } from "../../core/test/fake"
import { EditorLink, findWindows } from "../src/link"
import { agentGuide, createServer } from "../src/server"

const fast = {
  ...testConfig,
  timing: {
    ...testConfig.timing,
    type: { ...testConfig.timing.type, charMs: 0.5 },
    reading: { msPerWord: 1, minMs: 5, maxMs: 5 },
    beforeMoveMs: 5,
    beforeSelectMs: 5,
  },
  navigatorIdleMs: 50,
}

let dir: string
let editor: FakeEditor
let panel: FakePanel
let controller: Controller
let bridge: Bridge
const clients: Client[] = []

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-pair-"))
  editor = new FakeEditor()
  panel = new FakePanel()
  editor.files.set(editor.resolvePath("src/a.ts"), "")
  controller = new Controller(editor, panel, fast)
  editor.controller = controller
  bridge = new Bridge(controller, { dir, workspaceFolders: () => ["/project"] })
  await bridge.start()
})

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close()
  bridge.dispose()
  fs.rmSync(dir, { recursive: true, force: true })
})

async function connect(cwd = "/project/src"): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  const server = createServer(new EditorLink(cwd, dir), "THE GUIDE", cwd)
  await server.connect(serverSide)
  const client = new Client({ name: "test", version: "0" })
  await client.connect(clientSide)
  clients.push(client)
  return client
}

type Content = { type: string; text: string }[]

async function call(client: Client, name: string, args: Record<string, unknown> = {}, signal?: AbortSignal) {
  const result = await client.callTool({ name, arguments: args }, undefined, { signal })
  const content = result.content as Content
  return { error: result.isError === true, text: content[0]!.text, content }
}

describe("relay", () => {
  it("lists the tools and the prompt, with short instructions", async () => {
    const client = await connect()
    const tools = await client.listTools()
    expect(tools.tools.map((t) => t.name).sort()).toEqual(["end", "listen", "read", "start", "step"])
    expect(client.getInstructions()).toContain("`start`")
    const prompt = await client.getPrompt({ name: "start", arguments: { task: "add a todos API" } })
    expect(JSON.stringify(prompt.messages)).toContain("The task: add a todos API")
  })

  it("runs a session: start with the guide, pipelined steps, read, end", async () => {
    const client = await connect()
    const started = await call(client, "start", { task: "test" })
    expect(started.error).toBe(false)
    expect(JSON.parse(started.text)).toEqual({ batches: [], events: [], turn: "agent" })
    expect(started.content[1]!.text).toContain("THE GUIDE")

    const first = JSON.parse((await call(client, "step", { actions: [{ move: { file: "a.ts" } }, { type: "hi" }] })).text)
    expect(first.submitted).toEqual({ id: 1, status: "playing" })
    const second = JSON.parse((await call(client, "step", { actions: [] })).text)
    expect(second.batches).toEqual([{ id: 1, status: "completed", played: 2 }])
    expect(editor.text("src/a.ts")).toBe("hi")

    const read = JSON.parse((await call(client, "read", { file: "a.ts" })).text)
    expect(read).toEqual({ file: "a.ts", dirty: false, lines: [{ number: 1, text: "hi" }] })

    const ended = await call(client, "end", { summary: "Done." })
    expect(ended.error).toBe(false)
    expect(panel.events).toContainEqual({ type: "session", active: false, reason: "agent", summary: "Done." })
    expect((await call(client, "listen")).text).toMatch(/^no_session:/)
  })

  it("rejects malformed actions before they reach the editor", async () => {
    const client = await connect()
    await call(client, "start")
    const bad = await call(client, "step", { actions: [{ typo: "x" }] })
    expect(bad.text).toMatch(/Not an action/)
    // Two actions in one object: zod would otherwise strip one of them silently.
    const combined = await call(client, "step", { actions: [{ move: { position: "file_end" }, type: "x" }] })
    expect(combined.text).toMatch(/One action per object, got `move` and `type`/)
    const extra = await call(client, "step", { actions: [{ move: { position: "file_end", txt: "x" } }] })
    expect(extra.error).toBe(true)
    expect(extra.text).toMatch(/txt/)
  })

  it("lets only one agent pair in a window at a time", async () => {
    const one = await connect()
    const two = await connect()
    await call(one, "start")
    expect((await call(two, "start")).text).toMatch(/^session_active:/)
    expect((await call(two, "listen")).text).toMatch(/^no_session:/)
  })

  // The programmer acts right after the cancellation, before it reaches the editor, so the
  // cancelled call returns their message. It must still reach the agent.
  it("cancels a blocked call without losing the report, even when racing", async () => {
    const client = await connect()
    await call(client, "start")
    await call(client, "step", { actions: [{ move: { file: "a.ts" } }] })
    const abort = new AbortController()
    const listening = call(client, "listen", {}, abort.signal).catch((e: unknown) => e)
    await new Promise((r) => setTimeout(r, 50))
    abort.abort()
    expect(await listening).toBeInstanceOf(Error)

    controller.userMessage("hello")
    const report = JSON.parse((await call(client, "listen")).text)
    expect(report.batches).toEqual([{ id: 1, status: "completed", played: 1 }])
    expect(report.events).toEqual([{ kind: "message", text: "hello" }])
  })

  it("ends the session when the agent's harness goes away", async () => {
    const client = await connect()
    await call(client, "start")
    await client.close()
    await new Promise((r) => setTimeout(r, 50))
    // The in-memory transport closing doesn't close the WebSocket by itself; the process exiting
    // does. Simulate that by disposing of every relay connection.
    for (const c of bridge["server"]?.clients ?? []) c.close()
    await new Promise((r) => setTimeout(r, 50))
    expect(controller.isActive).toBe(false)
    expect(panel.events).toContainEqual({ type: "session", active: false, reason: "disconnected" })
  })

  it("explains when no editor has the project open", async () => {
    const client = await connect("/elsewhere")
    expect((await call(client, "start")).text).toMatch(/^no_editor: No VS Code window has \/elsewhere open/)
  })
})

describe("discovery", () => {
  it("picks the most specific workspace folder, then the most recently focused window", () => {
    const write = (name: string, folders: string[], lastFocused: number) =>
      fs.writeFileSync(
        path.join(dir, name),
        JSON.stringify({ pid: process.pid, workspaceFolders: folders, port: 1, token: name, protocolVersion: 1, lastFocused }),
      )
    write("outer.json", ["/work"], 3)
    write("inner-old.json", ["/work/app"], 1)
    write("inner-new.json", ["/work/app"], 2)
    write("dead.json", ["/work/app/src"], 9)
    const dead = JSON.parse(fs.readFileSync(path.join(dir, "dead.json"), "utf8"))
    fs.writeFileSync(path.join(dir, "dead.json"), JSON.stringify({ ...dead, pid: 999_999_999 }))
    expect(findWindows("/work/app/src", dir).map((w) => w.token)).toEqual(["inner-new.json", "inner-old.json", "outer.json"])
    expect(findWindows("/work/lib", dir).map((w) => w.token)).toEqual(["outer.json"])
  })

  it("skips a window whose file outlived it, even when its pid now belongs to another process", async () => {
    fs.writeFileSync(
      path.join(dir, "stale.json"),
      JSON.stringify({ pid: process.pid, workspaceFolders: ["/project"], port: 1, token: "x", protocolVersion: 1, lastFocused: Date.now() + 60_000 }),
    )
    const client = await connect()
    expect((await call(client, "start")).error).toBe(false)
  })
})

describe("agent guide", () => {
  it("is everything after the first horizontal rule, whatever the line endings", () => {
    const lf = "# Agent Guide\n\nFor maintainers.\n\n---\n\n## You are pair programming\n\nDrive.\n"
    expect(agentGuide(lf)).toBe("## You are pair programming\n\nDrive.")
    expect(agentGuide(lf.replaceAll("\n", "\r\n"))).toBe("## You are pair programming\r\n\r\nDrive.")
  })
})
