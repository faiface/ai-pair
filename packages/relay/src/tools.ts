// The MCP tool definitions: schemas and the descriptions the agent reads at the point of use.

import { z } from "zod"
import { ACTION_KINDS, actionKinds, moveProblem } from "@ai-pair/protocol"

const nearLine = z
  .number()
  .int()
  .optional()
  .describe("Only if the text still occurs more than once: take the match closest to this line.")
const Anchor = z.strictObject({
  text: z.string().describe("Exact text; may span lines. Long enough to occur only once, e.g. a whole line."),
  near_line: nearLine,
})
const Range = z.strictObject({
  from: Anchor,
  to: z.strictObject({ text: z.string().describe("Exact text; its first match after `from` ends the range.") }),
})
const file = z.string().describe("Path relative to your working directory, or absolute.")
const typeText = z.tuple([z.string(), z.string()])

const Action = z.union([
  action({
    say: z
      .string()
      .describe(
        "Narrate right before the actions it describes: what you're doing, why, and how your code does it. It's about your code and your choices, not how the language or its libraries work (unless the programmer asked to learn them). Explain the code, don't recite it. One to three sentences; `backticks` render as code. Playback pauses so the programmer can read it.",
      ),
  }),
  action({
    move: z
      .strictObject({
        file: file.optional().describe("Switch to this file (created empty if it doesn't exist). Omit to stay in the current file."),
        before: z
          .string()
          .optional()
          .describe("Exact text right before the spot; may span lines. Together with `after`, long enough to occur only once."),
        after: z.string().optional().describe("Exact text right after the spot. Either may be empty, not both."),
        near_line: nearLine,
        to: z
          .enum(["end", "file_start", "file_end"])
          .optional()
          .describe("Instead of a spot. `end`: the end of your cursor's line, to step past what closes a pair you've filled."),
        lines: z
          .number()
          .int()
          .optional()
          .describe("Instead of a spot: this many lines down (negative: up) from your cursor, to the end of that line."),
      })
      .superRefine((m, ctx) => {
        const problem = moveProblem(m)
        if (problem) ctx.addIssue({ code: "custom", message: problem })
      })
      .describe(
        "Move your cursor to one of: the spot between `before` and `after`, two texts that occur together (`before: \"import { \", after: \"type Context\"` lands right before `type Context`); `to`; or `lines`. With only `file`, the start of that file.",
      ),
  }),
  action({
    select: z
      .union([Anchor, Range])
      .describe(
        "Select an anchor's match, or from the start of `from` to the end of the first `to` after it, so the programmer sees what's about to change.",
      ),
  }),
  action({
    type: typeText.describe(
      "`[before, after]`: types `before`, then `after`, at a human pace, then steps your cursor back to between them, ready for what goes inside. Replaces the selection if there is one. Inserted literally: include newlines and indentation yourself; nothing is auto-closed. The default for anything the programmer should read. Every pair is typed with both its ends first, then filled from inside: `[\"update(\", \")\"]` then `[\"ctx, dt\", \"\"]`; `[\"for (\", \") {\\n}\"]` then the condition, then `move: { to: \"end\" }` and the body; `[\"'\", \"'\"]` then the string's text; `[\"[\", \"]\"]`; `[\"/* \", \" */\"]`. That goes for every block, object, array, index, call, parameter list, header, string, tag and block comment, however short, in boilerplate and config too. Fill a pair right after typing it, before anything else. `after` is `\"\"` only when the text opens nothing that needs closing. Make room before you write: at the end of a line, `[\"\\n\\n\", \"\\n\"]` opens an empty line between blank ones, with the cursor on it. Never type in front of existing text on the same line.",
    ),
  }),
  action({
    type_fast: typeText.describe(
      "Like `type`, several times faster, for text the programmer doesn't need to read: imports, config, boilerplate. Only the speed changes: every pair is still typed with both its ends first, then filled.",
    ),
  }),
  action({ delete: z.literal(true).describe("Delete the current selection; `select` first.") }),
  action({
    point: z
      .union([Anchor.extend({ file: file.optional() }), Range.extend({ file: file.optional() })])
      .describe(
        "Highlight code without editing it or moving your cursor, to talk about it: point first, then `say` what's there. The programmer's view goes to the pointed code, and comes back to your cursor with your next move or edit.",
      ),
  }),
  action({
    run: z
      .string()
      .describe(
        "Run a shell command in a terminal the programmer sees: tests, builds, starting the app. They may be asked to allow it. The exit code, the output and the terminal's shell come back in the batch's report; a nonzero exit fails the batch. Make it the last action of its batch.",
      ),
    wait: z.number().optional().describe("Seconds to wait (default 120). For a server, a few: it keeps running."),
  }),
], { error: actionError })

/** An action's object: no unknown fields, and a clear message when two actions were put in one. */
function action<T extends z.ZodRawShape>(shape: T) {
  return z.strictObject(shape, { error: (issue) => (issue.code === "unrecognized_keys" ? combined(issue.input) : undefined) })
}

/** Says what's wrong with an action that matches no variant, instead of zod's bare "Invalid input". */
function actionError(issue: { input?: unknown }): string | undefined {
  const input = issue.input
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined
  if (actionKinds(input).length === 0) return `Not an action: each action has one of ${ACTION_KINDS.map((k) => `\`${k}\``).join(", ")}`
  return combined(input)
}

function combined(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined
  const kinds = actionKinds(input)
  if (kinds.length < 2) return undefined
  return `One action per object, got ${kinds.map((k) => `\`${k}\``).join(" and ")}: make them separate actions, in order`
}

export const TOOLS = {
  start: {
    description:
      "Start a live pair programming session in the programmer's editor. Call this when the programmer asks to pair. The result includes the pairing guide: read it and follow it for the whole session. From then on, everything you do through `step` appears in their editor at a human pace, with your narration.",
    inputSchema: {
      task: z.string().optional().describe("A short description of what you'll work on, shown to the programmer."),
    },
  },
  step: {
    description: `Submit a batch of visible actions, played in the programmer's editor at a human pace. A batch is one idea: usually a \`say\` explaining what's next, then the few edits it describes. A batch works in one file: name it (in \`move\` or \`point\`) before its first edit, and start a new batch to switch files.

Pipelined: the call queues the batch and returns once the PREVIOUS batch has finished playing, with that batch's report. So plan the next batch while this one plays. The first call returns immediately.

Read every report. It shows each finished batch's code as it now reads, with your cursor marked \`▌\`: check it's what you meant. If a batch was interrupted or failed, or the programmer said or did something, your later batches were discarded; what didn't play is listed, ready to resubmit, starting with what's left of an interrupted action. Take what happened into account and re-plan.

An empty batch waits for your queued batches without waiting for the programmer.`,
    inputSchema: {
      actions: z.array(Action).describe("Played in order."),
    },
  },
  listen: {
    description:
      "Wait for the programmer. First collects the reports of your queued batches, then returns when the programmer does something: a message (with the code they had selected, if any), an edit, a turn change, or ending the session. Call it whenever you're done or waiting: during a session, never end your turn. During the programmer's turn you're the navigator (only `say` and `point` work), and `listen` also returns shortly after they stop typing, so you can comment. If nothing happened in time, it says so: call it again.",
    inputSchema: {},
  },
  end: {
    description:
      "End the session, when the programmer says they're done. Anything still queued plays out first. Afterwards the pair tools are unavailable until the next `start`; continue the conversation normally.",
    inputSchema: {
      summary: z.string().optional().describe("One or two sentences, shown to the programmer as the closing message."),
    },
  },
  read: {
    description:
      "Read a file as it is in the programmer's editor, including unsaved changes and everything you've typed so far. Prefer this over your own file tools for files the programmer may have touched during the session. Lines are numbered from 1.",
    inputSchema: {
      file,
      from_line: z.number().int().optional(),
      to_line: z.number().int().optional(),
    },
  },
} as const
