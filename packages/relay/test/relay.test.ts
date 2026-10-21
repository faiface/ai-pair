// End to end through MCP: client → relay → WebSocket → bridge → controller → fake editor.

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Bridge, Controller } from "@ai-pair/core"
import { FakeCopy, FakeEditor, FakePanel, testConfig } from "../../core/test/fake"
import { EditorLink, findWindows } from "../src/link"
import { createServer, guideBody } from "../src/server"

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
let copies: { last?: FakeCopy }
const clients: Client[] = []

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-pair-"))
  editor = new FakeEditor()
  panel = new FakePanel()
  editor.files.set(editor.resolvePath("src/a.ts"), "")
  copies = {}
  controller = new Controller(editor, panel, async () => (copies.last = new FakeCopy(editor.files)), fast)
  editor.controller = controller
  bridge = new Bridge(controller, { dir, workspaceFolders: () => ["/project"] })
  await bridge.start()
})

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close()
  bridge.dispose()
  fs.rmSync(dir, { recursive: true, force: true })
})

/** `roots`: the harness's roots, as file URLs, if it has them. */
async function connect(cwd = "/project/src", roots?: string[]): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  const server = createServer(new EditorLink(cwd, dir), { author: "THE AUTHOR GUIDE", presenter: "THE PRESENTER GUIDE" }, cwd)
  await server.connect(serverSide)
  const client = new Client({ name: "test", version: "0" }, { capabilities: roots ? { roots: {} } : {} })
  if (roots) client.setRequestHandler(ListRootsRequestSchema, () => ({ roots: roots.map((uri) => ({ uri })) }))
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
    expect(tools.tools.map((t) => t.name).sort()).toEqual(["end", "join", "listen", "read", "stage", "start", "step", "tell_author", "tell_presenter", "wait"])
    expect(client.getInstructions()).toContain("`start`")
    expect(client.getInstructions()).toContain("`join`")
    const prompt = await client.getPrompt({ name: "start", arguments: { task: "add a todos API" } })
    expect(JSON.stringify(prompt.messages)).toContain("The task: add a todos API")
  })

  it("runs a staged session: the author records, a presenter joins and writes the stage, then ends it", async () => {
    const author = await connect()
    const started = await call(author, "start", { task: "test" })
    expect(started.error).toBe(false)
    expect(started.text).toMatch(/started/)
    expect(started.content[1]!.text).toContain("THE AUTHOR GUIDE")

    copies.last!.write("src/a.ts", "hi\n")
    expect((await call(author, "stage", { title: "Greeting", notes: "Say hi." })).error).toBe(false)
    expect(editor.text("src/a.ts")).toBe("")

    const presenter = await connect()
    const joined = await call(presenter, "join")
    expect(joined.error).toBe(false)
    expect(joined.content[1]!.text).toContain("THE PRESENTER GUIDE")
    expect(joined.text).toMatch(/Stage 1 began: Greeting/)
    expect(joined.text).toMatch(/\+ hi/)

    expect((await call(presenter, "step", { beats: [{ say: "Hi.", do: [{ write: { file: "a.ts" } }] }] })).text).toMatch(/Batch 1 is playing/)
    const played = await call(presenter, "step", { beats: [] })
    expect(played.text).toMatch(/Batch 1 completed/)
    expect(editor.text("src/a.ts")).toBe("hi\n")
    expect((await call(author, "wait")).text).toMatch(/Playback has caught up: stage 1/)

    // With a presenter there, it ends the session, once the programmer is done.
    expect((await call(author, "end")).text).toMatch(/presenter ends the session/)
    expect((await call(presenter, "end", { summary: "Done." })).text).toMatch(/ended/)
    expect(panel.events).toContainEqual({ type: "session", active: false, reason: "agent", summary: "Done." })
    expect((await call(presenter, "listen")).text).toMatch(/^no_session:/)
  })

  it("keeps the session when the presenter leaves: the author hears it, and another presenter takes over", async () => {
    const author = await connect()
    await call(author, "start")
    copies.last!.write("src/a.ts", "hi\n")
    await call(author, "stage", { title: "Greeting", notes: "" })
    await call(await connect(), "join")
    expect((await call(author, "wait")).text).toMatch(/The presenter joined/)
    for (const ws of bridge["presenters"]) ws.close()
    expect((await call(author, "wait")).text).toMatch(/The presenter left/)
    expect(controller.isActive).toBe(true)

    const next = await call(await connect(), "join")
    expect(next.error).toBe(false)
    expect(next.text).toMatch(/\+ hi/)
  })

  it("rejects malformed actions before they reach the editor", async () => {
    const client = await connect()
    await call(client, "start")
    await call(client, "join")
    const bad = await call(client, "step", { beats: [{ do: [{ typo: "x" }] }] })
    expect(bad.text).toMatch(/Not an action/)
    // Two actions in one object: zod would otherwise strip one of them silently.
    const combined = await call(client, "step", { beats: [{ do: [{ move: { line: 1, to: "line_end" }, type: "x" }] }] })
    expect(combined.text).toMatch(/One action per object, got `move` and `type`/)
    const extra = await call(client, "step", { beats: [{ do: [{ move: { line: 1, to: "line_end", txt: "x" } }] }] })
    expect(extra.error).toBe(true)
    expect(extra.text).toMatch(/txt/)
    const malformed = await call(client, "step", { beats: [{ do: [{ move: { line: "3", to: "line_end" } }] }] })
    expect(malformed.text).toMatch(/`line` is a line number/)
    const old = await call(client, "step", { beats: [{ do: [{ move: { line: 1, before: "x", after: "" } }] }] })
    expect(old.text).toMatch(/A spot is one text, `at`/)
    const unmarked = await call(client, "step", { beats: [{ do: [{ move: { line: 1, at: "x" } }] }] })
    expect(unmarked.text).toMatch(/marks where your cursor goes with ▌/)
    const end = await call(client, "step", { beats: [{ do: [{ move: { to: "end" } }] }] })
    expect(end.text).toMatch(/`to` is `"line_end"`/)
    const plain = await call(client, "step", { beats: [{ do: [{ type: "x" }] }] })
    expect(plain.error).toBe(true)
    expect(plain.text).toMatch(/Mark where your cursor ends with ▌/)
    const pair = await call(client, "step", { beats: [{ do: [{ type_fast: ["f(", ")"] }] }] })
    expect(pair.text).toMatch(/one text, with ▌ where your cursor ends/)
    const twice = await call(client, "step", { beats: [{ do: [{ type: "f(▌)▌" }] }] })
    expect(twice.text).toMatch(/has 2 ▌/)
    const near = await call(client, "step", { beats: [{ do: [{ select: { text: "x", near_line: 3 } }] }] })
    expect(near.text).toMatch(/Give `line`: the line the code starts on/)
    const range = await call(client, "step", { beats: [{ do: [{ point: { line: 1, from: "a", to: "b" } }] }] })
    expect(range.text).toMatch(/The end of a range is `through`/)
    const nothing = await call(client, "step", { beats: [{ do: [{ select: { line: 1 } }] }] })
    expect(nothing.text).toMatch(/Give the code: `text`, or `from` and `through`/)
    // The flat list of actions from before beats, and a `say` among the actions: both say where things go.
    const flat = await call(client, "step", { beats: [{ move: { line: 1, to: "line_end" } }] })
    expect(flat.text).toMatch(/put `move` in its `do` list/)
    const inside = await call(client, "step", { beats: [{ do: [{ say: "Hi." }] }] })
    expect(inside.text).toMatch(/`say` goes on the beat/)
    const empty = await call(client, "step", { beats: [{}] })
    expect(empty.text).toMatch(/A beat needs a `say`, actions in `do`, or both/)
  })

  it("lets only one agent pair in a window at a time", async () => {
    const one = await connect()
    const two = await connect()
    await call(one, "start")
    expect((await call(two, "start")).text).toMatch(/^session_active:/)
    expect((await call(two, "listen")).text).toMatch(/^no_session:/)
    // Joining makes it the presenter, and only the author records stages.
    await call(two, "join")
    expect((await call(two, "stage", { title: "x", notes: "" })).text).toMatch(/^invalid_arguments:/)
  })

  // The programmer acts right after the cancellation, before it reaches the editor, so the
  // cancelled call returns their message. It must still reach the agent.
  it("cancels a blocked call without losing the report, even when racing", async () => {
    const client = await connect()
    await call(client, "start")
    await call(client, "join")
    await call(client, "step", { beats: [{ do: [{ move: { file: "a.ts", line: 1, to: "line_end" } }] }] })
    const abort = new AbortController()
    const listening = call(client, "listen", {}, abort.signal).catch((e: unknown) => e)
    await new Promise((r) => setTimeout(r, 50))
    abort.abort()
    expect(await listening).toBeInstanceOf(Error)

    controller.userMessage("hello")
    const report = await call(client, "listen")
    expect(report.text).toMatch(/hello/)
    expect(report.text).toMatch(/Batch 1 completed/)
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
    const given = await call(client, "start", { cwd: "/also/elsewhere" })
    expect(given.text).toMatch(/^no_editor: No VS Code window has \/also\/elsewhere open/)
  })

  it("works in the folder the agent gives, when the harness started the relay somewhere else", async () => {
    const client = await connect("/")
    expect((await call(client, "start", { cwd: "/project/src" })).error).toBe(false)
    await call(client, "join")
    await call(client, "step", { beats: [{ do: [{ move: { file: "a.ts", line: 1, to: "line_end" } }, { type: "hi▌" }] }] })
    await call(client, "step", { beats: [] })
    expect(editor.text("src/a.ts")).toBe("hi")
  })

  it("works in the harness's root, and in the relay's folder when the agent's isn't open", async () => {
    const rooted = await connect("/", ["file:///elsewhere", "file:///project/src"])
    expect((await call(rooted, "start")).error).toBe(false)
    expect((await call(rooted, "read", { file: "a.ts" })).error).toBe(false)
    await call(rooted, "end")

    const client = await connect("/project/src")
    expect((await call(client, "start", { cwd: "/elsewhere" })).error).toBe(false)
    expect((await call(client, "read", { file: "a.ts" })).error).toBe(false)
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
    const tokens = (folders: string[]) => findWindows(folders, dir).windows.map((w) => w.token)
    expect(tokens(["/work/app/src"])).toEqual(["inner-new.json", "inner-old.json", "outer.json"])
    expect(tokens(["/work/lib"])).toEqual(["outer.json"])
    expect(findWindows(["/", "/work/lib", "/work/app"], dir).folder).toBe("/work/lib")
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

describe("guides", () => {
  it("are everything after the first horizontal rule, whatever the line endings", () => {
    const lf = "# Presenter Guide\n\nFor maintainers.\n\n---\n\n## You are presenting\n\nPlay.\n"
    expect(guideBody(lf)).toBe("## You are presenting\n\nPlay.")
    expect(guideBody(lf.replaceAll("\n", "\r\n"))).toBe("## You are presenting\r\n\r\nPlay.")
  })
})
