// A scripted "agent" that plays the example session from AGENT_GUIDE.md through the real
// protocol, for tuning how playback feels. It can't adapt, so it stops when interrupted.

import * as path from "node:path"
import * as vscode from "vscode"
import type { Controller } from "@ai-pair/core"
import type { Action, Beat, Report } from "@ai-pair/protocol"

const DIR = "ai-pair-demo/src"
export const SERVER = `${DIR}/server.ts`
export const TODOS = `${DIR}/todos.ts`

export const INITIAL_SERVER = `import express from "express";

const app = express();
app.use(express.json());

app.listen(3000, () => console.log("Listening on http://localhost:3000"));
`

// Follows AGENT_GUIDE.md: left to right, with the close of whatever has one typed first, new lines
// started at the end of the line above, and each beat's words played over the code they're about.
export const SCRIPT: Beat[][] = [
  [{ say: "Okay, let me see how the app's set up first.", do: [{ move: { file: SERVER, line: 1, at: "▌import express" } }] }],
  [
    {
      say: "So it's one Express app in `server.ts`, and there's no database. I'll keep the todos in memory for now, so we can stay on the Express side. Stop me if you'd rather have a real database.",
    },
  ],
  [
    {
      say: "Here's my plan. I'll put a `Todo` interface and a little in-memory store in `todos.ts`, then add the routes in `server.ts`. Let's get creating a todo working end to end first, then fill in the rest.",
    },
  ],
  [
    {
      say: "I'll start with the shape of a todo: a `Todo` interface with an `id`, a `title`, and a `done` flag.",
      do: [
        { move: { file: TODOS, line: 1, to: "line_end" } },
        { type: "▌\n" },
        { type: "export interface Todo {\n  ▌\n}" },
        { type: "id: number;\n  title: string;\n  done: boolean;▌" },
      ],
    },
  ],
  [
    {
      say: "The store's just a `todos` array and a `nextId` counter. Then `createTodo`, which is what the routes will call.",
      do: [
        { move: { line: 5, to: "line_end" } },
        { type: "\n\nconst todos: Todo[] = [];\nlet nextId = 1;\n\nexport function createTodo(▌)" },
        { type: "title: string▌" },
        { move: { to: "line_end" } },
        { type: ": Todo {\n  ▌\n}" },
      ],
    },
    {
      say: "It builds the todo with `nextId++`, pushes it onto `todos`, and hands it back, so the route can send it straight to the client.",
      do: [
        { type: "const todo = { ▌ }" },
        { type: "id: nextId++, title, done: false▌" },
        { move: { to: "line_end" } },
        { type: ";\n  todos.push(▌)" },
        { type: "todo▌" },
        { move: { to: "line_end" } },
        { type: ";\n  return todo;▌" },
      ],
    },
  ],
  [
    {
      say: "Now the route. I'm adding an `app.post` for `/todos`, with a handler that gets `req` and `res`.",
      do: [
        { move: { file: SERVER, line: 4, at: "app.use(express.json());▌" } },
        { type: "\n\napp.post(▌)" },
        { type: '"▌"' },
        { type: "/todos▌" },
        { move: { at: '"/todos"▌)' } },
        { type: ", (▌)" },
        { type: "req, res▌" },
        { move: { at: "(req, res)▌)" } },
        { type: " => {\n  ▌\n}" },
      ],
    },
  ],
  [
    {
      say: "See `express.json()` up here? That's what parses the body, so `req.body` is already an object in our handler.",
      do: [{ point: { line: 4, text: "app.use(express.json());" } }],
    },
    {
      say: "I'll pass `req.body.title` to `createTodo`, and answer 201 with the new todo as JSON.",
      do: [
        { type: "const todo = createTodo(▌)" },
        { type: "req.body.title▌" },
        { move: { to: "line_end" } },
        { type: ";\n  res.status(▌)" },
        { type: "201▌" },
        { move: { to: "line_end" } },
        { type: ".json(▌)" },
        { type: "todo▌" },
        { move: { to: "line_end" } },
        { type: ";▌" },
      ],
    },
  ],
  [
    // As the `read` before it shows: the handler's closing line is line 9. Closing it is quiet work.
    { do: [{ move: { line: 9, to: "line_end" } }, { type: ";▌" }] },
    {
      say: "Oh, and we need to import `createTodo` up top.",
      do: [
        { move: { line: 1, at: 'import express from "express";▌' } },
        { type_fast: "\nimport { ▌ }" },
        { type_fast: "createTodo▌" },
        { move: { to: "line_end" } },
        { type_fast: ' from "▌"' },
        { type_fast: "./todos▌" },
        { move: { to: "line_end" } },
        { type_fast: ";▌" },
      ],
    },
  ],
  [
    {
      say: "Normally I'd start the server now and send it a request to check. This is a scripted demo though, so let's pretend it came back 201 with the new todo.",
    },
  ],
  [
    {
      say: "Next up, listing them. First a `listTodos` function in the store that just returns the array.",
      do: [
        { move: { file: TODOS, line: 14, to: "line_end" } },
        { type: "\n\nexport function listTodos(): Todo[] {\n  ▌\n}" },
        { type: "return todos;▌" },
      ],
    },
  ],
  [
    {
      say: "And its route, right under the POST one: a `GET /todos` that sends the list back as JSON.",
      do: [
        { move: { file: SERVER, line: 10, at: "});▌\n" } },
        { type: "\n\napp.get(▌)" },
        { type: '"▌"' },
        { type: "/todos▌" },
        { move: { at: '"/todos"▌)' } },
        { type: ", (▌)" },
        { type: "req, res▌" },
        { move: { at: "(req, res)▌)" } },
        { type: " => {\n  ▌\n}" },
        { type: "res.json(▌)" },
        { type: "listTodos()▌" },
        { move: { to: "line_end" } },
        { type: ";▌" },
      ],
    },
  ],
  [
    // As the `read` before it shows: the handler's closing line is line 14.
    { do: [{ move: { line: 14, to: "line_end" } }, { type: ";▌" }] },
    { say: "And `listTodos` needs importing too.", do: [{ move: { line: 2, at: "import { createTodo▌ }" } }, { type: ", listTodos▌" }] },
  ],
]

const SUMMARY =
  "That's the demo: the direction first, then one path end to end, then broadening one case at a time. Updating and deleting would follow the same cycle."

/** Where an action goes, if it says. */
function target(action: Action): { file?: string; line?: number } | undefined {
  return "move" in action ? action.move : "select" in action ? action.select : "point" in action ? action.point : undefined
}

/**
 * Plays a batch of the script. Like an agent, it first reads the file the batch works in, if the
 * batch gives a line number: only numbers it has been shown are allowed. `current`: the file the
 * batches before worked in.
 */
export async function stepScript(controller: Controller, batch: Beat[], current: { file?: string }): Promise<Report> {
  const actions = batch.flatMap((beat) => beat.do ?? [])
  for (const action of actions) {
    const file = target(action)?.file
    if (file) current.file = file
  }
  if (current.file && actions.some((a) => target(a)?.line !== undefined)) {
    // A file the batch creates isn't there to read yet; its one line is empty.
    await controller.read(current.file).catch(() => {})
  }
  return controller.step(batch)
}

function derailed(report: Report): boolean {
  return report.events.length > 0 || report.rejected !== undefined || report.batches.some((b) => b.status !== "completed")
}

export async function playDemo(controller: Controller, root: string): Promise<void> {
  if (controller.isActive) {
    void vscode.window.showWarningMessage("A pairing session is already active.")
    return
  }
  const server = vscode.Uri.file(path.join(root, SERVER))
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.join(root, DIR)))
  await vscode.workspace.fs.writeFile(server, new TextEncoder().encode(INITIAL_SERVER))
  try {
    await vscode.workspace.fs.delete(vscode.Uri.file(path.join(root, TODOS)))
  } catch {
    // Not there yet.
  }

  try {
    await controller.start("Demo: add a todos API to an Express app")
    const current = {}
    for (const batch of SCRIPT) {
      const report = await stepScript(controller, batch, current)
      if (report.events.some((e) => e.kind === "end")) return
      if (derailed(report)) return await stopEarly(controller)
    }
    // An empty batch collects the last batch's report without waiting for the programmer.
    const report = await controller.step([])
    if (report.events.some((e) => e.kind === "end")) return
    if (derailed(report)) return await stopEarly(controller)
    await controller.end(SUMMARY)
  } catch (e) {
    // The session was ended or replaced.
    console.error("AI Pair demo stopped:", e)
  }
}

async function stopEarly(controller: Controller): Promise<void> {
  await controller.step([{ say: "I'm a scripted demo, so I can't adapt to that. Let's stop here." }])
  await controller.end()
}
