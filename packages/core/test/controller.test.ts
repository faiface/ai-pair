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

    const first = await until(controller.step([{ move: { file: "a.ts", line: 1, to: "line_end" } }, { type: "abc▌" }]))
    expect(first.batches).toEqual([])
    expect(first.submitted).toEqual({ id: 1, status: "playing" })

    const secondCall = controller.step([{ type: "d▌" }])
    const second = track(secondCall)
    await advance(300)
    expect(second.done).toBe(false)
    expect(editor.text("a.ts")).toBe("ab")

    const report = await until(secondCall)
    expect(report.batches).toEqual([
      { id: 1, status: "completed", code: { file: "a.ts", lines: [{ number: 1, text: "abc▌" }], end: { final_newline: false } } },
    ])
    expect(report.submitted).toEqual({ id: 2, status: "playing" })

    await advance(200)
    expect(editor.text("a.ts")).toBe("abcd")
  })

  it("returns with `waiting` after MAX_BLOCK", async () => {
    const { controller } = setup({ "a.ts": "" }, { maxBlockMs: 1000 })
    await controller.start()
    await controller.step([{ move: { file: "a.ts", line: 1, to: "line_end" } }])
    const report = await until(controller.listen())
    expect(report.waiting).toBe(true)
    expect(report.batches).toMatchObject([{ id: 1, status: "completed" }])
  })

  it("holds playback while paused and continues on resume", async () => {
    const { editor, controller } = setup({ "a.ts": "" })
    await controller.start()
    controller.pause()
    await controller.step([{ move: { file: "a.ts", line: 1, to: "line_end" } }, { type: "abc▌" }])
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
    await controller.read("a.ts")
    const elapsed = async (actions: Action[]) => {
      const before = Date.now()
      await controller.step(actions)
      await until(controller.step([]))
      return Date.now() - before
    }
    expect(await elapsed([{ move: { file: "a.ts", line: 3, at: "line 2\n▌" } }])).toBeGreaterThanOrEqual(1000) // another file
    expect(await elapsed([{ move: { line: 6, at: "line 5\n▌" } }])).toBeLessThan(1000) // 3 lines down
    expect(await elapsed([{ move: { line: 36, at: "line 35\n▌" } }])).toBeGreaterThanOrEqual(1000) // 30 lines down
  })
})

describe("editing", () => {
  it("types with one undo stop per action and instant indentation", async () => {
    const { editor, controller } = setup({ "a.ts": "" })
    await controller.start()
    await controller.step([{ move: { file: "a.ts", line: 1, to: "line_end" } }, { type: "{\n  y\n}▌" }])
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
    await controller.step([{ move: { file: "a.ts", line: 1, to: "line_end" } }, { type: "a\n  b\n▌" }, { type: "c▌" }])
    await until(controller.step([]))
    expect(editor.text("a.ts")).toBe("a\r\n  b\r\nc")
    expect(editor.edits.map((e) => e.text)).toEqual(["a", "\r\n  ", "b", "\r\n", "c"])
  })

  it("moves to the end of a line, to type into a gap made first", async () => {
    const { editor, controller } = setup({ "a.ts": "a\nb\n" })
    await controller.start()
    await controller.read("a.ts")
    await controller.step([{ move: { file: "a.ts", line: 1, to: "line_end" } }, { type: "\n\n\n▌" }])
    // As the batch will leave it: the gap's lines have numbers.
    await controller.read("a.ts")
    await until(
      controller.step([
        { move: { line: 3, to: "line_end" } },
        { type: "new▌" },
        { move: { line: 1, to: "line_end" } },
        { type: "!▌" },
      ]),
    )
    await until(controller.step([]))
    expect(editor.text("a.ts")).toBe("a!\n\nnew\n\nb\n")
  })

  it("moves on the cursor's line without `line`, to step past an end just typed", async () => {
    const { editor, controller } = setup({ "a.ts": "a\n", "b.ts": "b\n" })
    await controller.start()
    await controller.read("a.ts")
    await controller.step([
      { move: { file: "a.ts", line: 1, to: "line_end" } },
      { type: "\n\nif (▌)" },
      { type: "x▌" },
      { move: { to: "line_end" } },
      { type: " {\n  ▌\n}" },
      { type: "f(▌, 2)" },
      { type: "1▌" },
      { move: { at: "1, ▌2" } },
      { type: "0 + ▌" },
    ])
    await until(controller.step([]))
    expect(editor.text("a.ts")).toBe("a\n\nif (x) {\n  f(1, 0 + 2)\n}\n")
    // Not in another file, or before the cursor is anywhere.
    const other = await until(controller.step([{ move: { file: "b.ts", to: "line_end" } }]))
    expect(other.rejected?.error).toMatchObject({ kind: "invalid_action", message: expect.stringContaining("Give `line`") })
  })

  it("moves to the end of the last line, before the final newline, and no further", async () => {
    const { editor, controller } = setup({ "a.ts": "a\n", "b.ts": "b", "c.ts": "c\r\n", "d.ts": "" })
    await controller.start()
    for (const file of ["a.ts", "b.ts", "c.ts", "d.ts"]) {
      await controller.read(file)
      await until(controller.step([{ move: { file, line: 1, to: "line_end" } }, { type: "\n\nx▌" }]))
    }
    await until(controller.step([]))
    expect(editor.text("a.ts")).toBe("a\n\nx\n")
    expect(editor.text("b.ts")).toBe("b\n\nx")
    expect(editor.text("c.ts")).toBe("c\n\nx\r\n")
    expect(editor.text("d.ts")).toBe("\n\nx")
    const report = await until(controller.step([{ move: { file: "a.ts", line: 4, to: "line_end" } }]))
    expect(report.rejected?.error).toEqual({ kind: "no_line", message: "There's no line 4: a.ts has 3 lines." })
  })

  it("types both parts of a pair, then steps back between them, in one undo stop", async () => {
    const { editor, controller } = setup({ "a.ts": "" })
    await controller.start()
    await controller.step([{ move: { file: "a.ts", line: 1, to: "line_end" } }, { type: "update(▌)" }, { type: "ctx, dt▌" }])
    const report = await until(controller.step([]))
    expect(editor.text("a.ts")).toBe("update(ctx, dt)")
    expect(report.batches[0]!.code).toEqual({ file: "a.ts", lines: [{ number: 1, text: "update(ctx, dt▌)" }], end: { final_newline: false } })
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
    await until(controller.step([{ move: { file: "a.ts", line: 1, to: "line_end" } }]))
    const elapsed = async (actions: Action[]) => {
      const before = Date.now()
      await controller.step(actions)
      await until(controller.step([]))
      return Date.now() - before
    }
    expect(await elapsed([{ type: "ab▌" }])).toBeLessThan(1000)
    expect(await elapsed([{ type: "a▌b" }])).toBeGreaterThanOrEqual(1000)
    // type_fast scales the pause too.
    const fast = await elapsed([{ type_fast: "a▌b" }])
    expect(fast).toBeGreaterThanOrEqual(100)
    expect(fast).toBeLessThan(1000)
  })

  it("steps back into a pair after a move's beat, so the close is seen typed first, and with ▌ at the end, doesn't wait", async () => {
    const { editor, controller } = setup({ "a.ts": "" }, { timing: { ...testConfig.timing, beforeMoveMs: 500, afterMoveNearMs: 0 } })
    await controller.start()
    await controller.step([{ move: { file: "a.ts", line: 1, to: "line_end" } }])
    await until(controller.step([]))
    await controller.step([{ type: "f(▌)" }])
    // 100 ms per character, so all three are typed after 300 ms; the beat follows.
    await advance(350)
    expect(editor.text("a.ts")).toBe("f()")
    expect(editor.cursor?.offset).toBe(3)
    await advance(500)
    expect(editor.cursor?.offset).toBe(2)
    await until(controller.step([]))
    // Nothing to step back over: done as soon as it's typed.
    const before = Date.now()
    await controller.step([{ type: "ab▌" }])
    await until(controller.step([]))
    expect(Date.now() - before).toBeLessThan(500)
  })

  it("makes room and steps into it, then moves past a filled pair to the end of the line", async () => {
    const { editor, controller } = setup({ "a.ts": "a\nb\n" })
    await controller.start()
    await controller.read("a.ts")
    await controller.step([
      { move: { file: "a.ts", line: 1, at: "a▌\n" } },
      { type: "\n\n▌\n" },
      { type: "f(▌)" },
      { type: "x▌" },
      { move: { to: "line_end" } },
      { type: ";▌" },
    ])
    await until(controller.step([]))
    expect(editor.text("a.ts")).toBe("a\n\nf(x);\n\nb\n")
  })

  it("steps back over the editor's line endings", async () => {
    const { editor, controller } = setup({ "a.ts": "" })
    editor.crlf.add(editor.resolvePath("a.ts"))
    await controller.start()
    await controller.step([{ move: { file: "a.ts", line: 1, to: "line_end" } }, { type: "{\n▌\n}" }, { type: "  y▌" }])
    await until(controller.step([]))
    expect(editor.text("a.ts")).toBe("{\r\n  y\r\n}")
  })

  it("moves to the spot between two texts", async () => {
    const { editor, controller } = setup({ "a.ts": 'import { type Context } from "./x"\nimport { a } from "./a"\n' })
    await controller.start()
    await controller.read("a.ts")
    await controller.step([{ move: { file: "a.ts", line: 1, at: "import { ▌type Context" } }, { type: "type Builder, ▌" }])
    await until(controller.step([]))
    expect(editor.text("a.ts")).toBe('import { type Builder, type Context } from "./x"\nimport { a } from "./a"\n')
  })

  it("takes the spot only on the given line, saying what the line reads and where the text is", async () => {
    const { controller } = setup({ "a.ts": "if (a) {\n  b();\n}\nif (c) {\n  d();\n}\n" })
    await controller.start()
    await controller.read("a.ts")
    const off = await controller.step([{ move: { file: "a.ts", line: 2, at: "}▌\n" } }])
    expect(off.rejected?.error).toEqual({
      kind: "not_found",
      message: 'The spot isn\'t on line 2: line 2 reads "  b();". It\'s on these lines:',
      candidates: [
        { line: 3, context: "}" },
        { line: 6, context: "}" },
      ],
    })
    const missing = await controller.step([{ move: { file: "a.ts", line: 2, at: "e(▌" } }])
    expect(missing.rejected?.error).toEqual({
      kind: "not_found",
      message: 'Text not found: "e("; line 2 reads "  b();"',
    })
    const twice = await controller.step([{ move: { file: "a.ts", line: 1, at: "▌ " } }])
    expect(twice.rejected?.error).toMatchObject({ kind: "ambiguous", message: expect.stringContaining("2 times on line 1") })
    const report = await until(controller.step([{ move: { file: "a.ts", line: 6, at: "}▌\n" } }]))
    expect(report.rejected).toBeUndefined()
    expect((await until(controller.step([]))).batches[0]!.code?.lines.at(-1)).toEqual({ number: 6, text: "}▌" })
  })

  it("rejects a move that gives no single place to go", async () => {
    const { controller } = setup({ "a.ts": "x\n" })
    await controller.start()
    await controller.read("a.ts")
    const problem = async (move: object) => {
      const report = await controller.step([{ move: { file: "a.ts", line: 1, to: "line_end" } }, { move } as Action])
      expect(report.rejected).toMatchObject({ index: 2, action: { move }, error: { kind: "invalid_action" } })
      return report.rejected!.error.message
    }
    expect(await problem({ line: 1, at: "x" })).toContain("marks where your cursor goes with ▌")
    expect(await problem({ line: 1, at: "▌x▌" })).toContain("has 2 ▌")
    expect(await problem({ line: 1, at: "▌" })).toContain("needs text around ▌")
    expect(await problem({ line: 1, at: "x▌", to: "line_end" })).toContain("not both")
    expect(await problem({ line: 1 })).toContain("Give the place on the line")
    expect(await problem({ line: 1, before: "x", after: "" })).toContain("A spot is one text, `at`")
    expect(await problem({ line: 1, to: "end" })).toContain('`to` is `"line_end"`')
  })

  it("replaces a selection by typing, and deletes a selection", async () => {
    const { editor, controller } = setup({ "a.ts": "const a = 1\n" })
    await controller.start()
    await controller.read("a.ts")
    await controller.step([{ move: { file: "a.ts", line: 1, to: "line_end" } }, { select: { text: "1" } }, { type: "2▌" }])
    await until(controller.step([{ select: { text: "const " } }, { delete: true }]))
    await until(controller.step([]))
    expect(editor.text("a.ts")).toBe("a = 2\n")
  })

  it("creates a file on move and saves edited files after each batch", async () => {
    const { editor, controller } = setup()
    await controller.start()
    await controller.step([{ move: { file: "new.ts", line: 1, to: "line_end" } }, { type_fast: "x▌" }])
    await until(controller.step([]))
    expect(editor.text("new.ts")).toBe("x")
    expect(editor.saved).toEqual([editor.resolvePath("new.ts")])
  })

  it("rejects an action that combines two, instead of playing only one of them", async () => {
    const { editor, controller } = setup({ "a.ts": "x\n" })
    await controller.start()
    const report = await controller.step([{ move: { file: "a.ts", line: 1, to: "line_end" }, type: "y▌" } as Action])
    expect(report.rejected).toMatchObject({
      index: 1,
      error: { kind: "invalid_action", message: expect.stringContaining("`move` and `type`") },
    })
    expect(editor.text("a.ts")).toBe("x\n")
  })
})

describe("rehearsal", () => {
  it("rejects a batch that would fail at once, with the code as it would read, playing nothing of it", async () => {
    const { editor, panel, controller } = setup({ "a.ts": "x\nx\n" })
    await controller.start()
    await controller.read("a.ts")
    const report = await controller.step([
      { say: "Here." },
      { move: { file: "a.ts", line: 2, to: "line_end" } },
      { type: "y▌" },
      { move: { line: 1, at: "xy▌" } },
    ])
    expect(report).toEqual({
      batches: [],
      events: [],
      turn: "agent",
      rejected: {
        index: 4,
        action: { move: { line: 1, at: "xy▌" } },
        error: {
          kind: "not_found",
          message: expect.any(String),
          candidates: [{ line: 2, context: "xy" }],
        },
        code: {
          file: "a.ts",
          lines: [
            { number: 1, text: "x" },
            { number: 2, text: "xy▌" },
          ],
          end: { final_newline: true },
        },
      },
    })
    await advance(5000)
    expect(editor.text("a.ts")).toBe("x\nx\n")
    expect(editor.edits).toEqual([])
    expect(panel.says()).toEqual([])
  })

  it("rehearses from where the queued batches leave off, and leaves them playing when it rejects", async () => {
    const { editor, controller } = setup({ "a.ts": "" })
    await controller.start()
    await controller.step([{ move: { file: "a.ts", line: 1, to: "line_end" } }, { type: "let a = 1▌" }])

    // Anchored on text the playing batch hasn't typed yet.
    const secondCall = controller.step([{ select: { text: "1" } }, { type: "2▌" }])
    const second = track(secondCall)
    await advance(10)
    expect(second.done).toBe(false)
    expect(editor.text("a.ts")).toBe("")
    const report = await until(secondCall)
    expect(report.batches).toMatchObject([{ id: 1, status: "completed" }])

    // Still queued behind the second: this one's anchor would fail after the second batch.
    const rejected = await controller.step([{ select: { text: "= 1" } }])
    expect(rejected.rejected).toMatchObject({ index: 1, error: { kind: "not_found" } })

    const last = await until(controller.step([]))
    expect(last.batches).toMatchObject([{ id: 2, status: "completed" }])
    expect(editor.text("a.ts")).toBe("let a = 2")
  })
})

describe("line numbers", () => {
  it("rejects a move to a line it hasn't been shown, saying what the line reads and where the spot is, which it's then shown", async () => {
    const { editor, controller } = setup({ "a.ts": "a\nb\nc\n" })
    await controller.start()
    const unseen = await controller.step([{ move: { file: "a.ts", line: 2, at: "c▌" } }])
    expect(unseen.rejected?.error).toEqual({
      kind: "line_not_seen",
      message:
        'You haven\'t seen line 2 of a.ts in an up-to-date `read` or report, so its number may be off: take line numbers from them, never work them out. Now, line 2 reads "b", and the spot is on these lines:',
      candidates: [{ line: 3, context: "c" }],
    })
    const end = await controller.step([{ move: { file: "a.ts", line: 1, to: "line_end" } }])
    expect(end.rejected?.error.message).toMatch(/Now, line 1 reads "a"\.$/)
    expect((await until(controller.step([{ move: { file: "a.ts", line: 3, at: "c▌" } }]))).rejected).toBeUndefined()
    expect((await until(controller.step([{ move: { line: 1, to: "line_end" } }, { type: "!▌" }]))).rejected).toBeUndefined()
    await until(controller.step([]))
    expect(editor.text("a.ts")).toBe("a!\nb\nc\n")
  })

  it("rejects a number from before the lines a queued batch adds above it, and takes one from a `read` after them", async () => {
    const { editor, controller } = setup({ "a.ts": "a\nb\n" })
    await controller.start()
    await controller.read("a.ts")
    await controller.step([{ move: { file: "a.ts", line: 1, to: "line_end" } }, { type: "\nx▌" }])
    // The playing batch moves `b` from line 2 to line 3.
    const stale = await controller.step([{ move: { line: 2, to: "line_end" } }, { type: "!▌" }])
    expect(stale.rejected?.error).toMatchObject({ kind: "line_not_seen", message: expect.stringMatching(/line 2 reads "x"\.$/) })
    expect((await controller.read("a.ts")).lines.map((l) => l.text)).toEqual(["a", "x", "b"])
    const next = await until(controller.step([{ move: { line: 3, to: "line_end" } }, { type: "!▌" }]))
    expect(next.rejected).toBeUndefined()
    await until(controller.step([]))
    expect(editor.text("a.ts")).toBe("a\nx\nb!\n")
  })

  it("rejects a move below lines its own batch adds", async () => {
    const { controller } = setup({ "a.ts": "a\nb\n" })
    await controller.start()
    await controller.read("a.ts")
    const report = await controller.step([
      { move: { file: "a.ts", line: 1, to: "line_end" } },
      { type: "\n\nx▌" },
      { move: { line: 2, at: "b▌" } },
    ])
    expect(report.rejected).toMatchObject({ index: 3, error: { kind: "line_not_seen", candidates: [{ line: 4, context: "b" }] } })
    // Shown where `b` is then, the whole batch again goes there.
    const again = await controller.step([
      { move: { file: "a.ts", line: 1, to: "line_end" } },
      { type: "\n\nx▌" },
      { move: { line: 4, at: "b▌" } },
    ])
    expect(again.rejected).toBeUndefined()
  })

  it("takes a report's numbers through a queued batch that doesn't add lines above them", async () => {
    const { editor, controller } = setup({ "a.ts": "a\nb\nc\n" })
    await controller.start()
    await controller.read("a.ts")
    await controller.step([{ move: { file: "a.ts", line: 3, to: "line_end" } }, { type: "\nd▌" }])
    const first = await until(controller.step([{ say: "Next, the last line." }]))
    // The line typed was never read, only shown in the report.
    expect(first.batches[0]!.code!.lines.at(-1)).toEqual({ number: 4, text: "d▌" })
    const next = await until(controller.step([{ move: { line: 4, to: "line_end" } }, { type: "!▌" }]))
    expect(next.rejected).toBeUndefined()
    await until(controller.step([]))
    expect(editor.text("a.ts")).toBe("a\nb\nc\nd!\n")
  })

  it("rejects a report's number that a queued batch has since moved", async () => {
    const { controller } = setup({ "a.ts": "a\nb\n" })
    await controller.start()
    await controller.read("a.ts")
    await controller.step([{ move: { file: "a.ts", line: 2, to: "line_end" } }, { type: "\nc▌" }])
    const first = await until(controller.step([{ move: { line: 1, to: "line_end" } }, { type: "\nx▌" }]))
    expect(first.batches[0]!.code!.lines.at(-1)).toEqual({ number: 3, text: "c▌" })
    // The queued batch moves `c` to line 4.
    const stale = await controller.step([{ move: { line: 3, to: "line_end" } }])
    expect(stale.rejected?.error).toMatchObject({ kind: "line_not_seen", message: expect.stringMatching(/line 3 reads "b"\.$/) })
  })

  it("keeps the numbers above the programmer's edit, and not below it", async () => {
    const { editor, controller } = setup({ "a.ts": "a\nb\nc\n" })
    await controller.start()
    await controller.read("a.ts")
    editor.userEdit("a.ts", 3, 0, "\n  y")
    await until(controller.listen())
    expect((await controller.step([{ move: { file: "a.ts", line: 4, to: "line_end" } }])).rejected?.error.kind).toBe("line_not_seen")
    expect((await until(controller.step([{ move: { file: "a.ts", line: 2, to: "line_end" } }]))).rejected).toBeUndefined()
  })

  it("forgets the lines of a file that changed without it hearing, like a closed file edited on disk", async () => {
    const { editor, controller } = setup({ "a.ts": "a\nb\n" })
    await controller.start()
    await controller.read("a.ts")
    editor.files.set(editor.resolvePath("a.ts"), "x\na\nb\n")
    const report = await controller.step([{ move: { file: "a.ts", line: 2, to: "line_end" } }])
    expect(report.rejected?.error).toMatchObject({ kind: "line_not_seen", message: expect.stringMatching(/line 2 reads "a"\.$/) })
  })
})

describe("spans", () => {
  it("selects text on the cursor's line without `line`, and on a line it was shown with one", async () => {
    const { editor, controller } = setup({ "a.ts": "const a = 1\nconst b = 1\n" })
    await controller.start()
    await controller.read("a.ts")
    await controller.step([
      { move: { file: "a.ts", line: 1, to: "line_end" } },
      { select: { text: "1" } },
      { type: "2▌" },
      { select: { line: 2, text: "1" } },
      { type: "3▌" },
    ])
    await until(controller.step([]))
    expect(editor.text("a.ts")).toBe("const a = 2\nconst b = 3\n")
  })

  it("selects a range from one text through the first match of another after it", async () => {
    const { editor, controller } = setup({ "a.ts": "f(1, 2);\ng(3);\nh();\n" })
    await controller.start()
    await controller.read("a.ts")
    await controller.step([{ select: { file: "a.ts", line: 1, from: "f(", through: ");" } }, { delete: true }])
    await until(controller.step([{ select: { line: 2, from: "g", through: "\n" } }, { delete: true }]))
    await until(controller.step([]))
    expect(editor.text("a.ts")).toBe("\nh();\n")
  })

  it("selects in the file it names, moving the cursor there", async () => {
    const { editor, controller } = setup({ "a.ts": "a\n", "b.ts": "let b = 1\n" })
    await controller.start()
    await controller.read("b.ts")
    await until(controller.step([{ move: { file: "a.ts", line: 1, to: "line_end" } }]))
    await until(controller.step([{ select: { file: "b.ts", line: 1, text: "1" } }, { type: "2▌" }]))
    await until(controller.step([]))
    expect(editor.text("b.ts")).toBe("let b = 2\n")
    expect(editor.cursor).toMatchObject({ file: editor.resolvePath("b.ts") })
  })

  it("takes a span only on its line, saying where its text is, and one without `line` only in the cursor's file", async () => {
    const { controller } = setup({ "a.ts": "a = 1\nb = 1\n", "b.ts": "b\n" })
    await controller.start()
    await controller.read("a.ts")
    await controller.read("b.ts")
    await until(controller.step([{ move: { file: "a.ts", line: 1, to: "line_end" } }]))
    const off = await controller.step([{ point: { line: 1, text: "b = 1" } }])
    expect(off.rejected?.error).toEqual({
      kind: "not_found",
      message: 'The text isn\'t on line 1: line 1 reads "a = 1". It\'s on these lines:',
      candidates: [{ line: 2, context: "b = 1" }],
    })
    const elsewhere = await controller.step([{ point: { file: "b.ts", text: "b" } }])
    expect(elsewhere.rejected?.error).toMatchObject({ kind: "invalid_action", message: expect.stringContaining("Give `line`") })
  })

  it("rejects a span on a line it hasn't been shown", async () => {
    const { controller } = setup({ "a.ts": "a\nb\n" })
    await controller.start()
    const report = await controller.step([{ point: { file: "a.ts", line: 1, text: "b" } }])
    expect(report.rejected?.error).toMatchObject({
      kind: "line_not_seen",
      message: expect.stringMatching(/Now, line 1 reads "a", and the text is on these lines:$/),
      candidates: [{ line: 2, context: "b" }],
    })
    expect((await controller.step([{ point: { file: "a.ts", line: 2, text: "b" } }])).rejected).toBeUndefined()
  })
})

describe("typing with ▌", () => {
  it("rejects a text without exactly one ▌", async () => {
    const { controller } = setup({ "a.ts": "" })
    await controller.start()
    const move = { move: { file: "a.ts", line: 1, to: "line_end" } } as const
    const none = await controller.step([move, { type: "x" }])
    expect(none.rejected).toMatchObject({ index: 2, error: { kind: "invalid_action", message: expect.stringContaining("Mark where your cursor ends") } })
    const two = await controller.step([move, { type_fast: "f(▌)▌" }])
    expect(two.rejected).toMatchObject({ index: 2, error: { kind: "invalid_action", message: expect.stringContaining("has 2 ▌") } })
  })
})

describe("pointing", () => {
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n")

  it("follows the pointed code while the agent talks about it, then goes back to the cursor", async () => {
    const { editor, controller } = setup({ "a.ts": lines })
    await controller.start()
    await controller.read("a.ts")
    await until(controller.step([{ move: { file: "a.ts", line: 2, at: "line 2▌\n" } }]))
    await until(controller.step([{ point: { line: 35, text: "line 35" } }, { say: "This one." }]))
    expect(editor.focus).toBe("point")
    expect(editor.point).toBeDefined()
    await until(controller.step([{ type: "!▌" }]))
    await until(controller.step([]))
    expect(editor.focus).toBe("cursor")
    expect(editor.text("a.ts")).toContain("line 2!")
  })

  it("pauses like a far move when going back from far away, and not from nearby", async () => {
    const { controller } = setup(
      { "a.ts": lines },
      { timing: { ...testConfig.timing, beforeMoveMs: 0, afterMoveFarMs: 1000, afterMoveNearMs: 0 } },
    )
    await controller.start()
    await controller.read("a.ts")
    await until(controller.step([{ move: { file: "a.ts", line: 2, at: "line 2▌\n" } }]))
    await until(controller.step([]))
    const elapsed = async (actions: Action[]) => {
      const before = Date.now()
      await controller.step(actions)
      await until(controller.step([]))
      return Date.now() - before
    }
    expect(await elapsed([{ point: { line: 35, text: "line 35" } }, { type: "x▌" }])).toBeGreaterThanOrEqual(1000)
    expect(await elapsed([{ point: { line: 4, text: "line 4\n" } }, { type: "y▌" }])).toBeLessThan(1000)
  })

  it("shows another file for a point, and the cursor's file again with the next edit", async () => {
    const { editor, controller } = setup({ "a.ts": "a\n", "b.ts": "b\n" })
    await controller.start()
    await controller.read("a.ts")
    await controller.read("b.ts")
    await until(controller.step([{ move: { file: "a.ts", line: 1, to: "line_end" } }]))
    await until(controller.step([{ point: { file: "b.ts", line: 1, text: "b" } }, { say: "Over there." }]))
    await until(controller.step([{ type: "x▌" }]))
    await until(controller.step([]))
    expect(editor.shown).toEqual([editor.resolvePath("a.ts"), editor.resolvePath("b.ts"), editor.resolvePath("a.ts")])
    expect(editor.text("a.ts")).toBe("ax\n")
  })

  it("leaves the view alone during the programmer's turn", async () => {
    const { editor, controller } = setup({ "a.ts": "a\n", "b.ts": "b\n" })
    await controller.start()
    await controller.read("a.ts")
    await controller.read("b.ts")
    await until(controller.step([{ move: { file: "a.ts", line: 1, to: "line_end" } }]))
    await until(controller.step([]))
    controller.takeTurn()
    await until(controller.listen())
    const pointed = await until(controller.step([{ point: { file: "b.ts", line: 1, text: "b" } }]))
    expect(pointed.rejected).toBeUndefined()
    await until(controller.step([]))
    expect(editor.point).toMatchObject({ file: editor.resolvePath("b.ts") })
    expect(editor.focus).toBe("cursor")
    expect(editor.shown).toEqual([editor.resolvePath("a.ts")])
    expect(editor.follows).toBe(1)
  })

  it("follows the agent's keystrokes, moves, selections and points, not what it says", async () => {
    const { editor, controller } = setup({ "a.ts": "a\nb\n" })
    await controller.start()
    await controller.read("a.ts")
    await until(controller.step([{ move: { file: "a.ts", line: 1, to: "line_end" } }]))
    await until(controller.step([]))
    expect(editor.follows).toBe(1)
    await until(controller.step([{ say: "Now the rest." }]))
    await until(controller.step([]))
    expect(editor.follows).toBe(1)
    await until(controller.step([{ type: "xy▌" }, { select: { line: 2, text: "b" } }, { point: { line: 1, text: "axy" } }]))
    await until(controller.step([]))
    expect(editor.follows).toBe(5)
  })

  it("brings back what the view follows on resume", async () => {
    const { editor, controller } = setup({ "a.ts": lines })
    await controller.start()
    await controller.read("a.ts")
    await until(controller.step([{ move: { file: "a.ts", line: 1, to: "line_end" } }, { point: { line: 35, text: "line 35" } }]))
    await until(controller.step([]))
    controller.pause()
    controller.resume()
    expect(editor.reveals).toBe(1)
    expect(editor.focus).toBe("point")
  })
})

describe("reports", () => {
  it("shows the lines a batch changed, extended to the cursor, as they read when it ended, with context", async () => {
    const { controller } = setup({ "a.ts": "1\n2\n3\n4\na\nb\nc\n5\n6\n7\n8\n" })
    await controller.start()
    await controller.read("a.ts")
    await controller.step([
      { move: { file: "a.ts", line: 7, at: "c▌\n" } },
      { type: "\n  x▌" },
      { move: { line: 5, at: "a▌\n" } },
    ])
    const report = await until(controller.step([]))
    expect(report.batches[0]!.code).toEqual({
      file: "a.ts",
      lines: [
        { number: 2, text: "2" },
        { number: 3, text: "3" },
        { number: 4, text: "4" },
        { number: 5, text: "a▌" },
        { number: 6, text: "b" },
        { number: 7, text: "c" },
        { number: 8, text: "  x" },
        { number: 9, text: "5" },
        { number: 10, text: "6" },
        { number: 11, text: "7" },
      ],
    })
    // The code shows the cursor, so the report doesn't repeat it.
    expect(report.cursor).toBeUndefined()
  })

  it("says where the code reaches the end of the file, and whether a newline ends it", async () => {
    const { controller } = setup({ "a.ts": "a\n\n", "b.ts": "a\nb" })
    await controller.start()
    await controller.read("a.ts")
    await controller.read("b.ts")
    await until(controller.step([{ move: { file: "a.ts", line: 1, at: "a▌" } }]))
    const blank = await until(controller.step([{ move: { file: "b.ts", line: 1, at: "a▌" } }]))
    // The blank line at the end is a line; the final newline isn't another one.
    expect(blank.batches[0]!.code).toEqual({
      file: "a.ts",
      lines: [
        { number: 1, text: "a▌" },
        { number: 2, text: "" },
      ],
      end: { final_newline: true },
    })
    // Typing a newline at the end of a file without one leaves the cursor after it.
    const missing = await until(controller.step([{ move: { file: "b.ts", line: 2, to: "line_end" } }, { type: "\n▌" }]))
    expect(missing.batches[0]!.code).toEqual({
      file: "b.ts",
      lines: [
        { number: 1, text: "a▌" },
        { number: 2, text: "b" },
      ],
      end: { final_newline: false },
    })
    // With the cursor after the final newline, its empty line is shown.
    const after = await until(controller.step([]))
    expect(after.batches[0]!.code).toEqual({
      file: "b.ts",
      lines: [
        { number: 1, text: "a" },
        { number: 2, text: "b" },
        { number: 3, text: "▌" },
      ],
      end: { final_newline: true },
    })
  })

  it("skips the middle of long code, keeping the cursor's line", async () => {
    const { controller } = setup({ "a.ts": "" })
    await controller.start()
    const body = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n")
    await controller.step([{ move: { file: "a.ts", line: 1, to: "line_end" } }, { type_fast: `${body}▌` }])
    const report = await until(controller.step([]))
    const numbers = report.batches[0]!.code!.lines.map((l) => l.number)
    expect(numbers.length).toBeLessThanOrEqual(41)
    expect(numbers[0]).toBe(1)
    expect(report.batches[0]!.code!.lines.at(-1)).toEqual({ number: 60, text: "line 60▌" })
  })

  it("shows the cursor only when it isn't where the agent last saw it", async () => {
    const { editor, controller } = setup({ "a.ts": "abc\n" })
    await controller.start()
    await controller.read("a.ts")
    await until(controller.step([{ move: { file: "a.ts", line: 1, at: "ab▌c" } }]))
    const report = await until(controller.step([{ say: "Hm." }]))
    expect(report.batches[0]!.code).toEqual({ file: "a.ts", lines: [{ number: 1, text: "ab▌c" }], end: { final_newline: true } })
    expect(report.cursor).toBeUndefined()
    const next = await until(controller.step([]))
    expect(next.cursor).toBeUndefined()

    editor.userEdit("a.ts", 0, 0, "\n")
    const moved = await until(controller.listen())
    expect(moved.cursor).toEqual({
      file: "a.ts",
      lines: [
        { number: 1, text: "" },
        { number: 2, text: "ab▌c" },
      ],
      end: { final_newline: true },
    })
  })

  it("returns what's left of a type cut inside its second part", async () => {
    const { editor, controller } = setup({ "a.ts": "" })
    await controller.start()
    await controller.step([{ move: { file: "a.ts", line: 1, to: "line_end" } }, { type: "f(▌) {}" }])
    // 100 ms before the move, then 100 ms per character: into the second part, after ") ".
    await advance(100 + 4 * 100 + 50)
    expect(editor.text("a.ts")).toBe("f() ")
    controller.userInterrupt()
    const report = await until(controller.listen())
    expect(report.batches[0]).toMatchObject({ status: "interrupted", unplayed: [{ type: "▌{}" }] })
  })

  it("rejects a batch that works in more than one file at the action that switches, queueing nothing of it", async () => {
    const { controller } = setup({ "a.ts": "", "b.ts": "x" })
    await controller.start()
    await controller.read("b.ts")
    const two = await controller.step([{ move: { file: "a.ts", line: 1, to: "line_end" } }, { point: { file: "b.ts", line: 1, text: "x" } }])
    expect(two.rejected).toMatchObject({ index: 2, error: { kind: "invalid_action", message: expect.stringContaining("a.ts and b.ts") } })
    // Naming its file again is fine.
    const same = await controller.step([{ move: { file: "a.ts", line: 1, to: "line_end" } }, { type: "x▌" }, { move: { file: "a.ts", to: "line_end" } }])
    expect(same.rejected).toBeUndefined()
    const late = await controller.step([{ type: "y▌" }, { select: { file: "b.ts", line: 1, text: "x" } }])
    expect(late.rejected).toMatchObject({
      index: 2,
      error: { kind: "invalid_action", message: expect.stringContaining("before the batch's first edit") },
      code: { file: "a.ts", lines: [{ number: 1, text: "xy▌" }] },
    })
  })
})

describe("interruptions", () => {
  it("shows the code as far as it got, returns the rest of the cut action, and discards the queued batch", async () => {
    const { editor, controller } = setup({ "a.ts": "" })
    await controller.start()
    await controller.step([{ move: { file: "a.ts", line: 1, to: "line_end" } }, { type: "hello world▌" }])
    const second = controller.step([{ type: "!▌" }])

    await advance(450)
    expect(editor.text("a.ts")).toBe("hel")
    controller.userMessage("use zod")

    const report = await until(second)
    expect(report).toEqual({
      batches: [
        {
          id: 1,
          status: "interrupted",
          code: { file: "a.ts", lines: [{ number: 1, text: "hel▌" }], end: { final_newline: false } },
          unplayed: [{ type: "lo world▌" }],
        },
        { id: 2, status: "discarded", unplayed: [{ type: "!▌" }] },
      ],
      events: [{ kind: "message", text: "use zod" }],
      turn: "agent",
    })
    await advance(1000)
    expect(editor.text("a.ts")).toBe("hel")
  })

  it("discards a batch planned before an interruption the agent hasn't seen", async () => {
    const { editor, controller } = setup({ "a.ts": "" })
    await controller.start()
    await controller.step([{ move: { file: "a.ts", line: 1, to: "line_end" } }, { type: "ab▌" }])
    await advance(1000)
    controller.userInterrupt()

    const stale = await controller.step([{ type: "c▌" }])
    expect(stale.batches.map((b) => [b.id, b.status])).toEqual([
      [1, "completed"],
      [2, "discarded"],
    ])
    expect(stale.events).toEqual([{ kind: "interrupt" }])

    const fresh = await controller.step([{ type: "c▌" }])
    expect(fresh.submitted).toEqual({ id: 3, status: "playing" })
    await advance(500)
    expect(editor.text("a.ts")).toBe("abc")
  })

  it("reports programmer edits as diffs and moves the agent cursor with them", async () => {
    const { editor, controller } = setup({ "a.ts": "hello\n" })
    await controller.start()
    await controller.read("a.ts")
    await controller.step([{ move: { file: "a.ts", line: 1, at: "hello▌" } }])
    const listen = controller.listen()
    const listening = track(listen)
    await advance(500)
    expect(listening.done).toBe(false)

    editor.userEdit("a.ts", 0, 0, "XX")
    const report = await until(listen)
    expect(report.events).toEqual([{ kind: "edit", file: "a.ts", diff: expect.stringContaining("+XXhello"), by: "programmer" }])
    // The batch's code showed the cursor before the edit, so the report shows where it is now.
    expect(report.cursor).toEqual({ file: "a.ts", lines: [{ number: 1, text: "XXhello▌" }], end: { final_newline: true } })
  })

  it("reports changes the programmer didn't make to other files without interrupting, or waking `listen`", async () => {
    const { editor, controller } = setup({ "a.ts": "hello\n", "package.json": "{}\n" })
    await controller.start()
    await controller.read("a.ts")
    await controller.step([{ move: { file: "a.ts", line: 1, to: "line_end" } }, { type: "abc▌" }])
    await advance(200)
    editor.otherEdit("package.json", 1, 0, '"x": 1')

    const report = await until(controller.step([{ type: "d▌" }]))
    expect(report.batches).toMatchObject([{ id: 1, status: "completed" }])
    expect(report.events).toEqual([{ kind: "edit", file: "package.json", diff: expect.stringContaining('+{"x": 1}'), by: "other" }])
    await until(controller.step([]))
    expect(editor.text("a.ts")).toBe("helloabcd\n")

    const listening = track(controller.listen())
    editor.otherEdit("a.ts", 0, 0, "// formatted\n")
    await advance(5000)
    expect(listening.done).toBe(false)
    editor.userEdit("a.ts", 0, 0, "!")
    await advance(10)
    expect(listening.value!.events).toMatchObject([{ kind: "edit", file: "a.ts", by: "programmer" }])
  })

  it("interrupts on a change the programmer didn't make to a file the batches edit, planned against the text before it", async () => {
    const { editor, controller } = setup({ "a.ts": "hello\n" })
    await controller.start()
    await controller.read("a.ts")
    await controller.step([{ move: { file: "a.ts", line: 1, to: "line_end" } }, { type: "abc▌" }])
    const queued = track(controller.step([{ type: "d▌" }]))
    await advance(200)
    // A formatter, say.
    editor.otherEdit("a.ts", 0, 0, "// formatted\n")
    await advance(10)
    expect(queued.done).toBe(true)
    expect(queued.value!.events).toEqual([{ kind: "edit", file: "a.ts", diff: expect.stringContaining("+// formatted"), by: "other" }])
    expect(queued.value!.batches).toMatchObject([
      { id: 1, status: "interrupted" },
      { id: 2, status: "discarded", unplayed: [{ type: "d▌" }] },
    ])
    // As far as the interrupted batch got, and nothing of the discarded one.
    expect(editor.text("a.ts")).toMatch(/^\/\/ formatted\nhello(a|ab|abc)?\n$/)
  })

  it("discards the batch queued behind one whose save a formatter changed, which completes", async () => {
    const { editor, controller } = setup({ "a.ts": "hello\n" })
    const save = editor.save.bind(editor)
    let formatted = false
    editor.save = async (file) => {
      await save(file)
      if (formatted) return
      formatted = true
      editor.otherEdit("a.ts", 0, 0, "// formatted\n")
    }
    await controller.start()
    await controller.read("a.ts")
    await controller.step([{ move: { file: "a.ts", line: 1, to: "line_end" } }, { type: "abc▌" }])
    const report = await until(controller.step([{ type: "d▌" }]))
    expect(report.batches).toMatchObject([
      { id: 1, status: "completed" },
      { id: 2, status: "discarded" },
    ])
    expect(report.events).toMatchObject([{ kind: "edit", file: "a.ts", by: "other" }])
    expect(editor.text("a.ts")).toBe("// formatted\nhelloabc\n")
  })

  it("reports a file's edits as the programmer's if any of them was", async () => {
    const { editor, controller } = setup({ "a.ts": "hello\n" })
    await controller.start()
    const listen = controller.listen()
    editor.otherEdit("a.ts", 0, 0, "A")
    editor.userEdit("a.ts", 0, 0, "B")
    const report = await until(listen)
    expect(report.events).toEqual([{ kind: "edit", file: "a.ts", diff: expect.stringContaining("+BAhello"), by: "programmer" }])
  })
})

describe("turns", () => {
  it("lets the agent only comment during the programmer's turn", async () => {
    const { editor, controller } = setup({ "a.ts": "for (i <= n)\n" })
    await controller.start()
    await controller.read("a.ts")
    await controller.step([{ move: { file: "a.ts", line: 1, to: "line_end" } }])
    await advance(500)

    controller.takeTurn()
    const taken = await until(controller.listen())
    expect(taken.turn).toBe("user")
    expect(taken.events).toEqual([{ kind: "turn", to: "user" }])

    const refused = await controller.step([{ type: "x▌" }])
    expect(refused.rejected).toMatchObject({ error: { kind: "not_your_turn" } })

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
    expect(following.value!.events).toEqual([
      { kind: "edit", file: "a.ts", diff: expect.stringContaining("+for (i < n)"), by: "programmer" },
    ])

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
    await controller.step([{ move: { file: "a.ts", line: 1, to: "line_end" } }])
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
    expect(report.batches).toMatchObject([{ id: 1, status: "completed" }])
    expect(report.events).toEqual([{ kind: "message", text: "hello" }])
  })

  it("keeps a cancelled step's batch queued and reports it later", async () => {
    const { editor, controller } = setup({ "a.ts": "" })
    await controller.start()
    await controller.step([{ move: { file: "a.ts", line: 1, to: "line_end" } }, { type: "ab▌" }])
    const abort = new AbortController()
    const second = track(controller.step([{ type: "c▌" }], abort.signal))
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

  it("cancels a step whose abort arrives during its rehearsal", async () => {
    const { editor, controller } = setup({ "a.ts": "" })
    await controller.start()
    await controller.step([{ move: { file: "a.ts", line: 1, to: "line_end" } }, { type: "ab\u{258c}" }])
    const abort = new AbortController()
    const second = track(controller.step([{ type: "c\u{258c}" }], abort.signal))
    await Promise.resolve()
    abort.abort()
    await advance(10)
    expect(second.error).toMatchObject({ code: "cancelled" })

    // Canceled during the rehearsal, not before it: the batch was queued, and still plays.
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
    await controller.step([{ move: { file: "a.ts", line: 1, to: "line_end" } }, { type: "abc▌" }])
    const final = await until(controller.end("Done."))
    expect(final.batches).toMatchObject([{ id: 1, status: "completed" }])
    expect(editor.text("a.ts")).toBe("abc")
    expect(panel.events).toContainEqual({ type: "session", active: false, reason: "agent", summary: "Done." })
    await expect(controller.listen()).rejects.toMatchObject({ code: "no_session" })

    await controller.start("second")
    expect(controller.isActive).toBe(true)
  })

  it("reads a file's lines as reports show them, saying where it ends", async () => {
    const { controller } = setup({ "a.ts": "a\n\n", "b.ts": "a\nb", "c.ts": "" })
    await controller.start()
    expect(await controller.read("a.ts")).toEqual({
      file: "a.ts",
      dirty: false,
      lines: [
        { number: 1, text: "a" },
        { number: 2, text: "" },
      ],
      end: { final_newline: true },
    })
    expect(await controller.read("b.ts", 1, 1)).toEqual({ file: "b.ts", dirty: false, lines: [{ number: 1, text: "a" }] })
    expect((await controller.read("b.ts", 2)).end).toEqual({ final_newline: false })
    expect(await controller.read("c.ts")).toEqual({ file: "c.ts", dirty: false, lines: [], end: { final_newline: true } })
  })

  it("reads a file as the queued batches will leave it, while they still play, but not after an interruption", async () => {
    const { editor, controller } = setup({ "a.ts": "a\n", "b.ts": "b\n" })
    await controller.start()
    await controller.read("a.ts")
    const lines = async (file: string) => (await controller.read(file)).lines.map((l) => l.text)
    await controller.step([{ move: { file: "a.ts", line: 1, to: "line_end" } }, { type: "\nbc▌" }])
    const queued = controller.step([{ type: "\nd▌" }])
    await advance(10)
    expect(editor.text("a.ts")).toBe("a\n")
    expect(await lines("a.ts")).toEqual(["a", "bc", "d"])
    // Files the batches don't edit read as they are.
    expect(await lines("b.ts")).toEqual(["b"])
    editor.userEdit("a.ts", 0, 0, "!")
    expect((await controller.read("a.ts")).lines.map((l) => l.text).join("\n") + "\n").toBe(editor.text("a.ts"))
    await until(queued)
    expect((await controller.read("a.ts")).lines.map((l) => l.text).join("\n") + "\n").toBe(editor.text("a.ts"))
  })

  it("resolves paths under the agent's root into the editor's canonical form", async () => {
    const { editor, controller } = setup()
    editor.resolvePath = (file) => nodePath.resolve("/project", file).toLowerCase()
    await controller.start(undefined, "/Project")
    const file = nodePath.resolve("/Project", "A.ts").toLowerCase()
    await controller.step([{ move: { file: "A.ts", line: 1, to: "line_end" } }, { type: "abc▌" }])
    const listening = controller.listen()
    await advance(1000)
    editor.files.set(file, "XXabc")
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
        runs: [{ command: "npm test", exit_code: 0, output: "4 passed", shell: "bash" }],
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
        unplayed: [{ say: "All green." }],
        error: { kind: "command_failed" },
        runs: [{ command: "npm test", exit_code: 1, output: "1 failed" }],
      },
      { id: 2, status: "discarded" },
    ])
  })

  it("saves what the batch has typed before running a command, so the command reads it from disk", async () => {
    const { editor, controller } = setup({ "a.ts": "" }, { confirmCommands: false })
    await controller.start()
    await controller.step([{ move: { file: "a.ts", line: 1, to: "line_end" } }, { type: "x▌" }, { run: "tsc" }])
    await until(controller.step([]))
    expect(editor.commands).toMatchObject([{ command: "tsc", unsaved: [] }])
    expect(editor.saved).toContain(editor.resolvePath("a.ts"))
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
        runs: [{ command: "npm start", output: "listening on 3000", running: true }],
      },
    ])
  })

  it("tells the panel when a command left running ends later", async () => {
    const { editor, panel, controller } = setup({}, { confirmCommands: false })
    editor.commandScript["npm start"] = { ms: 10_000, exitCode: 1 }
    await controller.start()
    await controller.step([{ run: "npm start", wait: 2 }])
    await until(controller.step([]))
    const phases = () => panel.events.flatMap((e) => (e.type === "run" ? [[e.phase, e.exitCode]] : []))
    expect(phases()).toEqual([
      ["running", undefined],
      ["background", undefined],
    ])
    await advance(8_000)
    expect(phases().at(-1)).toEqual(["exited", 1])
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
      { id: 1, status: "interrupted", unplayed: [{ say: "Done." }], runs: [{ running: true }] },
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
    expect(report.batches).toEqual([{ id: 1, status: "discarded", unplayed: [{ run: "npm test" }] }])
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
      { id: 1, status: "failed", error: { kind: "command_declined" }, unplayed: [{ run: "rm -rf build" }] },
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
    const report = await controller.step([{ run: "npm test" }])
    expect(report.rejected).toMatchObject({ error: { kind: "not_your_turn" } })
    expect(editor.commands).toEqual([])
  })
})

describe("saving", () => {
  it("says which files a batch couldn't save", async () => {
    const { editor, controller } = setup({ "a.ts": "x\n" })
    editor.save = async () => {
      throw new Error("the file on disk is newer")
    }
    await controller.start()
    await controller.read("a.ts")
    await controller.step([{ move: { file: "a.ts", line: 1, to: "line_end" } }, { type: " // a▌" }])
    const report = await until(controller.step([]))
    expect(report.batches[0]).toMatchObject({ status: "completed", unsaved: [{ file: "a.ts", error: "the file on disk is newer" }] })
  })

  it("doesn't run a command after a save that failed, since it would read the old file", async () => {
    const { editor, controller } = setup({ "a.ts": "x\n" }, { confirmCommands: false })
    editor.save = async () => {
      throw new Error("the file on disk is newer")
    }
    editor.commandScript["node a.ts"] = { ms: 100, exitCode: 0 }
    await controller.start()
    await controller.read("a.ts")
    await controller.step([{ move: { file: "a.ts", line: 1, to: "line_end" } }, { type: " // a▌" }, { run: "node a.ts" }])
    const report = await until(controller.step([]))
    expect(report.batches[0]).toMatchObject({ status: "failed", error: { kind: "save_failed" }, unplayed: [{ run: "node a.ts" }] })
    expect(report.batches[0]!.error!.message).toMatch(/a\.ts \(the file on disk is newer\)/)
    expect(report.batches[0]!.error!.message).toMatch(/Ask the programmer/)
    // The error names the file, so the batch doesn't list it again.
    expect(report.batches[0]!.unsaved).toBeUndefined()
    expect(editor.commands).toEqual([])
  })
})

describe("changes by others, while batches are queued", () => {
  it("rehearses the queued batches from a change that didn't interrupt them", async () => {
    const { editor, controller } = setup({ "a.ts": "hello\nworld\n" })
    await controller.start()
    await controller.read("a.ts")
    await controller.step([{ move: { file: "a.ts", line: 2, at: "▌world" } }, { say: "one two three four five six seven eight nine ten" }])
    await advance(300)
    editor.otherEdit("a.ts", 0, 0, "XX\n")
    const typed = await until(controller.step([{ type: "!▌" }]))
    expect(typed.rejected).toBeUndefined()
    expect((await controller.read("a.ts")).lines.map((l) => l.text)).toEqual(["XX", "hello", "!world"])
    const done = await until(controller.step([]))
    expect([...typed.batches, ...done.batches].map((b) => b.status)).toEqual(["completed", "completed"])
    expect(editor.text("a.ts")).toBe("XX\nhello\n!world\n")
  })

  it("doesn't interrupt for a change to a file only a finished batch edited", async () => {
    const { editor, controller } = setup({ "a.ts": "a\n", "b.ts": "b\n" })
    await controller.start()
    await controller.read("a.ts")
    await controller.read("b.ts")
    await controller.step([{ move: { file: "a.ts", line: 1, to: "line_end" } }, { type: "1▌" }])
    await until(controller.step([{ move: { file: "b.ts", line: 1, to: "line_end" } }, { type: " long text here▌" }]))
    await advance(300)
    editor.otherEdit("a.ts", 0, 0, "// tool\n")
    const report = await until(controller.step([]))
    expect(report.batches.map((b) => [b.id, b.status])).toEqual([[2, "completed"]])
    expect(report.events).toMatchObject([{ kind: "edit", file: "a.ts", by: "other" }])
    expect(editor.text("b.ts")).toBe("b long text here\n")
    expect((await controller.read("a.ts")).lines.map((l) => l.text)).toEqual(["// tool", "a1"])
  })

  it("still interrupts for a change to a file a queued batch edits", async () => {
    const { editor, controller } = setup({ "a.ts": "a\n", "b.ts": "b\n" })
    await controller.start()
    await controller.read("a.ts")
    await controller.read("b.ts")
    await controller.step([{ move: { file: "b.ts", line: 1, to: "line_end" } }, { type: " long text here▌" }])
    const queued = controller.step([{ move: { file: "a.ts", line: 1, to: "line_end" } }, { type: "1▌" }])
    await advance(300)
    editor.otherEdit("a.ts", 0, 0, "// tool\n")
    const first = await until(queued)
    const rest = await until(controller.step([]))
    expect([...first.batches, ...rest.batches].map((b) => b.status)).toEqual(["interrupted", "discarded"])
  })
})
