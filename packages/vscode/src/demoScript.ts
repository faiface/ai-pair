// A scripted "agent" that plays the example session from AGENT_GUIDE.md through the real
// protocol, for tuning how playback feels. It can't adapt, so it stops when interrupted.
// Editor-agnostic: each editor sets up the files (demo.ts here, intellij-host's demo.ts), then plays it.

import type { Controller } from "@ai-pair/core"
import type { Action, Report } from "@ai-pair/protocol"

export const DIR = "ai-pair-demo/src"
export const SERVER = `${DIR}/server.ts`
export const TODOS = `${DIR}/todos.ts`

export const INITIAL_SERVER = `import express from "express";

const app = express();
app.use(express.json());

app.listen(3000, () => console.log("Listening on http://localhost:3000"));
`

// Follows AGENT_GUIDE.md: left to right, with the close of whatever has one typed first, new lines
// started at the end of the line above, and narration of what, why, and how right before its code.
export const SCRIPT: Action[][] = [
  [{ say: "Let me look at how the app is set up first." }, { move: { file: SERVER, line: 1, at: "▌import express" } }],
  [
    {
      say: "It's a single Express app in `server.ts`, with no database. I'll keep todos in memory for now, so we can focus on Express itself. Stop me if you'd prefer a real database.",
    },
  ],
  [
    {
      say: "The plan: a `Todo` interface and a small in-memory store in `todos.ts`, then REST routes in `server.ts`. We'll get creating a todo working end to end first, then add the rest.",
    },
  ],
  [
    { say: "First, the shape of a todo: an interface with an id, a title, and whether it's done." },
    { move: { file: TODOS, line: 1, to: "line_end" } },
    { type: "▌\n" },
    { type: "export interface Todo {\n  ▌\n}" },
    { type: "id: number;\n  title: string;\n  done: boolean;▌" },
  ],
  [
    { say: "The store is just an array and a counter for ids. `createTodo` is what the routes will call." },
    { move: { line: 5, to: "line_end" } },
    { type: "\n\nconst todos: Todo[] = [];\nlet nextId = 1;\n\nexport function createTodo(▌)" },
    { type: "title: string▌" },
    { move: { to: "line_end" } },
    { type: ": Todo {\n  ▌\n}" },
    { say: "It takes the next id, pushes the new todo onto the array, and returns it, so the route can send it straight back." },
    { type: "const todo = { ▌ }" },
    { type: "id: nextId++, title, done: false▌" },
    { move: { to: "line_end" } },
    { type: ";\n  todos.push(▌)" },
    { type: "todo▌" },
    { move: { to: "line_end" } },
    { type: ";\n  return todo;▌" },
  ],
  [
    {
      say: "Now the route. In Express, a route is an HTTP method, a path, and a handler that receives the request and the response.",
    },
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
  [
    { point: { line: 4, text: "app.use(express.json());" } },
    { say: "`express.json()` up here is what parses the request body, so `req.body` is an object in our handler." },
    { say: "We create the todo from the body's `title`, and answer 201 Created with the new todo as JSON." },
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
  [
    // As the `read` before it shows: the handler's closing line is line 9.
    { move: { line: 9, to: "line_end" } },
    { type: ";▌" },
    { say: "We need to import `createTodo`." },
    { move: { line: 1, at: 'import express from "express";▌' } },
    { type_fast: "\nimport { ▌ }" },
    { type_fast: "createTodo▌" },
    { move: { to: "line_end" } },
    { type_fast: ' from "▌"' },
    { type_fast: "./todos▌" },
    { move: { to: "line_end" } },
    { type_fast: ";▌" },
  ],
  [
    {
      say: "In a real session I'd now start the server and send a request to check it works. This is a scripted demo, so let's say it answered 201 with the new todo.",
    },
  ],
  [
    { say: "Next, listing todos. First a function in the store that hands out the array." },
    { move: { file: TODOS, line: 14, to: "line_end" } },
    { type: "\n\nexport function listTodos(): Todo[] {\n  ▌\n}" },
    { type: "return todos;▌" },
  ],
  [
    { say: "And the route for it, right after the POST handler: `GET /todos` sends the list back as JSON." },
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
  [
    // As the `read` before it shows: the handler's closing line is line 14.
    { move: { line: 14, to: "line_end" } },
    { type: ";▌" },
    { say: "It needs the import too." },
    { move: { line: 2, at: "import { createTodo▌ }" } },
    { type: ", listTodos▌" },
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
export async function stepScript(controller: Controller, batch: Action[], current: { file?: string }): Promise<Report> {
  for (const action of batch) {
    const file = target(action)?.file
    if (file) current.file = file
  }
  if (current.file && batch.some((a) => target(a)?.line !== undefined)) {
    // A file the batch creates isn't there to read yet; its one line is empty.
    await controller.read(current.file).catch(() => {})
  }
  return controller.step(batch)
}

function derailed(report: Report): boolean {
  return report.events.length > 0 || report.rejected !== undefined || report.batches.some((b) => b.status !== "completed")
}

/** Plays the session, once its files are set up: `SERVER` holding `INITIAL_SERVER`, and no `TODOS`. */
export async function playScript(controller: Controller): Promise<void> {
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
