// How reports read. These check what a report says, not its exact layout, so the wording can keep improving.

import { describe, expect, it } from "vitest"
import type { Report } from "@ai-pair/protocol"
import { renderFile, renderReport } from "../src/render"
import { modeGuide } from "../src/modeGuide"

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

  it("says a rejected batch wasn't queued, which beat and action would fail and why, and how the code would read", () => {
    const text = renderReport(
      report({
        rejected: {
          beat: 2,
          action: 3,
          value: { move: { line: 2, at: "x▌" } },
          error: { kind: "ambiguous", message: "2 matches", candidates: [{ line: 1, context: "x" }] },
          code: { file: "a.ts", lines: [{ number: 3, text: "y▌" }] },
        },
      }),
      "step",
    )
    expect(text).toMatch(/rejected/)
    expect(text).toMatch(/action 3 of beat 2 would fail:\n  \{"move":\{"line":2,"at":"x▌"\}\}/)
    expect(text).toMatch(/ambiguous: 2 matches\n  line 1: x/)
    expect(text).toMatch(/a\.ts:\n3  y▌/)
    expect(text).toMatch(/submit the whole batch again/)
  })

  it("says whether the programmer made an edit, or something else did", () => {
    const text = renderReport(
      report({
        events: [
          { kind: "edit", file: "a.ts", diff: "@@ -1 +1 @@\n-a\n+b", by: "programmer" },
          { kind: "edit", file: "package.json", diff: "@@ -1 +1 @@\n-{}\n+{ }", by: "other" },
        ],
      }),
      "listen",
    )
    expect(text).toMatch(/The programmer edited a\.ts:\n@@/)
    expect(text).toMatch(/package\.json was changed, not by the programmer.*:\n@@/)
  })

  it("says where code reaches the end of the file, and when no newline ends it", () => {
    const code = (final_newline: boolean) => ({ file: "a.ts", lines: [{ number: 9, text: "}▌" }], end: { final_newline } })
    const ending = renderReport(report({ batches: [{ id: 1, status: "completed", code: code(true) }] }), "step")
    expect(ending).toMatch(/9  }▌\n   \(end of file\)$/)
    const missing = renderReport(report({ batches: [{ id: 1, status: "completed", code: code(false) }] }), "step")
    expect(missing).toMatch(/\(end of file, with no newline after the last line\)$/)
  })

  it("shows gaps in long code", () => {
    const lines = [1, 2, 58, 59].map((number) => ({ number, text: `line ${number}` }))
    const text = renderReport(report({ batches: [{ id: 1, status: "completed", code: { file: "a.ts", lines } }] }), "step")
    expect(text).toMatch(/line 2\n.*…\n.*line 58/)
  })

  it("puts what the programmer did first, and lists unplayed beats ready to resubmit", () => {
    const text = renderReport(
      report({
        events: [{ kind: "message", text: "use zod\nplease" }],
        batches: [
          {
            id: 6,
            status: "interrupted",
            code: { file: "a.ts", lines: [{ number: 3, text: "  res.sta▌" }] },
            unplayed: [{ do: [{ type: "tus(▌)" }] }],
          },
          { id: 7, status: "discarded", unplayed: [{ say: "Next." }] },
        ],
      }),
      "step",
    )
    expect(text.indexOf("use zod")).toBeLessThan(text.indexOf("Batch 6"))
    expect(text).toMatch(/> please/)
    expect(text).toMatch(/Batch 6 interrupted/)
    expect(text).toContain(JSON.stringify({ do: [{ type: "tus(▌)" }] }))
    expect(text).toMatch(/Batch 7 discarded/)
    expect(text).toContain(JSON.stringify({ say: "Next." }))
  })

  it("says why a batch failed, with the candidates, and which beat failed", () => {
    const text = renderReport(
      report({
        batches: [
          {
            id: 8,
            status: "failed",
            error: {
              kind: "ambiguous",
              message: '2 matches for "x"',
              candidates: [
                { line: 12, context: "x = 1" },
                { line: 31, context: "x = 2" },
              ],
            },
            unplayed: [{ do: [{ move: { line: 2, at: "x▌" } }] }],
          },
        ],
      }),
      "step",
    )
    expect(text).toMatch(/ambiguous: 2 matches/)
    expect(text).toMatch(/line 12: x = 1/)
    expect(text).toMatch(/line 31: x = 2/)
    expect(text).toMatch(/the beat that failed/)
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

  it("says where the file ends, and when no newline ends it, even when it's empty", () => {
    const lines = [{ number: 1, text: "hi" }]
    expect(renderFile({ file: "a.ts", dirty: false, lines, end: { final_newline: true } })).toMatch(/1  hi\n   \(end of file\)$/)
    expect(renderFile({ file: "a.ts", dirty: false, lines, end: { final_newline: false } })).toMatch(/no newline after the last line/)
    expect(renderFile({ file: "a.ts", dirty: false, lines: [], end: { final_newline: true } })).toBe("a.ts:\n   (end of file)")
    expect(renderFile({ file: "a.ts", dirty: false, lines: [] })).toMatch(/no lines in this range/)
  })
})

describe("saving", () => {
  it("says which files a batch couldn't save, and that the disk has the old file", () => {
    const text = renderReport(report({ batches: [{ id: 3, status: "completed", unsaved: [{ file: "a.ts", error: "the file on disk is newer" }] }] }), "step")
    expect(text).toMatch(/Couldn't save a\.ts \(the file on disk is newer\)/)
    expect(text).toMatch(/file on disk doesn't/)
  })
})

describe("modes", () => {
  it("names the session's mode in the join report and points at its page", () => {
    expect(renderReport(report({ mode: "build" }), "join")).toMatch(/Build mode/)
    const learn = renderReport(report({ mode: "learn", drive: "together" }), "join")
    expect(learn).toMatch(/Learn mode/)
    // The mode refines the guide, so the agent is told which wins.
    expect(learn).toMatch(/mode page wins/)
    expect(renderReport(report({}), "step")).not.toMatch(/mode/)
  })

  it("gives each learn split its own who-does-the-work words, over one shared core", () => {
    const show = modeGuide(report({ mode: "learn", drive: "show" })) ?? ""
    const together = modeGuide(report({ mode: "learn", drive: "together" })) ?? ""
    const drive = modeGuide(report({ mode: "learn", drive: "try" })) ?? ""
    // Shared teaching core: one idea at a time, never a cold question.
    for (const page of [show, together, drive]) {
      expect(page).toMatch(/One idea per chunk/)
      expect(page).toMatch(/Never ask about what you haven't taught/)
    }
    // The split is who types, and each page carries only its own split.
    expect(show).toMatch(/Type everything/)
    expect(show).not.toMatch(/worked example/)
    expect(together).toMatch(/worked example/)
    expect(together).toMatch(/take the turn/)
    expect(drive).toMatch(/mostly the programmer/)
    expect(drive).not.toMatch(/worked example, explained as it lands\. Then/)
    // An unknown or absent mode has no page, so older editors change nothing.
    expect(modeGuide(report({}))).toBeUndefined()
    expect(modeGuide(report({ mode: "build" }))).toMatch(/Build/)
  })
})
