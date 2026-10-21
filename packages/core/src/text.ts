// Offset <-> line/column conversions. Lines and columns are 1-based.

export type Position = { line: number; column: number }

export function position(text: string, offset: number): Position {
  let line = 1
  let lineStart = 0
  for (let i = text.indexOf("\n"); i !== -1 && i < offset; i = text.indexOf("\n", i + 1)) {
    line++
    lineStart = i + 1
  }
  return { line, column: offset - lineStart + 1 }
}

export function splitLines(text: string): string[] {
  return text.split(/\r?\n/)
}

/**
 * A file's lines, as the agent is shown them: a newline at the end ends the last line, and doesn't
 * start an empty one after it. An empty file has no lines.
 */
export function fileLines(text: string): { lines: string[]; finalNewline: boolean } {
  if (text === "") return { lines: [], finalNewline: true }
  const lines = splitLines(text)
  const finalNewline = text.endsWith("\n")
  if (finalNewline) lines.pop()
  return { lines, finalNewline }
}

export function lineText(text: string, line: number): string {
  return splitLines(text)[line - 1] ?? ""
}

/** The offset of the start of a line, clamped to the document. */
export function lineStart(text: string, line: number): number {
  let offset = 0
  for (let l = 1; l < line; l++) {
    const next = text.indexOf("\n", offset)
    if (next === -1) return text.length
    offset = next + 1
  }
  return offset
}

/** The offset of the end of a line (before its newline), clamped to the document. */
export function lineEnd(text: string, line: number): number {
  let offset = 0
  for (let l = 1; l < line; l++) {
    const next = text.indexOf("\n", offset)
    if (next === -1) break
    offset = next + 1
  }
  const end = text.indexOf("\n", offset)
  const stop = end === -1 ? text.length : end
  return stop > offset && text[stop - 1] === "\r" ? stop - 1 : stop
}

export function isLineStart(text: string, offset: number): boolean {
  return offset === 0 || text[offset - 1] === "\n"
}

/** Raw terminal output as plain text: no escape sequences, carriage-return overwrites resolved. */
export function terminalText(raw: string): string {
  const plain = raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "")
  return plain
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      const parts = line.split("\r").filter((p) => p !== "")
      return (parts.at(-1) ?? "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").trimEnd()
    })
    .join("\n")
    .trim()
}
