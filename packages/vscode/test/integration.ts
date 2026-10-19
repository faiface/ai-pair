// Runs inside a real VS Code (see scripts/integration.sh): plays the demo and checks the result,
// then that changes the programmer didn't make are reported as not theirs, interrupting only batches
// planned against the text before them, and that a programmer edit interrupts, with an exact report.

import * as assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import * as vscode from "vscode"
import type { Api } from "../src/extension"

const EXPECTED_TODOS = `export interface Todo {
  id: number;
  title: string;
  done: boolean;
}

const todos: Todo[] = [];
let nextId = 1;

export function createTodo(title: string): Todo {
  const todo = { id: nextId++, title, done: false };
  todos.push(todo);
  return todo;
}

export function listTodos(): Todo[] {
  return todos;
}
`

const EXPECTED_SERVER = `import express from "express";
import { createTodo, listTodos } from "./todos";

const app = express();
app.use(express.json());

app.post("/todos", (req, res) => {
  const todo = createTodo(req.body.title);
  res.status(201).json(todo);
});

app.get("/todos", (req, res) => {
  res.json(listTodos());
});

app.listen(3000, () => console.log("Listening on http://localhost:3000"));
`

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Inserts text as the programmer would, while the agent may be typing into the same document. VS Code
 * rejects an extension's edit made against a version the document has moved past, which the agent's
 * next keystroke may do at any moment; the programmer typing would simply go through, so try again.
 */
async function insertAsProgrammer(uri: vscode.Uri, position: vscode.Position, text: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const edit = new vscode.WorkspaceEdit()
    edit.insert(uri, position, text)
    if (await vscode.workspace.applyEdit(edit)) return
    await sleep(5)
  }
  assert.fail("VS Code kept rejecting the programmer's edit")
}

export async function run(): Promise<void> {
  const ext = vscode.extensions.getExtension("michalstrba.ai-pair")
  assert.ok(ext, "extension not found")
  const api = (await ext.activate()) as Api
  const root = vscode.workspace.workspaceFolders![0]!.uri.fsPath
  const file = (name: string) => path.join(root, name)
  const buffer = async (name: string) => (await vscode.workspace.openTextDocument(file(name))).getText()
  const disk = async (name: string) =>
    new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.file(file(name))))

  // The demo, sped up. If our own edits were mistaken for the programmer's, it would stop early.
  api.controller.setSpeed(20)
  // Each step waits for the batches before it, so a test sees each one's report in turn.
  api.controller.setWorkAhead(0)
  const started = Date.now()
  await api.playDemo()
  console.log(`demo played in ${Date.now() - started} ms`)
  assert.equal(await buffer("ai-pair-demo/src/todos.ts"), EXPECTED_TODOS)
  assert.equal(await buffer("ai-pair-demo/src/server.ts"), EXPECTED_SERVER)
  assert.equal(await disk("ai-pair-demo/src/server.ts"), EXPECTED_SERVER, "saved after each batch")

  // Changes the programmer didn't make are reported, without interrupting: a tool writing to another file...
  const c = api.controller
  c.setSpeed(1)
  const until = async (done: () => boolean) => {
    for (let i = 0; i < 100 && !done(); i++) await sleep(50)
    assert.ok(done(), "timed out")
  }
  fs.writeFileSync(file("other.txt"), "before\n")
  const other = await vscode.workspace.openTextDocument(file("other.txt"))
  await c.start("other edits")
  await c.step([{ do: [{ move: { file: "tool.txt", line: 1, to: "line_end" } }, { type_fast: `${"x".repeat(200)}▌` }] }])
  const queued = c.step([{ do: [{ type: "abc▌" }] }])
  await sleep(1500)
  fs.writeFileSync(file("other.txt"), "after\n")
  await until(() => other.getText() === "after\n")
  const first = await queued
  assert.deepEqual(first.batches.map((b) => b.status), ["completed"])
  assert.deepEqual(first.events, [{ kind: "edit", file: "other.txt", diff: "@@ -1,1 +1,1 @@\n-before\n+after", by: "other" }])
  const toolDone = await c.step([])
  assert.deepEqual(toolDone.batches.map((b) => b.status), ["completed"])

  // ...and a save participant, trimming what the agent typed when its batch is saved: its change isn't
  // the programmer's, and the batch queued behind it, planned against the untrimmed text, is discarded.
  await vscode.workspace.getConfiguration("files").update("trimTrailingWhitespace", true, vscode.ConfigurationTarget.Global)
  await c.step([{ do: [{ type: "\nend   ▌" }] }])
  const trimmed = await c.step([{ do: [{ type: "!▌" }] }])
  const trimDone = await c.step([])
  await vscode.workspace.getConfiguration("files").update("trimTrailingWhitespace", undefined, vscode.ConfigurationTarget.Global)
  assert.deepEqual([...trimmed.batches, ...trimDone.batches].map((b) => b.status), ["completed", "discarded"])
  assert.deepEqual([...trimmed.events, ...trimDone.events].map((e) => e.kind === "edit" && `${e.file} ${e.by}`), ["tool.txt other"])
  assert.ok((await buffer("tool.txt")).endsWith("abc\nend"))
  await c.end()
  console.log("changes by others are reported as theirs")

  // A programmer edit mid-typing interrupts, and the report shows exactly what was typed.
  const alphabet = "abcdefghijklmnopqrstuvwxyz"
  await c.start("interrupt test")
  await c.step([{ do: [{ move: { file: "scratch.ts", line: 1, to: "line_end" } }, { type: `${alphabet}▌` }] }])
  const pending = c.step([{ do: [{ type: "!▌" }] }])
  // Past the pauses around moving into a new file (~1 s), and into the typing.
  await sleep(1500)
  const doc = await vscode.workspace.openTextDocument(file("scratch.ts"))
  await insertAsProgrammer(doc.uri, new vscode.Position(0, 0), "// mine\n")

  const report = await pending
  const [typing, next] = report.batches
  assert.equal(typing?.status, "interrupted")
  // What's left of the cut `type` comes back first, as a beat of its own, ready to resubmit.
  const rest = typing.unplayed?.[0]?.do?.[0]
  const left = rest && "type" in rest ? rest.type.replace("▌", "") : ""
  const typed = alphabet.slice(0, alphabet.length - left.length)
  assert.ok(typed.length > 0 && left.length > 0 && alphabet.endsWith(left), `left: ${JSON.stringify(left)}`)
  assert.equal(next?.status, "discarded")
  assert.equal(report.events[0]?.kind, "edit")
  assert.equal(doc.getText(), "// mine\n" + typed)
  assert.deepEqual(typing.code, {
    file: "scratch.ts",
    lines: [
      { number: 1, text: "// mine" },
      { number: 2, text: typed + "▌" },
    ],
    end: { final_newline: false },
  })
  await c.end()
  console.log(`interrupted after typing ${JSON.stringify(typed)}`)

  // Another extension answering the agent's typing, the way Pylance closes a `"""` the moment it's
  // opened: its addition is taken back, and the batch plays on as if it never happened.
  const closer = vscode.workspace.onDidChangeTextDocument((e) => {
    const text = e.document.getText()
    if (!e.document.fileName.endsWith("doc.py") || e.contentChanges[0]?.text !== '"' || text !== '"""') return
    const edit = new vscode.WorkspaceEdit()
    edit.insert(e.document.uri, e.document.positionAt(text.length), '"""')
    void vscode.workspace.applyEdit(edit)
  })
  await c.start("reaction test")
  await c.step([{ do: [{ move: { file: "doc.py", line: 1, to: "line_end" } }, { type: '"""A docstring."""▌' }] }])
  const reacted = await c.step([])
  closer.dispose()
  assert.deepEqual(reacted.batches.map((b) => b.status), ["completed"])
  assert.deepEqual(reacted.events, [])
  assert.equal(await buffer("doc.py"), '"""A docstring."""')
  await c.end()
  console.log("another extension's reaction to the agent's typing is undone")

  // Agents connecting the way a harness does: the launcher, over stdio, from the project folder.
  await api.ready
  const connect = async () => {
    const client = new Client({ name: "integration", version: "0" })
    await client.connect(new StdioClientTransport({ command: api.launcher, cwd: root, env: process.env as Record<string, string> }))
    const tool = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: args })
      const content = result.content as { type: string; text: string }[]
      assert.ok(!result.isError, content[0]?.text ?? "tool error")
      return content[0]!.text
    }
    return { client, tool }
  }
  const author = await connect()
  const tools = await author.client.listTools()
  assert.deepEqual(tools.tools.map((t) => t.name).sort(), ["end", "join", "listen", "read", "stage", "start", "step", "tell_author", "tell_presenter", "wait"])
  c.setSpeed(20)
  // The author works in a real private copy; the programmer's file changes only as the stage plays.
  const authored = await author.tool("start", { task: "relay test" })
  const copy = /private copy of the working directory is (.+?): do all/.exec(authored)?.[1]
  assert.ok(copy, authored)
  fs.writeFileSync(path.join(copy, "relay.txt"), "typed via the relay\n")
  await author.tool("stage", { title: "Greeting", notes: "One line.", last: true })
  assert.ok(!fs.existsSync(file("relay.txt")))

  const presenter = await connect()
  assert.match(await presenter.tool("join"), /Stage 1 began: Greeting/)
  await presenter.tool("step", { beats: [{ say: "Hello from the relay.", do: [{ write: { file: "relay.txt" } }] }] })
  assert.match(await presenter.tool("step", { beats: [] }), /Batch \d+ completed/)
  assert.equal(await buffer("relay.txt"), "typed via the relay\n")
  await presenter.tool("end", { summary: "Bye." })
  // The compare view's prepared side: what the author's stages left, kept once the copy is gone.
  await until(() => api.controller.prepared.length > 0)
  const prepared = await vscode.workspace.openTextDocument(vscode.Uri.file(file("relay.txt")).with({ scheme: "aiPairPrepared" }))
  assert.equal(prepared.getText(), "typed via the relay\n")
  assert.ok(!fs.existsSync(copy), "the copy is removed")
  await presenter.client.close()
  await author.client.close()
  console.log("relay session OK")
}
