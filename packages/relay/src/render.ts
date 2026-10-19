// What the agent reads: reports and files as text, with code as numbered lines instead of JSON
// strings full of escapes. See "Reports" in PROTOCOL.md.

import type {
  AuthorEvent,
  AuthorReport,
  AuthorTool,
  BatchError,
  BatchResult,
  Code,
  Event,
  Excerpt,
  FileContent,
  Report,
  RunResult,
  SetAside,
  StageFile,
  StageView,
} from "@ai-pair/protocol"

export type ReportingTool = "join" | "step" | "listen" | "end"

const MODE: Record<"build" | "learn", string> = {
  build: "The programmer picked Build mode for this session. Its short page follows the guide below.",
  learn: "The programmer picked Learn mode for this session: they're here to learn this. Its page follows the guide below, and where the two differ, the mode page wins.",
}

export function renderReport(report: Report, tool: ReportingTool): string {
  const sections: string[] = []
  if (tool === "join") sections.push("You joined the session as its presenter.")
  if (report.voice === "on") {
    sections.push("Your voice is on: the programmer hears each `say`. Write it to be spoken: plain words, no markdown or backticks, code said the way a programmer says it out loud.")
  } else if (report.voice === "off") {
    sections.push("Your voice is off: the programmer reads each `say` beside the code while it plays. Keep it short; `backticks` for names.")
  }
  if (report.mode) sections.push(MODE[report.mode])
  for (const e of report.events) sections.push(renderEvent(e))
  for (const b of report.batches) sections.push(renderBatch(b))
  for (const text of report.author ?? []) sections.push(`The author says:\n${quote(text)}`)
  for (const brief of report.briefs ?? []) {
    const notes = brief.notes.trim() ? `, with the author's notes:\n${quote(brief.notes)}` : ", with no notes."
    sections.push(`Stage ${brief.number} began: ${brief.title}${notes}`)
  }
  if (report.stage) sections.push(renderStage(report.stage))
  if (report.submitted) sections.push(`Batch ${report.submitted.id} is ${report.submitted.status}.`)
  if (report.stillMs !== undefined) {
    sections.push(
      `The editor sat still for ${Math.round(report.stillMs / 1000)} seconds before it came: the programmer watched nothing happen. Keep something playing. Put more into each batch, about 10 to 30 seconds of playback, and send the next as soon as a \`step\` returns. Before you read or think at length, queue a \`say\` saying what you're doing.`,
    )
  }
  if (report.rejected) sections.push(renderRejected(report.rejected))
  if (report.cursor) sections.push(`Your cursor, in ${report.cursor.file}:\n${renderCode(report.cursor)}`)
  if (report.confirming) {
    sections.push(
      `Batch ${report.confirming.id} is waiting for the programmer to allow \`${report.confirming.command}\`: nothing after it plays until they answer. Don't repeat the command; wait with \`listen\`. It comes back about every 45 seconds while they haven't answered, with this same line: just call it again.`,
    )
  } else if (report.paused) {
    sections.push("Playback is paused in the editor: what you send is held and nothing plays until the programmer resumes. Wait with `listen`; it comes back when they resume.")
  } else if (report.waiting) {
    sections.push(tool === "listen" ? "Nothing has happened yet. Call `listen` again." : "Nothing has finished yet. Carry on as usual.")
  }
  const ended = report.events.some((e) => e.kind === "end")
  if (tool === "end" && !ended) sections.push("The session has ended.")
  else if (report.turn === "user" && !ended) {
    sections.push("It's the programmer's turn: you're the navigator. Beats may only talk and `point`, and `listen` follows along.")
  }
  return sections.length > 0 ? sections.join("\n\n") : "Nothing to report."
}

export function renderAuthorReport(report: AuthorReport, tool: AuthorTool): string {
  const sections: string[] = []
  if (report.copy) {
    sections.push(
      `The session has started. Your private copy of the working directory is ${report.copy}: do all your work there, with your usual tools. The programmer's files change only as the presenter plays your stages.`,
    )
  }
  if (report.mode) sections.push(MODE[report.mode])
  if (report.recorded !== undefined) sections.push(`Recorded stage ${report.recorded}.`)
  for (const e of report.events) sections.push(renderAuthorEvent(e))
  const ended = report.events.some((e) => e.kind === "end")
  if (report.ended && !ended) sections.push("The session has ended. Stop using the pair tools.")
  if (report.ended || ended) return sections.join("\n\n")
  if (report.stages === 0) sections.push("No stage recorded yet.")
  else if (report.playing === 0) sections.push(`You've recorded ${report.stages} stages; none has begun playing yet.`)
  else sections.push(`The editor is playing stage ${report.playing} of the ${report.stages} you've recorded.`)
  if (tool === "wait" && report.events.length === 0) sections.push("Nothing new yet. Go on with your next stage, or call `wait` again.")
  return sections.join("\n\n")
}

function renderAuthorEvent(e: AuthorEvent): string {
  switch (e.kind) {
    case "edit": {
      const who = e.by === "programmer" ? "The programmer edited" : "The presenter edited, beyond your stage,"
      const carried = e.carried
        ? "It's carried into your copy: build on it, never revert it."
        : "It collides with your own changes there, so it isn't in your copy: work it in by hand."
      return `${who} ${e.file}. ${carried}\n${e.diff}`
    }
    case "told":
      return `The presenter says:\n${quote(e.text)}`
    case "set_aside":
      return renderSetAside(e, "author")
    case "caught_up":
      return e.last
        ? `Playback has caught up: stage ${e.stage}, your last, is all in, and the presenter is wrapping up with the programmer. Record another stage only if there's more to do.`
        : `Playback has caught up: stage ${e.stage} is all in, and the programmer is waiting for your next stage. Record it soon; a small one is fine.`
    case "presenter":
      return e.present
        ? "The presenter joined: it's playing your stages."
        : "The presenter left: its connection closed. Get a new one going, as the guide says, or `join` and present the rest yourself."
    case "end":
      return `The session ended${e.summary ? `:\n${quote(e.summary)}` : "."}\nStop using the pair tools, and give the programmer a short summary in the conversation.`
  }
}

/** The stage being played, and what's left of it. */
function renderStage(view: StageView): string {
  const head = `Stage ${view.number} of ${view.of}${view.last ? ", the last" : " so far"}: ${view.title}.`
  const asides = (view.set_aside ?? []).map((a) => renderSetAside(a, "presenter"))
  if (view.left.length === 0) {
    const next = view.last
      ? "It's the author's last stage: once it has played, wrap up with the programmer."
      : "The next one begins once the author records it: `listen` returns when it does."
    return [`${head} All of it is in once your queued batches play. ${next}`, ...asides].join("\n\n")
  }
  const legend = "What's left of it, as your queued batches leave the code: `+` lines to write, `-` lines to take out, with the lines around them as they read."
  return [`${head} ${legend}`, ...view.left.map(renderStageFile), ...asides].join("\n\n")
}

/** A file's lines still to write or take out; a gap in the numbers of the lines around them is `…`. */
function renderStageFile(f: StageFile): string {
  const width = String(Math.max(0, ...f.lines.map((l) => l.number ?? 0))).length
  const out = [`${f.file}:`]
  let previous: number | undefined
  for (const line of f.lines) {
    if (line.number !== undefined) {
      if (previous !== undefined && line.number > previous + 1) out.push(`${" ".repeat(width)}    …`)
      previous = line.number
    }
    const mark = line.change === "write" ? "+" : line.change === "remove" ? "-" : " "
    const number = line.number === undefined ? " ".repeat(width) : String(line.number).padStart(width)
    out.push(`${number} ${mark} ${line.text}`.trimEnd())
  }
  if (f.more) out.push(`(${f.more} more ${f.more === 1 ? "line" : "lines"} to write or take out after these)`)
  if (f.delete) out.push("(then the file is deleted)")
  return out.join("\n")
}

function renderSetAside(a: SetAside, to: "author" | "presenter"): string {
  const versions = `The stage had:\n${fenced(a.plan)}\nThe programmer's, kept:\n${fenced(a.kept)}`
  if (to === "presenter") {
    return `In ${a.file}, the programmer had already changed code stage ${a.stage} changes: their version stays, and the stage's lines there are dropped. ${versions}\nThe author was told. Mention it to the programmer if it matters.`
  }
  return `In ${a.file}, the programmer had already changed code your stage ${a.stage} changes: their version stays in the editor, and yours there was set aside. ${versions}\nBuild on theirs. If yours mattered, bring it back in a later stage, with notes on why.`
}

export function renderFile(content: FileContent): string {
  const header = content.dirty ? `${content.file} (with unsaved changes in the editor):` : `${content.file}:`
  if (content.lines.length === 0 && !content.end) return `${header} no lines in this range.`
  return `${header}\n${renderLines(content.lines, endNote(content.end))}`
}

function renderEvent(e: Event): string {
  switch (e.kind) {
    case "message":
      return `The programmer said:\n${quote(e.text)}${e.selection ? `\n${renderExcerpt(e.selection)}` : ""}`
    case "edit":
      if (e.by === "other") return `${e.file} was changed, not by the programmer but by a tool, a formatter, or on disk:\n${e.diff}`
      return `The programmer edited ${e.file}:\n${e.diff}`
    case "interrupt":
      return "The programmer pressed Interrupt: stop what you were doing, and don't send it again. Say briefly where you stopped, then `listen` for what they want."
    case "turn":
      if (e.to === "user") return "The programmer took the turn."
      return `The programmer handed the turn back to you${e.message ? `:\n${quote(e.message)}` : "."}${e.selection ? `\n${renderExcerpt(e.selection)}` : ""}`
    case "end":
      return "The programmer ended the session. This is the final report: stop using the pair tools."
  }
}

function renderBatch(b: BatchResult): string {
  const parts = [b.code ? `Batch ${b.id} ${b.status}, in ${b.code.file}:` : `Batch ${b.id} ${b.status}.`]
  if (b.code) parts.push(renderCode(b.code))
  for (const run of b.runs ?? []) parts.push(renderRun(run))
  for (const u of b.unsaved ?? []) {
    parts.push(
      `Couldn't save ${u.file} (${u.error}): the editor has your edits, the file on disk doesn't, so commands and your file tools see the old file. Ask the programmer to resolve it in the editor, which offers to compare or overwrite.`,
    )
  }
  if (b.error) parts.push(renderError(b.error))
  if (b.unplayed) {
    // Agents working ahead come to think of what they queued as done, and answer questions about
    // code that was never typed. Say outright that none of it happened. history.ts reads these
    // lines back, one beat as JSON on each, to cut the `step` call down to what played.
    const label = b.error && b.error.kind !== "command_failed" ? "Not played, starting with the beat that failed" : "Not played"
    const never = "never typed or said: it isn't in the file, and the programmer hasn't seen or heard it"
    parts.push([`${label} (${never}):`, ...b.unplayed.map((beat) => `  ${JSON.stringify(beat)}`)].join("\n"))
  }
  return parts.join("\n")
}

function renderRejected(r: NonNullable<Report["rejected"]>): string {
  const parts = [
    `Your batch was rejected: action ${r.action} of beat ${r.beat} would fail:`,
    `  ${JSON.stringify(r.value)}`,
    renderError(r.error),
  ]
  if (r.code) parts.push(`The code would read then, in ${r.code.file}:\n${renderCode(r.code)}`)
  parts.push("Nothing of it was queued. Fix it and submit the whole batch again.")
  return parts.join("\n")
}

function renderError(error: BatchError): string {
  const candidates = (error.candidates ?? []).map((c) => `\n  line ${c.line}: ${c.context}`).join("")
  return `${error.kind}: ${error.message}${candidates}`
}

function renderRun(run: RunResult): string {
  const outcome =
    run.exit_code !== undefined ? `exited with ${run.exit_code}` : run.running ? "still running in its terminal" : "exit code unknown"
  const shell = run.shell ? ` in ${run.shell}` : ""
  if (run.output === "") return `Ran \`${run.command}\`${shell}: ${outcome}, no output.`
  return `Ran \`${run.command}\`${shell}: ${outcome}. Output${run.truncated ? ", its end" : ""}:\n${fenced(run.output)}`
}

function renderExcerpt(x: Excerpt): string {
  const lines = x.text.split(/\r?\n/).map((text, i) => ({ number: x.from.line + i, text }))
  const where = x.from.line === x.to.line ? `line ${x.from.line}` : `lines ${x.from.line}–${x.to.line}`
  const cut = x.truncated ? "\n(cut off here; `read` the rest)" : ""
  return `About the code they had selected, ${x.file} ${where}:\n${renderLines(lines)}${cut}`
}

/** A report's code, and where it reaches the end of the file, whether the file ends with a newline. */
function renderCode(code: Code): string {
  return renderLines(code.lines, endNote(code.end))
}

function endNote(end: Code["end"]): string | undefined {
  if (!end) return undefined
  return end.final_newline ? "(end of file)" : "(end of file, with no newline after the last line)"
}

/** Numbered lines; a gap in the numbers is shown as `…`. A `note` goes below them, aligned with the text. */
function renderLines(lines: Code["lines"], note?: string): string {
  const width = String(lines.at(-1)?.number ?? 0).length
  const out: string[] = []
  let previous: number | undefined
  for (const { number, text } of lines) {
    if (previous !== undefined && number > previous + 1) out.push(`${" ".repeat(width)}  …`)
    out.push(`${String(number).padStart(width)}  ${text}`.trimEnd())
    previous = number
  }
  if (note) out.push(`${" ".repeat(width)}  ${note}`)
  return out.join("\n")
}

function quote(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => `> ${line}`.trimEnd())
    .join("\n")
}

/** Text in a code fence longer than any run of backticks in it. */
function fenced(text: string): string {
  const fence = "`".repeat(Math.max(3, longestRun(text, "`") + 1))
  return `${fence}\n${text}\n${fence}`
}

function longestRun(text: string, ch: string): number {
  let longest = 0
  let current = 0
  for (const c of text) {
    current = c === ch ? current + 1 : 0
    longest = Math.max(longest, current)
  }
  return longest
}
