// Anchor resolution. See "Anchors" in PROTOCOL.md.

import { CURSOR_MARKER, type Anchor, type Candidate, type ErrorKind, type Span, type Spot } from "@ai-pair/protocol"
import { lineText, position } from "./text"

export type Range = { start: number; end: number }

export type Resolution =
  | { ok: true; range: Range }
  | { ok: false; kind: ErrorKind; message: string; candidates?: Candidate[] }

const MAX_CANDIDATES = 20

function findAll(text: string, needle: string): number[] {
  const starts: number[] = []
  if (needle === "") return starts
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) {
    starts.push(i)
  }
  return starts
}

function candidates(text: string, starts: number[]): Candidate[] {
  return starts.slice(0, MAX_CANDIDATES).map((start) => {
    const { line } = position(text, start)
    return { line, context: lineText(text, line).trim() }
  })
}

/** Text copied from a report's code may carry the cursor marker. */
function unmarked(text: string): string {
  return text.replaceAll(CURSOR_MARKER, "")
}

/** Resolves an anchor in `text`: a unique match, or the one closest to `near_line`. */
export function resolveAnchor(text: string, anchor: Anchor): Resolution {
  anchor = { ...anchor, text: unmarked(anchor.text) }
  const starts = findAll(text, anchor.text)
  const range = (start: number): Resolution => ({
    ok: true,
    range: { start, end: start + anchor.text.length },
  })

  if (starts.length === 0) {
    return { ok: false, kind: "anchor_not_found", message: `Text not found: ${JSON.stringify(anchor.text)}` }
  }
  if (starts.length === 1) return range(starts[0]!)

  if (anchor.near_line !== undefined) {
    const target = anchor.near_line
    let best = starts[0]!
    for (const s of starts) {
      if (Math.abs(position(text, s).line - target) < Math.abs(position(text, best).line - target)) best = s
    }
    return range(best)
  }

  return {
    ok: false,
    kind: "anchor_ambiguous",
    message: `${starts.length} matches for ${JSON.stringify(anchor.text)}; make it longer to be unique, or add near_line`,
    candidates: candidates(text, starts),
  }
}

/** Resolves a spot: the offset between `before` and `after`, which occur together. */
export function resolveSpot(text: string, spot: Spot): Resolution {
  const before = unmarked(spot.before)
  const r = resolveAnchor(text, { text: before + unmarked(spot.after), near_line: spot.near_line })
  if (!r.ok) return r
  const at = r.range.start + before.length
  return { ok: true, range: { start: at, end: at } }
}

/** Resolves a single anchor, or a from/to range: `to` is its first match after `from`. */
export function resolveSpan(text: string, span: Span): Resolution {
  if (!("from" in span)) return resolveAnchor(text, span)
  const start = resolveAnchor(text, span.from)
  if (!start.ok) return start
  const to = unmarked(span.to.text)
  const end = to === "" ? -1 : text.indexOf(to, start.range.end)
  if (end === -1) return { ok: false, kind: "anchor_not_found", message: `Text not found after \`from\`: ${JSON.stringify(to)}` }
  return { ok: true, range: { start: start.range.start, end: end + to.length } }
}
