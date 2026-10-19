// An agent's history, made to say only what played. A `step` call holds every beat the agent
// sent; when the programmer cuts a batch short, its call still reads as if all of it was typed and
// said, and agents come to believe it. The reports that follow list what didn't play, so the call
// can be cut back to what did. OMP runs this on what it sends the model (see ompExtension.ts);
// the saved session keeps the original. It works from the history alone, so the same history is
// always sent the same way, and the provider's prompt cache still holds after the one change.

import type { Beat } from "@ai-pair/protocol"
import { z } from "zod"

/** The pair server's name in the agent's MCP setup; its tools come out as `mcp__pair_<tool>`. */
const TOOL_PREFIX = "mcp__pair_"
/** OMP can also reach MCP tools by writing their arguments, as JSON, to `xd://<tool>`. */
const DEVICE_PREFIX = `xd://${TOOL_PREFIX}`

/** The parts of OMP's messages this reads; everything else in them is passed on as it is. */
const Args = z.record(z.string(), z.unknown())
const ToolCall = z.object({ type: z.literal("toolCall"), id: z.string(), name: z.string(), arguments: Args })
type ToolCall = z.infer<typeof ToolCall>
const DeviceArgs = z.object({ path: z.string().startsWith(DEVICE_PREFIX), content: z.string() })
/**
 * The provider's own record of an assistant message, which OMP sends back in place of the
 * message's content when it has one (as OpenAI's Responses API items, to keep its reasoning).
 * Its function calls carry their arguments again, as a JSON string, under the call's id: the part
 * of OMP's tool call id before the `|`.
 */
const ProviderPayload = z.looseObject({ items: z.array(z.unknown()) })
const FunctionCallItem = z.looseObject({ type: z.literal("function_call"), call_id: z.string() })
type Message = { role?: unknown; content?: unknown; toolCallId?: unknown; providerPayload?: unknown }
type PairCall = { tool: string; args: Record<string, unknown> }

/**
 * The messages with each cut-short `step` call holding only the beats that played. Returns the
 * same array when nothing needs changing.
 */
export function playedOnly<M>(messages: M[]): M[] {
  /** The beats of each `step` call, by tool call id. */
  const steps = new Map<string, Beat[]>()
  /** The ids of every pair tool call, whose results are reports. */
  const pairCalls = new Set<string>()
  /** The `step` call that submitted each batch of the current session. */
  const batches = new Map<number, string>()
  const played = new Map<string, Beat[]>()
  for (const message of messages as Message[]) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        const call = pairCall(block)
        if (!call) continue
        pairCalls.add(call.id)
        // Batch numbers are unique only while the editor runs; a new session may follow a reload.
        if (call.tool === "start") batches.clear()
        if (call.tool === "step" && Array.isArray(call.args.beats)) steps.set(call.id, call.args.beats as Beat[])
      }
    } else if (message.role === "toolResult" && typeof message.toolCallId === "string" && pairCalls.has(message.toolCallId)) {
      const text = textOf(message.content)
      if (steps.has(message.toolCallId)) {
        const own = ownBatch(text)
        if (own !== undefined && !batches.has(own)) batches.set(own, message.toolCallId)
      }
      for (const [id, unplayed] of notPlayed(text)) {
        const callId = batches.get(id)
        const beats = callId === undefined ? undefined : steps.get(callId)
        const kept = beats && playedBeats(beats, unplayed)
        if (kept) played.set(callId!, kept)
      }
    }
  }
  if (played.size === 0) return messages
  return messages.map((message) => {
    const m = message as Message
    if (m.role !== "assistant" || !Array.isArray(m.content)) return message
    const calls = m.content.map((b) => ToolCall.safeParse(b).data)
    if (!calls.some((c) => c && played.has(c.id))) return message
    // New objects all the way down: the session's own messages stay as they were.
    const rewritten = new Map<string, Record<string, unknown>>()
    const content = m.content.map((b: object, i) => {
      const call = calls[i]
      if (!call || !played.has(call.id)) return b
      const args = playedArgs(call, played.get(call.id)!)
      rewritten.set(call.id.split("|")[0]!, args)
      return { ...b, arguments: args }
    })
    const payload = ProviderPayload.safeParse(m.providerPayload).data
    if (!payload) return { ...message, content }
    const items = payload.items.map((item) => {
      const fc = FunctionCallItem.safeParse(item).data
      const args = fc && rewritten.get(fc.call_id)
      return args ? { ...fc, arguments: JSON.stringify(args) } : item
    })
    return { ...message, content, providerPayload: { ...payload, items } }
  })
}

/**
 * The beats of a call that played, given the ones a report says didn't: those before the first
 * unplayed beat, and of a beat cut short, its `say` and the actions that played whole. Undefined
 * when the report's beats aren't this call's, or everything played.
 */
export function playedBeats(beats: Beat[], unplayed: Beat[]): Beat[] | undefined {
  const cut = beats.length - unplayed.length
  if (cut < 0 || unplayed.length === 0) return undefined
  // Every unplayed beat after the first comes back as it was sent.
  for (let i = 1; i < unplayed.length; i++) if (!same(beats[cut + i], unplayed[i])) return undefined
  const first = unplayed[0]!
  const whole = beats[cut]!
  if (same(whole, first)) return beats.slice(0, cut)
  // A beat cut short comes back as what's left of its actions, without its `say`, which was heard.
  // The first of them may be what's left of an action cut short, which didn't play whole either.
  const actions = whole.do ?? []
  const rest = first.do ?? []
  const done = actions.length - rest.length
  if (first.say !== undefined || done < 0) return undefined
  for (let i = 1; i < rest.length; i++) if (!same(actions[done + i], rest[i])) return undefined
  const head: Beat = {}
  if (whole.say !== undefined) head.say = whole.say
  if (done > 0) head.do = actions.slice(0, done)
  return head.say !== undefined || head.do ? [...beats.slice(0, cut), head] : beats.slice(0, cut)
}

/**
 * The batch a `step` call submitted, by its result. Still to play, it's named as queued or
 * playing; already finished (an interruption discards it at once), it's among the finished
 * batches with no mark of its own, but it's the last of them: calls run one at a time, so no
 * batch can come after it. A rejected batch was never numbered.
 */
function ownBatch(text: string): number | undefined {
  const submitted = /^Batch (\d+) is (?:queued|playing)\.$/m.exec(text)
  if (submitted) return Number(submitted[1])
  if (/^Your batch was rejected:/m.test(text)) return undefined
  const finished = [...text.matchAll(/^Batch (\d+) (?:completed|interrupted|discarded|failed)[.,]/gm)].map((m) => Number(m[1]))
  return finished.length > 0 ? Math.max(...finished) : undefined
}

/** A pair tool call, called directly or through OMP's device. */
function pairCall(block: unknown): (PairCall & { id: string }) | undefined {
  const call = ToolCall.safeParse(block).data
  if (!call) return undefined
  if (call.name.startsWith(TOOL_PREFIX)) return { id: call.id, tool: call.name.slice(TOOL_PREFIX.length), args: call.arguments }
  const device = call.name === "write" ? DeviceArgs.safeParse(call.arguments).data : undefined
  const args = device && parseArgs(device.content)
  return args && { id: call.id, tool: device.path.slice(DEVICE_PREFIX.length), args }
}

function parseArgs(json: string): Record<string, unknown> | undefined {
  try {
    return Args.safeParse(JSON.parse(json)).data
  } catch {
    return undefined
  }
}

/** The call's arguments with its beats replaced, in whichever form it was made. */
function playedArgs(call: ToolCall, beats: Beat[]): Record<string, unknown> {
  if (call.name !== "write") return { ...call.arguments, beats }
  return { ...call.arguments, content: JSON.stringify({ ...parseArgs(call.arguments.content as string), beats }) }
}

/**
 * The unplayed beats a report lists, by batch: under the batch's own line, after "Not played…:",
 * one beat as JSON on each line. See `renderBatch` in render.ts.
 */
function notPlayed(text: string): Map<number, Beat[]> {
  const found = new Map<number, Beat[]>()
  let batch: number | undefined
  let beats: Beat[] | undefined
  for (const line of text.split("\n")) {
    const header = /^Batch (\d+) (?:interrupted|discarded|failed)\b/.exec(line)
    if (header) {
      batch = Number(header[1])
      beats = undefined
    } else if (batch !== undefined && line.startsWith("Not played") && line.endsWith(":")) {
      beats = []
      found.set(batch, beats)
    } else if (beats && line.startsWith("  {")) {
      try {
        beats.push(JSON.parse(line) as Beat)
      } catch {
        found.delete(batch!)
        beats = undefined
      }
    } else {
      beats = undefined
    }
  }
  return found
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.map((c: { type?: unknown; text?: unknown }) => (c.type === "text" && typeof c.text === "string" ? c.text : "")).join("\n")
}

/** Deep equality of JSON values, whatever order their keys came in. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i]))
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null || Array.isArray(b)) return false
  const x = a as Record<string, unknown>
  const y = b as Record<string, unknown>
  const keys = Object.keys(x)
  return keys.length === Object.keys(y).length && keys.every((k) => k in y && same(x[k], y[k]))
}
