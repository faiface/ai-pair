// The MCP tool definitions: schemas and the descriptions the agent reads at the point of use.

import { z } from "zod"
import { ACTION_KINDS, actionKinds } from "@ai-pair/protocol"

const anchor = {
  text: z.string().describe("Exact text to find; may span lines. Keep it short, but unique."),
  near_line: z
    .number()
    .int()
    .optional()
    .describe("If the text occurs more than once, take the match closest to this line."),
  direction: z
    .enum(["forward", "backward"])
    .optional()
    .describe("If the text occurs more than once, take the nearest match after/before your cursor."),
}
const Anchor = z.strictObject(anchor)
const Range = z.strictObject({ from: Anchor, to: Anchor })
const file = z.string().describe("Path relative to your working directory, or absolute.")

const Action = z.union([
  z.strictObject({
    say: z
      .string()
      .describe(
        "Narrate right before the actions it describes: what you're doing, why, and how your code does it. It's about your code and your choices, not how the language or its libraries work (unless the programmer asked to learn them). Explain the code, don't recite it. One to three sentences; `backticks` render as code. Playback pauses so the programmer can read it.",
      ),
  }),
  z.strictObject({
    move: z
      .strictObject({
        file: file.optional().describe("Switch to this file (created empty if it doesn't exist). Omit to stay in the current file."),
        ...anchor,
        text: anchor.text.optional(),
        at: z.enum(["start", "end"]).optional().describe("Put the cursor at the start or end (default) of the match."),
        position: z.enum(["file_start", "file_end"]).optional().describe("Instead of `text`."),
        lines: z
          .number()
          .int()
          .optional()
          .describe("Instead of `text`: this many lines down (negative: up) from your cursor, to the end of that line. Like arrow keys."),
      })
      .describe("Move your cursor, to the end of an anchor's match (\"after this text\") or to a position."),
  }),
  z.strictObject({
    select: z
      .union([Anchor, Range])
      .describe("Select an anchor's match, or everything from `from` to `to`, so the programmer sees what's about to change."),
  }),
  z.strictObject({
    type: z
      .string()
      .describe(
        "Type at your cursor at a human pace, replacing the selection if there is one. Inserted literally: include newlines and indentation yourself; nothing is auto-closed. The default for anything the programmer should read. Type like a human: never in front of existing text on the same line; make the room a block needs first (the empty lines around it, then step into the gap with `move: { lines: -1 }`); and close every pair before writing what goes inside it. Your typing plays slowly on the programmer's screen, and every moment they see an unclosed bracket is a moment of suffering for them: anything with a beginning and an end (a block, but just as much an object literal, a record, an array, a tag, the parentheses of a call or of a parameter list, the header of a `for`, `while` or `if`, a string literal, the square brackets of an array, an index or a type, a block comment) is typed as its opening and closing first, then step inside and type the contents: `todos.push()` then `todo`; `for () {\\n}` then the condition, then the body; `''` then the text between the quotes; `[]` then `1, 2, 3`, and `xs[]` then `i`; `/*  */` or `/**\\n */` then the comment's text. Only a line comment (`//`, `#`) has no end and is typed left to right. Even for a one-line object, a single-element array or a single-argument call. And fill a pair the moment it's closed, before anything else: never type on past an empty pair and come back to it later; step past its closing delimiter only once it's full. Never type a block, a value, a call or a header left to right with its closing delimiter last.",
      ),
  }),
  z.strictObject({
    type_fast: z
      .string()
      .describe(
        "Like `type`, several times faster. Only for text the programmer doesn't need to read: imports, config, boilerplate. It changes the speed, never the order: every rule of `type` still applies, so every block, object, array, index, tag, call, header, string and block comment is closed before its contents, even in boilerplate, config and markup. Never type a file top to bottom with its closing delimiters last.",
      ),
  }),
  z.strictObject({ delete: z.literal(true).describe("Delete the current selection; `select` first.") }),
  z.strictObject({
    point: z
      .union([Anchor.extend({ file: file.optional() }), Range.extend({ file: file.optional() })])
      .describe("Highlight code without editing it or moving your cursor, to talk about it. Put the `say` after it."),
  }),
  z.strictObject({
    run: z
      .string()
      .describe(
        "Run a shell command in a terminal the programmer sees: tests, builds, starting the app. They may be asked to allow it. Output, exit code and the terminal's `shell` come back in the batch's `runs`; a nonzero exit fails the batch. Make it the last action of its batch.",
      ),
    wait: z.number().optional().describe("Seconds to wait (default 120). For a server, a few: it keeps running."),
  }),
], { error: actionError })

/** Says what's wrong with an action that matches no variant, instead of zod's bare "Invalid input". */
function actionError(issue: { input?: unknown }): string | undefined {
  const input = issue.input
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined
  const kinds = actionKinds(input)
  if (kinds.length > 1) {
    return `One action per object, got ${kinds.map((k) => `\`${k}\``).join(" and ")}: make them separate actions, in order`
  }
  if (kinds.length === 0) return `Not an action: each action has one of ${ACTION_KINDS.map((k) => `\`${k}\``).join(", ")}`
  return undefined
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
    description: `Submit a batch of visible actions, played in the programmer's editor at a human pace. A batch is one idea: usually a \`say\` explaining what's next, then the few edits it describes.

Pipelined: the call queues the batch and returns once the PREVIOUS batch has finished playing, with that batch's report. So plan the next batch while this one plays. The first call returns immediately.

Read every report. If a batch was interrupted or failed, or the programmer said or did something (\`events\`), your later batches were discarded; their actions come back in \`unplayed\`. Take what happened into account and re-plan. \`partial.typed\` says exactly what made it into the file. A message with a \`selection\` is about the code the programmer had selected. With \`waiting: true\`, nothing has finished yet: carry on as usual.

An empty batch waits for your queued batches without waiting for the programmer.`,
    inputSchema: {
      actions: z.array(Action).describe("Played in order."),
    },
  },
  listen: {
    description:
      "Wait for the programmer. First collects the reports of your queued batches, then returns when the programmer does something: a message (with a `selection` when they asked about code they had selected), an edit, a turn change, or ending the session. Call it whenever you're done or waiting: during a session, never end your turn. During the programmer's turn you're the navigator (only `say` and `point` work), and `listen` also returns shortly after they stop typing, so you can comment. With `waiting: true`, nothing happened yet: call it again.",
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
