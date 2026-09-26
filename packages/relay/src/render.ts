// What the agent reads: reports and files as text, with code as numbered lines instead of JSON
// strings full of escapes. See "Reports" in PROTOCOL.md.

import type { BatchResult, Code, Event, Excerpt, FileContent, Report, RunResult } from "@ai-pair/protocol"

export type ReportingTool = "start" | "step" | "listen" | "end"

export function renderReport(report: Report, tool: ReportingTool): string {
  const sections: string[] = []
  if (tool === "start") sections.push("The session has started.")
  for (const e of report.events) sections.push(renderEvent(e))
  for (const b of report.batches) sections.push(renderBatch(b))
  if (report.submitted) sections.push(`Batch ${report.submitted.id} is ${report.submitted.status}.`)
  if (report.cursor) sections.push(`Your cursor, in ${report.cursor.file}:\n${renderLines(report.cursor.lines)}`)
  if (report.waiting) {
    sections.push(tool === "listen" ? "Nothing has happened yet. Call `listen` again." : "Nothing has finished yet. Carry on as usual.")
  }
  const ended = report.events.some((e) => e.kind === "end")
  if (tool === "end" && !ended) sections.push("The session has ended.")
  else if (report.turn === "user" && !ended) {
    sections.push("It's the programmer's turn: you're the navigator. Only `say` and `point` work, and `listen` follows along.")
  }
  return sections.length > 0 ? sections.join("\n\n") : "Nothing to report."
}

export function renderFile(content: FileContent): string {
  const header = content.dirty ? `${content.file} (with unsaved changes in the editor):` : `${content.file}:`
  return content.lines.length > 0 ? `${header}\n${renderLines(content.lines)}` : `${header} no lines in this range.`
}

function renderEvent(e: Event): string {
  switch (e.kind) {
    case "message":
      return `The programmer said:\n${quote(e.text)}${e.selection ? `\n${renderExcerpt(e.selection)}` : ""}`
    case "edit":
      return `The programmer edited ${e.file}:\n${e.diff}`
    case "interrupt":
      return "The programmer pressed Interrupt."
    case "turn":
      if (e.to === "user") return "The programmer took the turn."
      return `The programmer handed the turn back to you${e.message ? `:\n${quote(e.message)}` : "."}${e.selection ? `\n${renderExcerpt(e.selection)}` : ""}`
    case "end":
      return "The programmer ended the session. This is the final report: stop using the pair tools."
  }
}

function renderBatch(b: BatchResult): string {
  const parts = [b.code ? `Batch ${b.id} ${b.status}, in ${b.code.file}:` : `Batch ${b.id} ${b.status}.`]
  if (b.code) parts.push(renderLines(b.code.lines))
  for (const run of b.runs ?? []) parts.push(renderRun(run))
  if (b.error) {
    const candidates = (b.error.candidates ?? []).map((c) => `\n  line ${c.line}: ${c.context}`).join("")
    parts.push(`${b.error.kind}: ${b.error.message}${candidates}`)
  }
  if (b.unplayed) {
    const label = b.error && b.error.kind !== "command_failed" ? "Not played, starting with the one that failed:" : "Not played:"
    parts.push([label, ...b.unplayed.map((a) => `  ${JSON.stringify(a)}`)].join("\n"))
  }
  return parts.join("\n")
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

/** Numbered lines; a gap in the numbers is shown as `…`. */
function renderLines(lines: Code["lines"]): string {
  const width = String(lines.at(-1)?.number ?? 0).length
  const out: string[] = []
  let previous: number | undefined
  for (const { number, text } of lines) {
    if (previous !== undefined && number > previous + 1) out.push(`${" ".repeat(width)}  …`)
    out.push(`${String(number).padStart(width)}  ${text}`.trimEnd())
    previous = number
  }
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
