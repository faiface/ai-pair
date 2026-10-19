import { describe, expect, it } from "vitest"
import { z } from "zod"
import type { Beat, Report } from "@ai-pair/protocol"
import { playedOnly } from "../src/history"
import { renderReport, type ReportingTool } from "../src/render"

/** An assistant message from `turn`: some text, then the call, and the provider's record of the call. */
const Sent = z.object({
  content: z.tuple([z.unknown(), z.object({ intent: z.string(), arguments: z.record(z.string(), z.unknown()) })]),
  providerPayload: z.object({ items: z.tuple([z.object({ arguments: z.string() })]) }),
})

/**
 * The beats of the call in an assistant message from `turn`, made directly or through the device,
 * after checking that the provider's record of it, which OMP sends instead, says the same.
 */
function beatsOf(message: unknown, device = false): unknown {
  const sent = Sent.parse(message)
  const args = sent.content[1].arguments
  expect(JSON.parse(sent.providerPayload.items[0].arguments)).toEqual(args)
  return device ? JSON.parse(z.string().parse(args.content)).beats : args.beats
}

const greet: Beat = { say: "First the greeting.", do: [{ move: { file: "a.ts", line: 1, to: "line_end" } }, { type: "hello▌" }, { type: " there▌" }] }
const name: Beat = { say: "Then the name.", do: [{ type: " bob▌" }] }

let ids = 0
/**
 * A pair tool call and its result, as OMP keeps them, with the OpenAI Responses record of the
 * call it keeps beside. The call goes through OMP's device when `device` is set.
 */
function turn(tool: ReportingTool, args: object, report: Report, device = false) {
  const n = ++ids
  const id = `call-${n}|fc-${n}`
  const call = device
    ? { type: "toolCall", id, name: "write", arguments: { path: `xd://mcp__pair_${tool}`, content: JSON.stringify(args) }, intent: "Pairing" }
    : { type: "toolCall", id, name: `mcp__pair_${tool}`, arguments: args, intent: "Pairing" }
  const item = { type: "function_call", call_id: `call-${n}`, id: `fc-${n}`, name: call.name, arguments: JSON.stringify(call.arguments), status: "completed" }
  return [
    { role: "assistant", content: [{ type: "text", text: "Working." }, call], providerPayload: { type: "openaiResponsesHistory", items: [item] } },
    { role: "toolResult", toolCallId: id, toolName: call.name, content: [{ type: "text", text: renderReport(report, tool) }] },
  ]
}

const quiet: Report = { batches: [], events: [], turn: "agent" }

describe("history", () => {
  it("cuts an interrupted step down to the beats that played, keeping the session's own messages as they were", () => {
    for (const device of [false, true]) {
      const messages = [
        ...turn("start", {}, { ...quiet, voice: "off" }),
        ...turn("step", { beats: [greet, name] }, { ...quiet, submitted: { id: 1, status: "playing" } }, device),
        // Cut inside " there▌": the beat comes back as what's left of it, without its say.
        ...turn("listen", {}, { ...quiet, batches: [{ id: 1, status: "interrupted", unplayed: [{ do: [{ type: "ere▌" }] }, name] }] }),
      ]
      const before = structuredClone(messages)
      const after = playedOnly(messages)
      expect(beatsOf(after[2], device)).toEqual([{ say: greet.say, do: greet.do!.slice(0, 2) }])
      expect(Sent.parse(after[2]).content[1].intent).toBe("Pairing")
      expect(messages).toEqual(before)
    }
  })

  it("empties a discarded step, and matches batch numbers within their own session", () => {
    const messages = [
      ...turn("start", {}, quiet),
      ...turn("step", { beats: [greet] }, { ...quiet, submitted: { id: 1, status: "playing" } }),
      ...turn("end", {}, { ...quiet, batches: [{ id: 1, status: "completed" }] }),
      ...turn("start", {}, quiet),
      ...turn("step", { beats: [name] }, { ...quiet, submitted: { id: 1, status: "queued" } }),
      ...turn("listen", {}, { ...quiet, batches: [{ id: 1, status: "discarded", unplayed: [name] }] }),
    ]
    const after = playedOnly(messages)
    expect(beatsOf(after[2])).toEqual([greet])
    expect(beatsOf(after[8])).toEqual([])
  })

  it("finds a step's batch in its own report when an interruption discarded it before it was queued", () => {
    const messages = [
      ...turn("start", {}, quiet),
      ...turn("step", { beats: [greet] }, { ...quiet, submitted: { id: 1, status: "playing" } }),
      // As seen live: the interruption lands while this step is still being checked, so its
      // report names its batch only among the finished ones, after the batch before it.
      ...turn("step", { beats: [name] }, { ...quiet, batches: [{ id: 1, status: "interrupted" }, { id: 2, status: "discarded", unplayed: [name] }] }),
      // A rejected step's report lists earlier batches too; none of them is its own.
      ...turn("step", { beats: [greet] }, { ...quiet, batches: [{ id: 3, status: "completed" }], rejected: { beat: 1, action: 2, value: { type: "hello▌" }, error: { kind: "no_line", message: "No line 1." } } }),
    ]
    const after = playedOnly(messages)
    expect(beatsOf(after[2])).toEqual([greet])
    expect(beatsOf(after[4])).toEqual([])
    expect(beatsOf(after[6])).toEqual([greet])
  })

  it("leaves a history where everything played as it is", () => {
    const messages = [
      ...turn("start", {}, quiet),
      ...turn("step", { beats: [greet] }, { ...quiet, submitted: { id: 1, status: "playing" } }),
      ...turn("listen", {}, { ...quiet, batches: [{ id: 1, status: "completed" }] }),
    ]
    expect(playedOnly(messages)).toBe(messages)
  })
})
