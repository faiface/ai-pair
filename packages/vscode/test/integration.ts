// Runs inside a real VS Code (see scripts/integration.sh): plays the demo and checks the result,
// then checks that a programmer edit interrupts the agent with an exact report.

import * as assert from "node:assert/strict"
import * as path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import * as vscode from "vscode"
import type { Api } from "../src/extension"

const EXPECTED_TODOS = `export type Todo = {
  id: number;
  title: string;
  done: boolean;
};

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

export async function run(): Promise<void> {
  const ext = vscode.extensions.getExtension("ai-pair.ai-pair")
  assert.ok(ext, "extension not found")
  const api = (await ext.activate()) as Api
  const root = vscode.workspace.workspaceFolders![0]!.uri.fsPath
  const file = (name: string) => path.join(root, name)
  const buffer = async (name: string) => (await vscode.workspace.openTextDocument(file(name))).getText()
  const disk = async (name: string) =>
    new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.file(file(name))))

  // The demo, sped up. If our own edits were mistaken for the programmer's, it would stop early.
  api.controller.setSpeed(20)
  const started = Date.now()
  await api.playDemo()
  console.log(`demo played in ${Date.now() - started} ms`)
  assert.equal(await buffer("ai-pair-demo/src/todos.ts"), EXPECTED_TODOS)
  assert.equal(await buffer("ai-pair-demo/src/server.ts"), EXPECTED_SERVER)
  assert.equal(await disk("ai-pair-demo/src/server.ts"), EXPECTED_SERVER, "saved after each batch")

  // A programmer edit mid-typing interrupts, and the report shows exactly what was typed.
  const c = api.controller
  c.setSpeed(1)
  const alphabet = "abcdefghijklmnopqrstuvwxyz"
  await c.start("interrupt test")
  await c.step([{ move: { file: "scratch.ts" } }, { type: [alphabet, ""] }])
  const pending = c.step([{ type: ["!", ""] }])
  // Past the pauses around moving into a new file (~1 s), and into the typing.
  await sleep(1500)
  const doc = await vscode.workspace.openTextDocument(file("scratch.ts"))
  const edit = new vscode.WorkspaceEdit()
  edit.insert(doc.uri, new vscode.Position(0, 0), "// mine\n")
  await vscode.workspace.applyEdit(edit)

  const report = await pending
  const [typing, next] = report.batches
  assert.equal(typing?.status, "interrupted")
  // What's left of the cut `type` comes back first, ready to resubmit.
  const rest = typing.unplayed?.[0]
  const left = rest && "type" in rest ? rest.type[0] : ""
  const typed = alphabet.slice(0, alphabet.length - left.length)
  assert.ok(typed.length > 0 && left.length > 0 && alphabet.endsWith(left), `left: ${JSON.stringify(left)}`)
  assert.equal(next?.status, "discarded")
  assert.equal(report.events[0]?.kind, "edit")
  assert.equal(doc.getText(), "// mine\n" + typed)
  assert.deepEqual(typing.code, { file: "scratch.ts", lines: [{ number: 2, text: typed + "▌" }] })
  await c.end()
  console.log(`interrupted after typing ${JSON.stringify(typed)}`)

  // An agent connecting the way a harness does: the launcher, over stdio, from the project folder.
  await api.ready
  const transport = new StdioClientTransport({
    command: api.launcher,
    cwd: root,
    env: process.env as Record<string, string>,
  })
  const agent = new Client({ name: "integration", version: "0" })
  await agent.connect(transport)
  const tools = await agent.listTools()
  assert.deepEqual(tools.tools.map((t) => t.name).sort(), ["end", "listen", "read", "start", "step"])
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await agent.callTool({ name, arguments: args })
    const content = result.content as { type: string; text: string }[]
    assert.ok(!result.isError, content[0]?.text ?? "tool error")
    return content[0]!.text
  }
  c.setSpeed(20)
  await tool("start", { task: "relay test" })
  await tool("step", { actions: [{ say: "Hello from the relay." }, { move: { file: "relay.txt" } }, { type: ["typed via the relay", ""] }] })
  const last = await tool("step", { actions: [] })
  assert.match(last, /Batch \d+ completed/)
  assert.equal(await buffer("relay.txt"), "typed via the relay")
  await tool("end", { summary: "Bye." })
  await agent.close()
  console.log("relay session OK")
}
