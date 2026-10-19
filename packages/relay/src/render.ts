// What the agent reads: reports and files as text, with code as numbered lines instead of JSON
// strings full of escapes. See "Reports" in PROTOCOL.md.

import type { BatchError, BatchResult, Code, Event, Excerpt, FileContent, Report, RunResult } from "@ai-pair/protocol"

export type ReportingTool = "start" | "step" | "listen" | "end"

export function renderReport(report: Report, tool: ReportingTool): string {
  const sections: string[] = []
  if (tool === "start") sections.push("The session has started.")
  if (report.mode === "build") {
    sections.push("The programmer picked Build mode for this session. Its short page follows the guide below.")
  } else if (report.mode === "learn") {
    sections.push("The programmer picked Learn mode for this session: they're here to learn this. Its page follows the guide below, and where the two differ, the mode page wins.")
  }
  for (const e of report.events) sections.push(renderEvent(e))
  for (const b of report.batches) sections.push(renderBatch(b))
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
  const fence = "`".repeat(Math.max(3, longestRun(run.output, "`") + 1))
  return `Ran \`${run.command}\`${shell}: ${outcome}. Output${run.truncated ? ", its end" : ""}:\n${fence}\n${run.output}\n${fence}`
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

function longestRun(text: string, ch: string): number {
  let longest = 0
  let current = 0
  for (const c of text) {
    current = c === ch ? current + 1 : 0
    longest = Math.max(longest, current)
  }
  return longest
}
