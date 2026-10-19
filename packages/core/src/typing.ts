// Typing cadence and reading time. The numbers are in timing.ts.

import type { Cadence, Reading } from "./timing"

/** A piece of text inserted in one edit, after waiting `delay` ms. */
export type Chunk = { text: string; delay: number }

const PUNCTUATION = new Set([",", ";", ":"])
const OPEN_BRACKETS = new Set(["(", "[", "{"])
const WORD = /[\p{L}\p{N}_]/u

function isIndent(ch: string | undefined): boolean {
  return ch === " " || ch === "\t"
}

/**
 * Splits text into chunks: one per character, except that a newline and the indentation after
 * it are inserted together, as an editor's auto-indent would. Indentation at the very start is
 * inserted at once too, if `atLineStart`. Every delay is multiplied by `scale`.
 *
 * The rhythm: quick within words, a small pause as each word starts, and longer ones after
 * punctuation, opening brackets, and newlines.
 */
export function planTyping(
  text: string,
  cadence: Cadence,
  atLineStart: boolean,
  random: () => number,
  scale = 1,
): Chunk[] {
  const chars = Array.from(text)
  const chunks: Chunk[] = []
  let pause = 0
  let previous: string | undefined
  let i = 0

  const takeIndent = (): string => {
    let indent = ""
    while (isIndent(chars[i])) indent += chars[i++]
    return indent
  }

  if (atLineStart) {
    const indent = takeIndent()
    if (indent) {
      chunks.push({ text: indent, delay: 0 })
      previous = " "
    }
  }

  while (i < chars.length) {
    const ch = chars[i++]!
    const wordStart = previous !== undefined && !WORD.test(previous) && WORD.test(ch)
    const delay = cadence.charMs * (1 + (random() * 2 - 1) * cadence.jitter) + (wordStart ? cadence.wordStartMs : 0) + pause
    if (ch === "\n") {
      const indent = takeIndent()
      chunks.push({ text: ch + indent, delay: delay * scale })
      pause = cadence.newlineMs
      previous = indent ? " " : "\n"
    } else {
      chunks.push({ text: ch, delay: delay * scale })
      pause = PUNCTUATION.has(ch) ? cadence.punctuationMs : OPEN_BRACKETS.has(ch) ? cadence.openBracketMs : 0
      previous = ch
    }
  }
  return chunks
}

/** How many words a `say` holds, for pacing it read or spoken. */
export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length
}

export function readingTime(text: string, reading: Reading): number {
  return Math.min(reading.maxMs, Math.max(reading.minMs, wordCount(text) * reading.msPerWord))
}
