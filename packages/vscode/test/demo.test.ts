// The scripted demo, played against the fake editor: every batch completes, and the code comes out right.

import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { setup, until } from "../../core/test/fake"
import { INITIAL_SERVER, SCRIPT, SERVER, TODOS } from "../src/demo"

vi.mock("vscode", () => ({}))

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

it("plays through, typing the todos API", async () => {
  const { editor, controller } = setup({ [SERVER]: INITIAL_SERVER })
  await controller.start()
  for (const batch of SCRIPT) {
    const report = await until(controller.step(batch))
    expect(report.batches.filter((b) => b.status !== "completed")).toEqual([])
  }
  const report = await until(controller.step([]))
  expect(report.batches.filter((b) => b.status !== "completed")).toEqual([])

  expect(editor.text(TODOS)).toBe(`export type Todo = {
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
`)
  expect(editor.text(SERVER)).toBe(`import express from "express";
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
`)
}, 60_000)
