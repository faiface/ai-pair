// How reports read. These check what a report says, not its exact layout, so the wording can keep improving.

import { describe, expect, it } from "vitest"
import type { Report } from "@ai-pair/protocol"
import { renderFile, renderReport } from "../src/render"

const report = (r: Partial<Report>): Report => ({ batches: [], events: [], turn: "agent", ...r })

describe("reports", () => {
  it("shows a batch's code as numbered lines, with the cursor", () => {
    const text = renderReport(
      report({
        batches: [
          {
            id: 5,
            status: "completed",
            code: { file: "src/server.ts", lines: [{ number: 12, text: "  const todo = createTodo();▌" }] },
          },
        ],
        submitted: { id: 6, status: "playing" },
      }),
      "step",
    )
    expect(text).toMatch(/Batch 5 completed/)
    expect(text).toMatch(/src\/server\.ts/)
    expect(text).toMatch(/12 +  const todo = createTodo\(\);▌/)
    expect(text).toMatch(/Batch 6 is playing/)
  })

  it("shows gaps in long code", () => {
    const lines = [1, 2, 58, 59].map((number) => ({ number, text: `line ${number}` }))
    const text = renderReport(report({ batches: [{ id: 1, status: "completed", code: { file: "a.ts", lines } }] }), "step")
    expect(text).toMatch(/line 2\n.*…\n.*line 58/)
  })

  it("puts what the programmer did first, and lists unplayed actions ready to resubmit", () => {
    const text = renderReport(
      report({
        events: [{ kind: "message", text: "use zod\nplease" }],
        batches: [
          {
            id: 6,
            status: "interrupted",
            code: { file: "a.ts", lines: [{ number: 3, text: "  res.sta▌" }] },
            unplayed: [{ type: ["tus(", ")"] }],
          },
          { id: 7, status: "discarded", unplayed: [{ say: "Next." }] },
        ],
      }),
      "step",
    )
    expect(text.indexOf("use zod")).toBeLessThan(text.indexOf("Batch 6"))
    expect(text).toMatch(/> please/)
    expect(text).toMatch(/Batch 6 interrupted/)
    expect(text).toContain(JSON.stringify({ type: ["tus(", ")"] }))
    expect(text).toMatch(/Batch 7 discarded/)
    expect(text).toContain(JSON.stringify({ say: "Next." }))
  })

  it("says why a batch failed, with the candidates, and which action failed", () => {
    const text = renderReport(
      report({
        batches: [
          {
            id: 8,
            status: "failed",
            error: {
              kind: "anchor_ambiguous",
              message: '2 matches for "x"',
              candidates: [
                { line: 12, context: "x = 1" },
                { line: 31, context: "x = 2" },
              ],
            },
            unplayed: [{ move: { before: "x", after: "" } }],
          },
        ],
      }),
      "step",
    )
    expect(text).toMatch(/anchor_ambiguous: 2 matches/)
    expect(text).toMatch(/line 12: x = 1/)
    expect(text).toMatch(/line 31: x = 2/)
    expect(text).toMatch(/the one that failed/)
  })

  it("shows a command's outcome and output", () => {
    const text = renderReport(
      report({
        batches: [
          { id: 9, status: "failed", error: { kind: "command_failed", message: "The command exited with 1." }, runs: [{ command: "npm test", exit_code: 1, output: "1 failed", shell: "zsh" }] },
        ],
      }),
      "step",
    )
    expect(text).toMatch(/npm test/)
    expect(text).toMatch(/zsh/)
    expect(text).toMatch(/exited with 1/)
    expect(text).toMatch(/```\n1 failed\n```/)
  })

  it("tells the agent what to do when nothing happened in time", () => {
    expect(renderReport(report({ waiting: true }), "listen")).toMatch(/Call `listen` again/)
    expect(renderReport(report({ waiting: true }), "step")).toMatch(/Carry on/)
  })

  it("says when it's the programmer's turn, and when the session ends", () => {
    expect(renderReport(report({ turn: "user", events: [{ kind: "turn", to: "user" }] }), "listen")).toMatch(/programmer's turn/)
    expect(renderReport(report({ events: [{ kind: "end" }] }), "listen")).toMatch(/ended the session/)
    expect(renderReport(report({}), "end")).toMatch(/ended/)
  })
})

describe("files", () => {
  it("shows numbered lines, and whether the buffer has unsaved changes", () => {
    const text = renderFile({ file: "a.ts", dirty: true, lines: [{ number: 1, text: "hi" }] })
    expect(text).toMatch(/a\.ts/)
    expect(text).toMatch(/unsaved/)
    expect(text).toMatch(/1 +hi/)
  })
})
