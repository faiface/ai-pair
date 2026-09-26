import * as nodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Action } from "@ai-pair/protocol"
import { advance, setup, testConfig, track, until } from "./fake"

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

// With the test config, a beat is 100 ms and `type` takes 100 ms per character.

describe("timing", () => {
  it("returns the first step immediately and blocks the second until the first finishes", async () => {
    const { editor, controller } = setup({ "a.ts": "" })
    await controller.start()

    const first = await until(controller.step([{ move: { file: "a.ts" } }, { type: ["abc", ""] }]))
    expect(first.batches).toEqual([])
    expect(first.submitted).toEqual({ id: 1, status: "playing" })

    const secondCall = controller.step([{ type: ["d", ""] }])
    const second = track(secondCall)
    await advance(300)
    expect(second.done).toBe(false)
    expect(editor.text("a.ts")).toBe("ab")

    const report = await until(secondCall)
    expect(report.batches).toEqual([{ id: 1, status: "completed", played: 2 }])
    expect(report.submitted).toEqual({ id: 2, status: "playing" })

    await advance(200)
    expect(editor.text("a.ts")).toBe("abcd")
  })

  it("returns with `waiting` after MAX_BLOCK", async () => {
    const { controller } = setup({ "a.ts": "" }, { maxBlockMs: 1000 })
    await controller.start()
    await controller.step([{ move: { file: "a.ts" } }])
    const report = await until(controller.listen())
    expect(report.waiting).toBe(true)
    expect(report.batches).toEqual([{ id: 1, status: "completed", played: 1 }])
  })

  it("holds playback while paused and continues on resume", async () => {
    const { editor, controller } = setup({ "a.ts": "" })
    await controller.start()
    controller.pause()
    await controller.step([{ move: { file: "a.ts" } }, { type: ["abc", ""] }])
    await advance(2000)
    expect(editor.text("a.ts")).toBe("")
    expect(editor.state).toBe("paused")

    controller.resume()
    await advance(1000)
    expect(editor.text("a.ts")).toBe("abc")
  })

  it("pauses after a move, longer when the move is far", async () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n")
    const { controller } = setup(
      { "a.ts": lines },
      { timing: { ...testConfig.timing, beforeMoveMs: 0, afterMoveNearMs: 200, afterMoveFarMs: 1000 } },
    )
    await controller.start()
    const elapsed = async (actions: Action[]) => {
      const before = Date.now()
      await controller.step(actions)
      await until(controller.step([]))
      return Date.now() - before
    }
    expect(await elapsed([{ move: { file: "a.ts", before: "line 2\n", after: "" } }])).toBeGreaterThanOrEqual(1000) // another file
    expect(await elapsed([{ move: { before: "line 5\n", after: "" } }])).toBeLessThan(1000) // 3 lines down
    expect(await elapsed([{ move: { before: "line 35\n", after: "" } }])).toBeGreaterThanOrEqual(1000) // 30 lines down
  })
})

describe("editing", () => {
  it("types with one undo stop per action and instant indentation", async () => {
    const { editor, controller } = setup({ "a.ts": "" })
    await controller.start()
    await controller.step([{ move: { file: "a.ts" } }, { type: ["{\n  y\n}", ""] }])
    await until(controller.step([]))
    expect(editor.text("a.ts")).toBe("{\n  y\n}")
    expect(editor.edits.map((e) => e.text)).toEqual(["{", "\n  ", "y", "\n", "}"])
    expect(editor.edits.map((e) => [e.options.undoStopBefore, e.options.undoStopAfter])).toEqual([
      [true, false],
      [false, false],
      [false, false],
      [false, false],
      [false, true],
    ])
  })

  it("types the editor's line ending into an empty file, so the editor has nothing to normalize", async () => {
    const { editor, controller } = setup({ "a.ts": "" })
    editor.crlf.add(editor.resolvePath("a.ts"))
    await controller.start()
    await controller.step([{ move: { file: "a.ts" } }, { type: ["a\n  b\n", ""] }, { type: ["c", ""] }])
    await until(controller.step([]))
    expect(editor.text("a.ts")).toBe("a\r\n  b\r\nc")
    expect(editor.edits.map((e) => e.text)).toEqual(["a", "\r\n  ", "b", "\r\n", "c"])
  })

  it("moves by lines, to the end of the line, to type into a gap made first", async () => {
    const { editor, controller } = setup({ "a.ts": "a\nb\n" })
    await controller.start()
    await controller.step([
      { move: { file: "a.ts", before: "a", after: "" } },
      { type: ["\n\n\n", ""] },
      { move: { lines: -1 } },
      { type: ["new", ""] },
      { move: { lines: -10 } },
      { type: ["!", ""] },
    ])
    await until(controller.step([]))
    expect(editor.text("a.ts")).toBe("a!\n\nnew\n\nb\n")
  })

  it("types both parts of a pair, then steps back between them, in one undo stop", async () => {
    const { editor, controller } = setup({ "a.ts": "" })
    await controller.start()
    await controller.step([{ move: { file: "a.ts" } }, { type: ["update(", ")"] }, { type: ["ctx, dt", ""] }])
    const report = await until(controller.step([]))
    expect(editor.text("a.ts")).toBe("update(ctx, dt)")
    expect(report.cursor).toMatchObject({ line: 1, column: 15 })
    const pair = editor.edits.slice(0, "update()".length)
    expect(pair.map((e) => e.text).join("")).toBe("update()")
    expect(pair.map((e) => [e.options.undoStopBefore, e.options.undoStopAfter])).toEqual([
      [true, false],
      ...Array(6).fill([false, false]),
      [false, true],
    ])
  })

  it("steps back into a pair after the pause of a nearby move, and without one when nothing follows", async () => {
    const { controller } = setup({ "a.ts": "" }, { timing: { ...testConfig.timing, beforeMoveMs: 0, afterMoveNearMs: 1000 } })
    await controller.start()
    await until(controller.step([{ move: { file: "a.ts" } }]))
    const elapsed = async (actions: Action[]) => {
      const before = Date.now()
      await controller.step(actions)
      await until(controller.step([]))
      return Date.now() - before
    }
    expect(await elapsed([{ type: ["ab", ""] }])).toBeLessThan(1000)
    expect(await elapsed([{ type: ["a", "b"] }])).toBeGreaterThanOrEqual(1000)
    // type_fast scales the pause too.
    const fast = await elapsed([{ type_fast: ["a", "b"] }])
    expect(fast).toBeGreaterThanOrEqual(100)
    expect(fast).toBeLessThan(1000)
  })

  it("makes room and steps into it, then moves past a filled pair to the end of the line", async () => {
    const { editor, controller } = setup({ "a.ts": "a\nb\n" })
    await controller.start()
    await controller.step([
      { move: { file: "a.ts", before: "a", after: "\n" } },
      { type: ["\n\n", "\n"] },
      { type: ["f(", ")"] },
      { type: ["x", ""] },
      { move: { to: "end" } },
      { type: [";", ""] },
    ])
    await until(controller.step([]))
    expect(editor.text("a.ts")).toBe("a\n\nf(x);\n\nb\n")
  })

  it("steps back over the editor's line endings", async () => {
    const { editor, controller } = setup({ "a.ts": "" })
    editor.crlf.add(editor.resolvePath("a.ts"))
    await controller.start()
    await controller.step([{ move: { file: "a.ts" } }, { type: ["{\n", "\n}"] }, { type: ["  y", ""] }])
    await until(controller.step([]))
    expect(editor.text("a.ts")).toBe("{\r\n  y\r\n}")
  })

  it("moves to the spot between two texts", async () => {
    const { editor, controller } = setup({ "a.ts": 'import { type Context } from "./x"\nimport { a } from "./a"\n' })
    await controller.start()
    await controller.step([{ move: { file: "a.ts", before: "import { ", after: "type Context" } }, { type: ["type Builder, ", ""] }])
    await until(controller.step([]))
    expect(editor.text("a.ts")).toBe('import { type Builder, type Context } from "./x"\nimport { a } from "./a"\n')
  })

  it("fails a move that gives no single place to go", async () => {
    const { controller } = setup({ "a.ts": "x\n" })
    await controller.start()
    await controller.step([{ move: { file: "a.ts" } }, { move: { before: "x" } }])
    const report = await until(controller.step([]))
    expect(report.batches[0]).toMatchObject({
      status: "failed",
      error: { index: 1, kind: "invalid_action", message: expect.stringContaining("both `before` and `after`") },
    })
  })

  it("replaces a selection by typing, and deletes a selection", async () => {
    const { editor, controller } = setup({ "a.ts": "const a = 1\n" })
    await controller.start()
    await controller.step([{ move: { file: "a.ts" } }, { select: { text: "1" } }, { type: ["2", ""] }])
    await until(controller.step([{ select: { text: "const " } }, { delete: true }]))
    await until(controller.step([]))
    expect(editor.text("a.ts")).toBe("a = 2\n")
  })

  it("creates a file on move and saves edited files after each batch", async () => {
    const { editor, controller } = setup()
    await controller.start()
    await controller.step([{ move: { file: "new.ts" } }, { type_fast: ["x", ""] }])
    await until(controller.step([]))
    expect(editor.text("new.ts")).toBe("x")
    expect(editor.saved).toEqual([editor.resolvePath("new.ts")])
  })

  it("fails a batch on an ambiguous anchor, listing candidates, and discards the next batch", async () => {
    const { controller } = setup({ "a.ts": "x\nx\n" })
    await controller.start()
    await controller.step([{ move: { file: "a.ts" } }, { move: { before: "x", after: "" } }])
    const report = await until(controller.step([{ type: ["y", ""] }]))
    expect(report.batches).toEqual([
      {
        id: 1,
        status: "failed",
        played: 1,
        unplayed: [{ move: { before: "x", after: "" } }],
        error: {
          index: 1,
          kind: "anchor_ambiguous",
          message: expect.any(String),
          candidates: [
            { line: 1, context: "x" },
            { line: 2, context: "x" },
          ],
        },
      },
      { id: 2, status: "discarded", played: 0, unplayed: [{ type: ["y", ""] }] },
    ])
  })

  it("fails an action that combines two, instead of playing only one of them", async () => {
    const { editor, controller } = setup({ "a.ts": "x\n" })
    await controller.start()
    await controller.step([{ move: { file: "a.ts", to: "file_end" }, type: ["y", ""] } as Action])
    const report = await until(controller.step([]))
    expect(report.batches[0]).toMatchObject({
      status: "failed",
      played: 0,
      error: { index: 0, kind: "invalid_action", message: expect.stringContaining("`move` and `type`") },
    })
    expect(editor.text("a.ts")).toBe("x\n")
  })
})

describe("interruptions", () => {
  it("reports exactly what was typed and discards the queued batch", async () => {
    const { editor, controller } = setup({ "a.ts": "" })
    await controller.start()
    await controller.step([{ move: { file: "a.ts" } }, { type: ["hello world", ""] }])
    const second = controller.step([{ type: ["!", ""] }])

    await advance(450)
    expect(editor.text("a.ts")).toBe("hel")
    controller.userMessage("use zod")

    const report = await until(second)
    expect(report).toMatchObject({
      batches: [
        { id: 1, status: "interrupted", played: 1, partial: { index: 1, typed: "hel" }, unplayed: [] },
        { id: 2, status: "discarded", played: 0, unplayed: [{ type: ["!", ""] }] },
      ],
      submitted: { id: 2, status: "discarded" },
      events: [{ kind: "message", text: "use zod" }],
    })
    await advance(1000)
    expect(editor.text("a.ts")).toBe("hel")
  })

  it("discards a batch planned before an interruption the agent hasn't seen", async () => {
    const { editor, controller } = setup({ "a.ts": "" })
    await controller.start()
    await controller.step([{ move: { file: "a.ts" } }, { type: ["ab", ""] }])
    await advance(1000)
    controller.userInterrupt()

    const stale = await controller.step([{ type: ["c", ""] }])
    expect(stale.batches.map((b) => [b.id, b.status])).toEqual([
      [1, "completed"],
      [2, "discarded"],
    ])
    expect(stale.events).toEqual([{ kind: "interrupt" }])

    const fresh = await controller.step([{ type: ["c", ""] }])
    expect(fresh.submitted).toEqual({ id: 3, status: "playing" })
    await advance(500)
    expect(editor.text("a.ts")).toBe("abc")
  })

  it("reports programmer edits as diffs and moves the agent cursor with them", async () => {
    const { editor, controller } = setup({ "a.ts": "hello\n" })
    await controller.start()
    await controller.step([{ move: { file: "a.ts", before: "hello", after: "" } }])
    const listen = controller.listen()
    const listening = track(listen)
    await advance(500)
    expect(listening.done).toBe(false)

    editor.userEdit("a.ts", 0, 0, "XX")
    const report = await until(listen)
    expect(report.events).toEqual([{ kind: "edit", file: "a.ts", diff: expect.stringContaining("+XXhello") }])
    expect(report.cursor).toEqual({ file: "a.ts", line: 1, column: 8 })
  })
})

describe("turns", () => {
  it("lets the agent only comment during the programmer's turn", async () => {
    const { editor, controller } = setup({ "a.ts": "for (i <= n)\n" })
    await controller.start()
    await controller.step([{ move: { file: "a.ts" } }])
    await advance(500)

    controller.takeTurn()
    const taken = await until(controller.listen())
    expect(taken.turn).toBe("user")
    expect(taken.events).toEqual([{ kind: "turn", to: "user" }])

    await controller.step([{ type: ["x", ""] }])
    const refused = await until(controller.listen())
    expect(refused.batches[0]).toMatchObject({ status: "failed", error: { kind: "not_your_turn" } })

    await controller.step([{ point: { text: "<=" } }, { say: "Careful, this goes one past the end." }])
    await advance(3000)
    expect(editor.point).toEqual({ file: editor.resolvePath("a.ts"), start: 7, end: 9 })

    // Edits are reported once the programmer pauses typing.
    const following = track(controller.listen())
    editor.userEdit("a.ts", 7, 2, "<")
    await advance(500)
    expect(following.done).toBe(false)
    await advance(600)
    expect(following.done).toBe(true)
    expect(following.value!.events).toEqual([{ kind: "edit", file: "a.ts", diff: expect.stringContaining("+for (i < n)") }])

    const handedBack = track(controller.listen())
    controller.handBack("finish it")
    await advance(10)
    expect(handedBack.value!.events).toEqual([{ kind: "turn", to: "agent", message: "finish it" }])
    expect(handedBack.value!.turn).toBe("agent")
  })
})

describe("cancellation", () => {
  it("releases a blocked call without consuming the report", async () => {
    const { controller } = setup({ "a.ts": "" })
    await controller.start()
    await controller.step([{ move: { file: "a.ts" } }])
    await advance(500)
    const abort = new AbortController()
    const cancelled = track(controller.listen(abort.signal))
    await advance(10)
    abort.abort()
    await advance(10)
    expect(cancelled.error).toMatchObject({ code: "cancelled" })

    // The next call isn't stuck behind the cancelled one, and gets the report.
    controller.userMessage("hello")
    const report = await until(controller.listen())
    expect(report.batches).toEqual([{ id: 1, status: "completed", played: 1 }])
    expect(report.events).toEqual([{ kind: "message", text: "hello" }])
  })

  it("keeps a cancelled step's batch queued and reports it later", async () => {
    const { editor, controller } = setup({ "a.ts": "" })
    await controller.start()
    await controller.step([{ move: { file: "a.ts" } }, { type: ["ab", ""] }])
    const abort = new AbortController()
    const second = track(controller.step([{ type: ["c", ""] }], abort.signal))
    await advance(10)
    expect(second.done).toBe(false)
    abort.abort()
    await advance(10)
    expect(second.error).toMatchObject({ code: "cancelled" })

    await advance(1000)
    expect(editor.text("a.ts")).toBe("abc")
    const report = await until(controller.step([]))
    expect(report.batches.map((b) => [b.id, b.status])).toEqual([
      [1, "completed"],
      [2, "completed"],
    ])
  })
})

describe("sessions", () => {
  it("rejects tools outside a session and a second start", async () => {
    const { controller } = setup()
    await expect(controller.step([])).rejects.toMatchObject({ code: "no_session" })
    await controller.start()
    await expect(controller.start()).rejects.toMatchObject({ code: "session_active" })
  })

  it("ends when the programmer ends it, delivering a final report", async () => {
    const { controller } = setup({ "a.ts": "" })
    await controller.start()
    const listening = track(controller.listen())
    controller.endSession()
    await advance(10)
    expect(listening.value!.events).toEqual([{ kind: "end" }])
    await expect(controller.listen()).rejects.toMatchObject({ code: "no_session" })
  })

  it("plays out the queue when the agent ends, then allows a new session", async () => {
    const { editor, panel, controller } = setup({ "a.ts": "" })
    await controller.start("first")
    await controller.step([{ move: { file: "a.ts" } }, { type: ["abc", ""] }])
    const final = await until(controller.end("Done."))
    expect(final.batches).toEqual([{ id: 1, status: "completed", played: 2 }])
    expect(editor.text("a.ts")).toBe("abc")
    expect(panel.events).toContainEqual({ type: "session", active: false, reason: "agent", summary: "Done." })
    await expect(controller.listen()).rejects.toMatchObject({ code: "no_session" })

    await controller.start("second")
    expect(controller.isActive).toBe(true)
  })

  it("resolves paths under the agent's root into the editor's canonical form", async () => {
    const { editor, controller } = setup()
    editor.resolvePath = (file) => nodePath.resolve("/project", file).toLowerCase()
    await controller.start(undefined, "/Project")
    const file = nodePath.resolve("/Project", "A.ts").toLowerCase()
    await controller.step([{ move: { file: "A.ts" } }, { type: ["abc", ""] }])
    const listening = controller.listen()
    await advance(1000)
    editor.controller.userEdit(file, "abc", "XXabc", [{ offset: 0, deleteLength: 0, text: "XX" }])
    const report = await until(listening)
    expect(editor.shown).toEqual([file])
    expect(editor.cursor).toMatchObject({ file, offset: 5 })
    expect(report.cursor?.file).toBe("a.ts")
  })
})

describe("shared selections", () => {
  const selection = {
    file: "/project/a.ts",
    from: { line: 2, column: 1 },
    to: { line: 2, column: 6 },
    text: "hello",
  }

  it("sends the programmer's selection along with a message", async () => {
    const { panel, controller } = setup({ "a.ts": "x\nhello\n" })
    await controller.start()
    const listen = controller.listen()
    controller.userMessage("what does this do?", selection)
    const report = await until(listen)
    expect(report.events).toEqual([{ kind: "message", text: "what does this do?", selection: { ...selection, file: "a.ts" } }])
    expect(panel.events).toContainEqual({
      type: "user",
      text: "what does this do?",
      ref: { file: "a.ts", line: 2, endLine: 2 },
    })
  })

  it("sends it along when the turn is handed back", async () => {
    const { controller } = setup({ "a.ts": "x\nhello\n" })
    await controller.start()
    controller.takeTurn()
    await until(controller.listen())
    const listen = controller.listen()
    controller.handBack("finish this", selection)
    const report = await until(listen)
    expect(report.events).toEqual([
      { kind: "turn", to: "agent", message: "finish this", selection: { ...selection, file: "a.ts" } },
    ])
  })
})

describe("run", () => {
  it("runs a command, reporting its output and exit code with the batch", async () => {
    const { editor, panel, controller } = setup({}, { confirmCommands: false })
    editor.commandScript["npm test"] = { ms: 3000, exitCode: 0, output: "4 passed" }
    await controller.start(undefined, "/project/sub")
    await controller.step([{ say: "Let's run the tests." }, { run: "npm test" }])
    await advance(1000)
    expect(editor.state).toBe("running")

    const report = await until(controller.step([]))
    expect(report.batches).toEqual([
      {
        id: 1,
        status: "completed",
        played: 2,
        runs: [{ index: 1, command: "npm test", exit_code: 0, output: "4 passed", shell: "bash" }],
      },
    ])
    expect(editor.commands[0]!.options).toMatchObject({ cwd: editor.resolvePath("sub"), waitMs: 120_000 })
    expect(panel.events.filter((e) => e.type === "run").map((e) => e.type === "run" && e.phase)).toEqual(["running", "done"])
  })

  it("fails the batch on a nonzero exit, without returning the command as unplayed", async () => {
    const { editor, controller } = setup({ "a.ts": "" }, { confirmCommands: false })
    editor.commandScript["npm test"] = { ms: 100, exitCode: 1, output: "1 failed" }
    await controller.start()
    await controller.step([{ run: "npm test" }, { say: "All green." }])
    const next = controller.step([{ say: "Next." }])
    const report = await until(next)
    expect(report.batches).toMatchObject([
      {
        id: 1,
        status: "failed",
        played: 1,
        unplayed: [{ say: "All green." }],
        error: { index: 0, kind: "command_failed" },
        runs: [{ command: "npm test", exit_code: 1, output: "1 failed" }],
      },
      { id: 2, status: "discarded" },
    ])
  })

  it("leaves a long-running command running after `wait`", async () => {
    const { editor, controller } = setup({}, { confirmCommands: false })
    editor.commandScript["npm start"] = { ms: 1_000_000, output: "listening on 3000" }
    await controller.start()
    await controller.step([{ run: "npm start", wait: 2 }])
    const report = await until(controller.step([]))
    expect(report.batches).toEqual([
      {
        id: 1,
        status: "completed",
        played: 1,
        runs: [{ index: 0, command: "npm start", output: "listening on 3000", running: true }],
      },
    ])
  })

  it("stops waiting when the programmer interrupts, reporting the command as still running", async () => {
    const { editor, controller } = setup({}, { confirmCommands: false })
    editor.commandScript["npm test"] = { ms: 60_000, exitCode: 0 }
    await controller.start()
    await controller.step([{ run: "npm test" }, { say: "Done." }])
    await advance(500)
    controller.userInterrupt()
    const report = await until(controller.listen())
    expect(report.batches).toMatchObject([
      { id: 1, status: "interrupted", played: 1, unplayed: [{ say: "Done." }], runs: [{ running: true }] },
    ])
  })

  it("doesn't run a command interrupted before its terminal was ready", async () => {
    const { editor, controller } = setup({}, { confirmCommands: false })
    editor.commandScript["npm test"] = { startMs: 3000, ms: 100, exitCode: 0 }
    await controller.start()
    await controller.step([{ run: "npm test" }])
    await advance(1000)
    controller.userInterrupt()
    const report = await until(controller.listen())
    expect(report.batches).toEqual([{ id: 1, status: "discarded", played: 0, unplayed: [{ run: "npm test" }] }])
    expect(editor.commands).toEqual([])
  })

  it("asks the programmer first, and fails the batch when they decline", async () => {
    const { editor, panel, controller } = setup()
    await controller.start()
    await controller.step([{ run: "rm -rf build" }])
    await advance(5000)
    expect(editor.commands).toEqual([])
    expect(editor.state).toBe("read")
    const confirm = panel.events.find((e) => e.type === "run" && e.phase === "confirm")
    expect(confirm).toBeDefined()

    controller.decideRun(confirm!.type === "run" ? confirm!.id : -1, false)
    const report = await until(controller.listen())
    expect(report.batches).toMatchObject([
      { id: 1, status: "failed", played: 0, error: { index: 0, kind: "command_declined" }, unplayed: [{ run: "rm -rf build" }] },
    ])
    expect(editor.commands).toEqual([])
  })

  it("runs a command allowed for the session without asking again, until the session ends", async () => {
    const { editor, panel, controller } = setup()
    const confirms = () => panel.events.filter((e) => e.type === "run" && e.phase === "confirm")
    const allow = (remember: boolean) => {
      const last = confirms().at(-1)!
      controller.decideRun(last.type === "run" ? last.id : -1, true, remember)
    }
    await controller.start()
    await controller.step([{ run: "npm test" }])
    await advance(10)
    allow(true)
    await until(controller.step([{ run: "npm test" }]))
    await until(controller.step([{ run: "npm run build" }]))
    expect(confirms()).toHaveLength(2)
    allow(false)
    await until(controller.step([]))
    expect(editor.commands.map((c) => c.command)).toEqual(["npm test", "npm test", "npm run build"])

    await until(controller.end())
    await controller.start()
    await controller.step([{ run: "npm test" }])
    await advance(10)
    expect(confirms()).toHaveLength(3)
  })

  it("runs once the programmer allows it", async () => {
    const { editor, panel, controller } = setup()
    await controller.start()
    await controller.step([{ run: "npm test" }])
    await advance(10)
    const confirm = panel.events.find((e) => e.type === "run" && e.phase === "confirm")
    controller.decideRun(confirm!.type === "run" ? confirm!.id : -1, true)
    const report = await until(controller.step([]))
    expect(report.batches[0]).toMatchObject({ status: "completed", runs: [{ command: "npm test", exit_code: 0 }] })
    expect(editor.commands.map((c) => c.command)).toEqual(["npm test"])
  })

  it("is not allowed during the programmer's turn", async () => {
    const { editor, controller } = setup({}, { confirmCommands: false })
    await controller.start()
    controller.takeTurn()
    await until(controller.listen())
    await controller.step([{ run: "npm test" }])
    const report = await until(controller.listen())
    expect(report.batches[0]).toMatchObject({ status: "failed", error: { kind: "not_your_turn" } })
    expect(editor.commands).toEqual([])
  })
})
