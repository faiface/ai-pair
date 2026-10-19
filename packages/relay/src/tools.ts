// The MCP tool definitions: schemas and the descriptions the agent reads at the point of use.

import { z } from "zod"
import {
  ACTION_KINDS,
  actionKinds,
  moveProblem,
  planProblem,
  spanProblem,
  typeProblem,
  type MoveTarget,
  type SpanTarget,
} from "@ai-pair/protocol"

const file = z.string().describe("Path relative to your working directory, or absolute.")
const line = z
  .number()
  .int()
  .optional()
  .describe(
    "The line exactly as an up-to-date `read` or report shows it: the one your cursor lands on, or the code starts on. Never count lines or guess: if you haven't seen the line's number since your batches last changed the lines above it, `read` first. A number you haven't been shown for that line is rejected. Omit it for your cursor's line.",
  )
const inFile = file
  .optional()
  .describe("Switch to this file, only before your batch's first edit. Omit it to stay in your cursor's file.")

/** A `select`'s or `point`'s code: its text on a line, or a range. */
const Span = z
  .strictObject(
    {
      file: inFile,
      line,
      text: z.string().optional().describe("The code's exact text, starting on `line`; it may go on past it. Enough of it to be unique on its line."),
      from: z.string().optional().describe("Instead of `text`, for a range: the exact text it starts with, on `line`."),
      through: z.string().optional().describe("With `from`: the range ends with the first match of this text after `from`."),
    },
    { error: (issue) => (issue.code === "unrecognized_keys" ? spanProblem(issue.input as SpanTarget) : undefined) },
  )
  .superRefine((span, ctx) => {
    const problem = spanProblem(span)
    if (problem) ctx.addIssue({ code: "custom", message: problem })
  })

/** The text to type, with ▌ where the cursor ends. */
const typeText = z.string({ error: (issue) => typeProblem(issue.input) }).superRefine((text, ctx) => {
  const problem = typeProblem(text)
  if (problem) ctx.addIssue({ code: "custom", message: problem })
})

/** The lines of the current stage a `write` or `drop` takes, by their text. */
const planTarget = {
  file: file
    .optional()
    .describe("The stage's file. Omit it for your cursor's file if the stage has lines left there, or else the first file that has."),
  from: z
    .string()
    .optional()
    .describe("Text of the first line to take: the first line left that contains it. Omit it for the first line left in the file."),
  through: z
    .string()
    .optional()
    .describe("Text of the last line to take: the first line from `from` on that contains it, and any blank lines that end its stretch right after it. Omit it for the rest of the stretch, up to the next line the file keeps."),
}

const Action = z.union([
  action({
    move: z
      .strictObject({
        file: file.optional().describe("Switch to this file (created empty if it doesn't exist), only before your batch's first edit. Omit it to stay in your cursor's file."),
        line,
        at: z
          .string()
          .optional()
          .describe(
            "A spot: the exact text around it, with ▌ where your cursor goes, e.g. `\"import { ▌type Context\"` for right before `type Context`. May span lines. Enough text to fit only one place on the line.",
          ),
        to: z
          .enum(["line_end"])
          .optional()
          .describe(
            "Instead of a spot: `line_end`, the end of the line. Only that: it steps past a close you typed only if that close is on this line. A block's closing brace, below its body, isn't on your cursor's line.",
          ),
      }, { error: (issue) => (issue.code === "unrecognized_keys" ? moveProblem(issue.input as MoveTarget) : undefined) })
      .superRefine((m, ctx) => {
        const problem = moveProblem(m)
        if (problem) ctx.addIssue({ code: "custom", message: problem })
      })
      .describe(
        "Move your cursor to a spot, `at`: the text around it with ▌ where your cursor goes (`line: 3, at: \"import { ▌type Context\"` lands right before `type Context`), or to the end of the line with `to: \"line_end\"`. On `line`, exactly: a spot that isn't on it is rejected. Without `line`, on your cursor's line: that's how you step past a close you just typed on your line, e.g. `{ to: \"line_end\" }`.",
      ),
  }),
  action({
    select: Span.describe(
      "Select code, so the programmer sees what's about to change: its `text`, starting on `line`, exactly (without `line`, your cursor's line), or a range, `from` a text on it `through` the first match of another after it. Your cursor ends at its end.",
    ),
  }),
  action({
    type: typeText.describe(
      "The text, with ▌ where your cursor ends: all of it is typed at a human pace, then your cursor steps back to the ▌. Replaces the selection if there is one. Inserted literally: include newlines and indentation yourself; nothing is auto-closed. The default for anything the programmer should read. The programmer watches every keystroke, and every second they see an unclosed bracket, parenthesis, quote or block is a second of suffering for them, so close each one the moment you open it, always, however short: `\"f(▌)\"` then `\"x▌\"`, never `\"f(x)▌\"`. Type left to right, except that whatever has a close gets its close first: when the text before ▌ opens a bracket, a quote or a block (however the language spells it: `{`, `begin`, `then`, `do`, a tag, a block comment), what's after ▌ is its close and nothing more. Fill it, step past its close (a `move` to the end of its line, or to a spot right after it; `to: \"line_end\"` is only the end of your cursor's line, so it doesn't step past a block's close on the line below), and type what follows there: `\"if (▌)\"`, `\"x < 0▌\"`, `to: \"line_end\"`, `\" {\\n    ▌\\n  }\"`, then the body; `\"(▌)\"`, `\"x + y▌\"`, `to: \"line_end\"`, `\" * SCALE;▌\"`. Nothing follows ▌ when the text opens nothing. Start new lines at the end of the line above, never where code follows on the line: it would slide right as you type. Separate definitions with one blank line, `\"\\n\\n…\"` at the end of the one above, and leave one newline at the end of the file.",
    ),
  }),
  action({
    type_fast: typeText.describe(
      "Like `type`, several times faster, for text the programmer doesn't need to read: imports, config, boilerplate. Only the speed changes: closes still come first.",
    ),
  }),
  action({ delete: z.literal(true).describe("Delete the current selection; `select` first.") }),
  action({
    point: Span.describe(
      "Highlight code without editing it or moving your cursor, to talk about it: give it with the `say` about it, in one beat. The code is given as for `select`. The programmer's view goes to the pointed code, and comes back to your cursor with your next move or edit.",
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
  action({
    write: z
      .strictObject({
        ...planTarget,
        fast: z.boolean().optional().describe("Several times faster, as `type_fast`: for imports, config, boilerplate."),
      })
      .superRefine((target, ctx) => {
        const problem = planProblem(target, false)
        if (problem) ctx.addIssue({ code: "custom", message: problem })
      })
      .describe(
        "Write lines of the current stage into their file, where the stage has them, at a human pace: a line the stage changes is edited where it differs, lines it takes out are selected and deleted, and lines it adds are typed, top to bottom. `{}` writes the next stretch left; `from` and `through` pick the lines this beat's words are about. What a `write` doesn't finish stays left, in the report's `stage`.",
      ),
  }),
  action({
    drop: z
      .strictObject(planTarget)
      .superRefine((target, ctx) => {
        const problem = planProblem(target, true)
        if (problem) ctx.addIssue({ code: "custom", message: problem })
      })
      .describe(
        "Take lines out of the current stage without touching the file: lines to add won't be written, lines to take out stay. For what the programmer doesn't want, or already wrote their own way. Takes no time.",
      ),
  }),
], { error: actionError })

const Beat = z
  .strictObject({
    say: z
      .string()
      .optional()
      .describe(
        "What you say to the programmer about this beat's actions: what you're doing, why, and how your code does it. It's about your code and your choices, not how the language or its libraries work (unless the programmer asked to learn them). Explain the code, don't recite it. First person, contractions, one to three sentences, the way you'd talk at their desk. Write it for how it reaches them, which your reports tell you as `voice`. Voice on, it's spoken: write it for the ear, in plain words with no markdown or backticks, and say code the way a programmer says it out loud (\"dunder add\", \"req dot body\", \"the todos array\", \"a for loop over the lines\"). Voice off, it's read beside the code while it plays: keep it short, and put names in `backticks`.",
      ),
    do: z
      .array(Action)
      .optional()
      .describe("The actions the `say` is about, played in order while it's said. Omit it to only talk; omit `say` for quiet work no one needs told about."),
  }, { error: (issue) => (issue.code === "unrecognized_keys" ? beatError(issue.input) : undefined) })
  .refine((beat) => beat.say !== undefined || (beat.do?.length ?? 0) > 0, "A beat needs a `say`, actions in `do`, or both.")

/** Says how to fix a beat with fields of its own it shouldn't have: usually actions put on the beat itself. */
function beatError(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined
  const kinds = actionKinds(input)
  if (kinds.length === 0) return "A beat has only `say` and `do`."
  return `A beat is \`{ say, do }\`: put ${kinds.map((k) => `\`${k}\``).join(" and ")} in its \`do\` list, like \`{ "say": "…", "do": [{ "${kinds[0]}": … }] }\``
}

/** An action's object: no unknown fields, and a clear message when two actions were put in one. */
function action<T extends z.ZodRawShape>(shape: T) {
  return z.strictObject(shape, { error: (issue) => (issue.code === "unrecognized_keys" ? combined(issue.input) : undefined) })
}

/** Says what's wrong with an action that matches no variant, instead of zod's bare "Invalid input". */
function actionError(issue: { input?: unknown }): string | undefined {
  const input = issue.input
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined
  const kinds = actionKinds(input)
  if ("say" in input) return "`say` goes on the beat, next to `do`, not among its actions: `{ \"say\": \"…\", \"do\": [ … ] }`"
  if (kinds.length === 0) return `Not an action: each action has one of ${ACTION_KINDS.map((k) => `\`${k}\``).join(", ")}`
  if (kinds.length > 1) return combined(input)
  // A malformed field fails on its type, before the action's own check gets to say what's wrong.
  const move: unknown = "move" in input ? input.move : undefined
  if (typeof move === "object" && move !== null) return moveProblem(move as MoveTarget)
  const span: unknown = "select" in input ? input.select : "point" in input ? input.point : undefined
  if (typeof span === "object" && span !== null) return spanProblem(span as SpanTarget)
  if ("type" in input) return typeProblem(input.type)
  if ("type_fast" in input) return typeProblem(input.type_fast)
  if ("write" in input) return planProblem(input.write, false)
  if ("drop" in input) return planProblem(input.drop, true)
  return undefined
}

function combined(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined
  const kinds = actionKinds(input)
  if (kinds.length < 2) return undefined
  return `One action per object, got ${kinds.map((k) => `\`${k}\``).join(" and ")}: make them separate actions, in order`
}

const cwd = z
  .string()
  .optional()
  .describe("Your working directory, as an absolute path. The paths you give and get during the session are relative to it.")

export const TOOLS = {
  start: {
    description:
      "Start a live pair programming session in the programmer's editor, as its author. Call this as soon as the programmer asks to pair, before reading their code: they're waiting from that moment. You get a private copy of the working directory: do the work there, at your own pace and with your usual tools, and record it in stages with `stage`. A presenter plays each stage in the programmer's editor at a human pace, explaining it as it goes. The result includes the author guide and the mode's page: read them and follow them for the whole session. The first thing it asks of you is to get the presenter going, at once.",
    inputSchema: {
      task: z.string().optional().describe("A short description of what you'll work on, shown to the programmer."),
      cwd,
    },
  },
  stage: {
    description:
      "Record a stage: everything your copy changed since the last stage, as it is now, with notes for the presenter. A stage is one step a programmer could follow and run: it builds on the code as the last one left it, and works on its own. The presenter plays the stages in order; the result says which one plays now. Afterwards keep working on the next one: don't wait for playback.",
    inputSchema: {
      title: z.string().describe("A few words, shown to the programmer where the stage starts."),
      notes: z
        .string()
        .describe(
          "For the presenter, who explains the stage to the programmer from them: what the stage does and why, the decisions in it and what you weighed, how its code works where that isn't plain, the order to show its parts in, and what to run to see it work.",
        ),
      last: z.boolean().optional().describe("This is the last stage: the task is done once it has played."),
    },
  },
  wait: {
    description:
      "For the author only; the presenter waits with `listen`. Wait for news: edits in the programmer's editor (carried into your copy), what the presenter tells you, code of yours the programmer's own edits overrode, playback catching up with your stages, or the session ending. Call it when you have nothing to work on: during a session, never end your turn. If nothing happened in time, it says so: call it again.",
    inputSchema: {},
  },
  tell_presenter: {
    description:
      "Tell the presenter something it should know before your next stage: a change of plan, an answer for the programmer, what to say while the programmer waits. It hears it in its next report.",
    inputSchema: {
      text: z.string(),
    },
  },
  join: {
    description:
      "Join the pairing session the author started in the programmer's editor, as its presenter: you play the author's stages there, at a human pace, explaining them as you go, and you answer the programmer. Call it once, when you were asked to present. The result includes the presenter guide and the mode's page: read them and follow them until the session ends.",
    inputSchema: { cwd },
  },
  tell_author: {
    description:
      "Tell the author something: what the programmer asked for that takes real work, a question only the author can answer, or a problem with a stage. The author works out of sight and hears only this and the programmer's edits, not what the programmer says to you.",
    inputSchema: {
      text: z.string(),
    },
  },
  step: {
    description: `Submit a batch of beats, played in the programmer's editor at a human pace. A beat is what you say and the actions it's about, played together: the words start as the actions start, and the next beat starts once both are done. Talk only where there's something worth saying: several actions can share one \`say\`, and a beat of quiet work (closing a line, an import) needs none. To talk about code without touching it, \`point\` at it in the beat that says what's there. \`write\` puts in the lines of the author's current stage, which the report's \`stage\` shows.

A batch is one idea, a few beats long: usually a beat explaining what's next with its first edits, then the rest, playing for about 10 to 30 seconds. One that plays for only a few seconds, like a single short line, is over before you've written the next, and the programmer watches a still editor meanwhile. A batch works in one file: name it (in \`move\`, \`select\` or \`point\`) before its first edit, and start a new batch to switch files. Write each batch yourself, by hand: never generate batches from code you wrote out first, with a script.

Work ahead: the call queues the batch and returns at once unless a couple of batches already wait to play; then it returns as one starts. Its report holds whatever finished meanwhile. So write the next batch right away, and the next: the programmer watches one batch while you write the following ones, and never waits for you to think. Don't send an empty batch to look at a report before going on: your queued batches were checked when you sent them, and \`read\` shows the code as they'll leave it. Wait only when the next batch truly depends on what played, like a \`run\`'s output.

A batch that would fail, e.g. on text that isn't on its line, is rejected at once: nothing of it is queued, and the report says which beat and action, and why. Fix it and submit the whole batch again.

Read every report. It shows each finished batch's code as it now reads, with your cursor marked \`▌\`: check it's what you meant. If a batch was interrupted or failed, or the programmer said or did something, your later batches were discarded; what didn't play is listed as beats, ready to resubmit, starting with what's left of an interrupted beat (its words were already heard). Take what happened into account and re-plan.

When news comes, the programmer waits on you: a \`run\`'s output, a failure, or something they said or did. Answer it fast: first send a batch of one short \`say\` reacting to it, like "Just what we put in." or "Good catch.", before you work out what follows, then write the next batch while it plays. Keep that next batch small, a beat or two, so it comes soon; then go back to full batches. A \`run\`'s output is on their screen, so they don't need it read out: say what you make of it, in your own words. With the voice on, if you're slow, the editor says a short "One moment." while you think. Don't say it again; go on from it.

An empty batch waits until your queued batches finish, or a \`run\`'s output or a failure comes back, without waiting for the programmer: use it before acting on a \`run\`'s output.`,
    inputSchema: {
      beats: z.array(Beat).describe("Played in order."),
    },
  },
  listen: {
    description:
      "For the presenter only; the author waits with `wait`. Wait for the programmer. First collects the reports of your queued batches, then returns when the programmer does something: a message (with the code they had selected, if any), an edit of theirs, a turn change, or ending the session; or when a new stage begins, or the author tells you something. Call it whenever you're done or waiting: during a session, never end your turn. During the programmer's turn you're the navigator (beats may only talk and `point`), and `listen` also returns shortly after they stop typing, so you can comment. If nothing happened in time, it says so: call it again.",
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
      "Read a file as it is in the programmer's editor, including unsaved changes, and as your batches will leave it: what they'll type is already in it, even while they're still playing or queued, so its line numbers are the ones your next batch starts from. Read the part of a file you're about to work in before you move there, and copy line numbers and text from it: don't guess them. Prefer this over your own file tools during the session. Lines are numbered from 1; it says where the file ends, and whether a newline ends its last line.",
    inputSchema: {
      file,
      from_line: z.number().int().optional(),
      to_line: z.number().int().optional(),
    },
  },
} as const
