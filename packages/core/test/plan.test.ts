import { describe, expect, it } from "vitest"
import { LineIds } from "../src/lines"
import { StagePlan, type FileView, type StageRecord } from "../src/plan"

const FILE = "/w/a.py"

/** A workspace of one file, edited as the editor would report it. */
function workspace(text: string) {
  const lines = LineIds.editor()
  const state = { text }
  lines.of(FILE, text)
  return {
    lines,
    state,
    read: async (file: string) => (file === FILE ? state.text : undefined),
    /** Replaces the first `from` with `to`, as the smallest change an editor would report. */
    edit(from: string, to: string) {
      const at = state.text.indexOf(from)
      if (at < 0) throw new Error(`not found: ${from}`)
      let prefix = 0
      while (prefix < from.length && prefix < to.length && from[prefix] === to[prefix]) prefix++
      let suffix = 0
      while (suffix < from.length - prefix && suffix < to.length - prefix && from.at(-1 - suffix) === to.at(-1 - suffix)) suffix++
      const offset = at + prefix
      const deleteLength = from.length - prefix - suffix
      const text = to.slice(prefix, to.length - suffix)
      lines.of(FILE, state.text)
      lines.apply(FILE, { offset, deleteLength, text })
      state.text = state.text.slice(0, offset) + text + state.text.slice(offset + deleteLength)
    },
  }
}

function stage(number: number, before: string | undefined, after: string | undefined): StageRecord {
  return { number, title: `s${number}`, notes: "", snapshot: `snap${number}`, changes: [{ file: FILE, before, after }] }
}

function left(plan: StagePlan, w: ReturnType<typeof workspace>): FileView | undefined {
  return plan.view(FILE, w.state.text, w.lines.of(FILE, w.state.text))
}

/** What's left, compactly: `+text` to write, `-text` to take out. */
function pending(view: FileView | undefined): string[] {
  return (view?.items ?? []).flatMap((i) => (i.kind === "write" ? [`+${i.text}`] : i.kind === "remove" ? [`-${i.text}`] : []))
}

describe("stage plan", () => {
  it("starts with what the stage adds and takes out", async () => {
    const w = workspace("a\nb\nc\n")
    const plan = new StagePlan([stage(1, "a\nb\nc\n", "a\nB\nc\nd\n")])
    await plan.advance(w.read, w.lines)
    expect(pending(left(plan, w))).toEqual(["-b", "+B", "+d"])
  })

  it("keeps a change whole when the diff could split a blank line off it", async () => {
    const before = "def f():\n    return 1\n\n\nf()\n"
    const w = workspace(before)
    const plan = new StagePlan([stage(1, before, "def f():\n    return 1\n\ndef g():\n    return 2\n\n\nf()\n")])
    await plan.advance(w.read, w.lines)
    // One stretch to write, so a `write` takes the method and its blank line together.
    const kinds = (left(plan, w)?.items ?? []).map((i) => (i.kind === "write" ? "+" : " ")).join("")
    expect(kinds).toBe("   +++  ")
  })

  it("counts a line typed as is, in its place, as written", async () => {
    const w = workspace("a\nc\n")
    const plan = new StagePlan([stage(1, "a\nc\n", "a\nb\nc\n")])
    await plan.advance(w.read, w.lines)
    w.edit("a\n", "a\n  b\n")
    expect(pending(left(plan, w))).toEqual([])
  })

  it("drops a line of the plan the programmer deletes, instead of writing it again", async () => {
    const w = workspace("a\nc\n")
    const plan = new StagePlan([stage(1, "a\nc\n", "a\nb\nc\nd\n")])
    await plan.advance(w.read, w.lines)
    w.edit("a\n", "a\nb\n")
    // Seen as written: the controller looks after each of the programmer's edits.
    expect(pending(left(plan, w))).toEqual(["+d"])
    w.edit("b\n", "")
    expect(pending(left(plan, w))).toEqual(["+d"])
  })

  it("keeps a line due to go once the programmer changes it", async () => {
    const w = workspace("a\nold\nc\n")
    const plan = new StagePlan([stage(1, "a\nold\nc\n", "a\nc\n")])
    await plan.advance(w.read, w.lines)
    w.edit("old", "older")
    expect(pending(left(plan, w))).toEqual([])
  })

  it("merges the next stage into the programmer's version, theirs winning a conflict", async () => {
    const w = workspace("x = 1\ny = 2\n")
    const stages = [stage(1, "x = 1\ny = 2\n", "x = 1\ny = 2\n"), stage(2, "x = 1\ny = 2\n", "x = 10\ny = 2\nz = 3\n")]
    // The first stage changes nothing, so the second starts as soon as it's in.
    const plan = new StagePlan(stages)
    w.edit("x = 1", "x = 5")
    await plan.advance(w.read, w.lines)
    expect(plan.number).toBe(2)
    expect(pending(left(plan, w))).toEqual(["+z = 3"])
    expect(plan.setAside).toEqual([{ file: FILE, stage: 2, plan: "x = 10\n", kept: "x = 5\n" }])
  })

  it("waits for a stage's code before starting the next", async () => {
    const w = workspace("a\n")
    const stages: StageRecord[] = [stage(1, "a\n", "a\nb\n")]
    const plan = new StagePlan(stages)
    await plan.advance(w.read, w.lines)
    stages.push(stage(2, "a\nb\n", "a\nb\nc\n"))
    await plan.advance(w.read, w.lines)
    expect(plan.number).toBe(1)
    w.edit("a\n", "a\nb\n")
    await plan.advance(w.read, w.lines)
    expect(plan.number).toBe(2)
    expect(pending(left(plan, w))).toEqual(["+c"])
  })

  it("finds its lines again by their text when every identity is lost", async () => {
    const w = workspace("a\nb\n")
    const plan = new StagePlan([stage(1, "a\nb\n", "a\nb\nc\n")])
    await plan.advance(w.read, w.lines)
    // Changed without the change being heard: the same text, all new identities.
    const fresh = LineIds.editor()
    expect(pending(plan.view(FILE, w.state.text, fresh.of(FILE, w.state.text)))).toEqual(["+c"])
  })
})
