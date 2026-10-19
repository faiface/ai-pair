import { diff3Merge } from "node-diff3"

/** Where both sides changed the same lines differently: what each side made of them. */
export interface Conflict {
  base: string
  ours: string
  theirs: string
}

export interface Merged {
  text: string
  /** Each conflict was settled for the preferred side; the other side's lines are here. */
  conflicts: Conflict[]
}

/**
 * The lines of `text`, each with its line break, so joining them gives `text` back exactly: a
 * last line without one stays different from the same line with one.
 */
export function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? []
}

/**
 * Combines two changes of `base`, line by line: `ours` and `theirs`. Where they touch the same
 * lines differently, `prefer` wins and the conflict is reported; the same change made on both
 * sides is no conflict.
 */
export function merge3(base: string, ours: string, theirs: string, prefer: "ours" | "theirs"): Merged {
  if (ours === base || ours === theirs) return { text: theirs, conflicts: [] }
  if (theirs === base) return { text: ours, conflicts: [] }
  const regions = diff3Merge(splitLines(ours), splitLines(base), splitLines(theirs), { excludeFalseConflicts: true })
  let text = ""
  const conflicts: Conflict[] = []
  for (const region of regions) {
    if (region.ok) {
      text += region.ok.join("")
      continue
    }
    const c = region.conflict
    if (!c) continue
    const conflict = { base: c.o.join(""), ours: c.a.join(""), theirs: c.b.join("") }
    text += prefer === "ours" ? conflict.ours : conflict.theirs
    conflicts.push(conflict)
  }
  return { text, conflicts }
}
