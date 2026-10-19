// Staged pairing's plan: what the current stage still has to put into the programmer's code, and
// what it takes out. Tracked by the identities of lines (lines.ts), not their numbers, so the
// numbering of what's left stays steady while anyone edits, and the programmer's edits always stand:
// a line of the plan they delete is dropped, a line due to go that they change stays, and lines they
// add are theirs. See "Stages" in PROTOCOL.md.

import type { SetAside } from "@ai-pair/protocol"
import { diffArrays } from "diff"
import type { LineIds } from "./lines"
import { merge3 } from "./merge"
import type { StageChange } from "./ports"
import { fileLines } from "./text"

/** A stage as the author recorded it: its snapshot of the copy, and how it differs from the one before. */
export type StageRecord = {
  /** From 1. */
  number: number
  title: string
  notes: string
  snapshot: string
  changes: StageChange[]
}

type PlanLine = { text: string; id?: number; dropped?: true }

type FilePlan = {
  /** The file's lines as the stage leaves it. A line with an identity is in the file. */
  lines: PlanLine[]
  /** The lines the stage takes out, by identity, with their text when it started. */
  remove: Map<number, string>
  /** Lines `write` made: one it left half typed, when interrupted, is the plan's to take back out. */
  ours: Set<number>
  finalNewline: boolean
  /** The stage deletes the file, once its lines are out. */
  deleted: boolean
}

/** One line of what a file's stage is about, in the order of the file. */
export type Item =
  /** A line of the plan that's in the file, at `line`. */
  | { kind: "line"; index: number; line: number }
  /** A line of the plan still to write, before the next line in the file. */
  | { kind: "write"; index: number; text: string }
  /** A line of the file the stage takes out. */
  | { kind: "remove"; line: number; id: number; text: string }
  /** A line not in the plan, someone's own: it stays. */
  | { kind: "extra"; line: number }

export type FileView = {
  file: string
  /** The file's lines, as it reads now. */
  lines: string[]
  items: Item[]
  /** Items still to write or take out. */
  pending: number
  /** Its last line still needs its final newline, or still has one it shouldn't. */
  newline: boolean
  /** The stage deletes the file, and it still exists. */
  remove: boolean
}

/** Reads a file's text, or nothing if it doesn't exist. */
export type ReadFile = (file: string) => Promise<string | undefined>

/** A line of `old` and one of `now` read as the same line edited, not one replaced by another. */
export function similar(old: string, now: string): boolean {
  const a = old.trim()
  const b = now.trim()
  if (a === "" || b === "") return false
  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++
  let suffix = 0
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++
  return (prefix + suffix) / Math.max(a.length, b.length) >= 0.4
}

export class StagePlan {
  /** The stage being played, by number; 0 before the first. */
  number = 0
  private files = new Map<string, FilePlan>()
  /** Of every stage started so far. */
  setAside: SetAside[] = []

  /** `stages`: shared with the session, which adds to it as the author records them. */
  constructor(private readonly stages: readonly StageRecord[]) {}

  /** A copy to play batches in memory: its changes don't affect this one. */
  clone(): StagePlan {
    const copy = new StagePlan(this.stages)
    copy.number = this.number
    copy.setAside = [...this.setAside]
    for (const [file, fp] of this.files) {
      copy.files.set(file, { ...fp, lines: fp.lines.map((l) => ({ ...l })), remove: new Map(fp.remove), ours: new Set(fp.ours) })
    }
    return copy
  }

  get current(): StageRecord | undefined {
    return this.stages[this.number - 1]
  }

  /** The files the current stage changes, in the order the author's snapshot lists them. */
  get paths(): string[] {
    return [...this.files.keys()]
  }

  has(file: string): boolean {
    return this.files.has(file)
  }

  /**
   * Starts the stages that are in, while the current one has nothing left: a stage whose code is
   * all written gives way to the next at once. Returns the stages started.
   */
  async advance(read: ReadFile, lines: LineIds): Promise<StageRecord[]> {
    const started: StageRecord[] = []
    for (let next = this.stages[this.number]; next; next = this.stages[this.number]) {
      if (this.number > 0 && !(await this.done(read, lines))) break
      await this.begin(next, read, lines)
      started.push(next)
    }
    return started
  }

  /** What's left of the current stage, file by file: only files with something left. */
  async left(read: ReadFile, lines: LineIds): Promise<FileView[]> {
    const views: FileView[] = []
    for (const file of this.files.keys()) {
      const text = await read(file)
      const view = this.view(file, text ?? "", text === undefined ? [] : lines.of(file, text), text !== undefined)
      if (view && (view.pending > 0 || view.newline || view.remove)) views.push(view)
    }
    return views
  }

  /** Nothing left but final newlines, which aren't worth holding the next stage back for. */
  private async done(read: ReadFile, lines: LineIds): Promise<boolean> {
    return (await this.left(read, lines)).every((v) => v.pending === 0 && !v.remove)
  }

  /**
   * Starts `stage`: its target for each file is the author's version merged into the file as it is
   * now, so the programmer's edits since the stage before stay. Where both changed the same lines,
   * theirs win, and the author's are set aside. Made whole before it's put in place, so a copy
   * taken meanwhile has the stage before or this one, never half of it.
   */
  private async begin(stage: StageRecord, read: ReadFile, lines: LineIds): Promise<void> {
    const files = new Map<string, FilePlan>()
    const setAside: SetAside[] = []
    for (const change of stage.changes) {
      if (change.binary) continue
      const { file, before, after } = change
      const now = await read(file)
      const theirs = now?.replaceAll("\r\n", "\n")
      let target: string | undefined
      if (after === undefined) {
        // Deleting a file the programmer has changed would take their work with it.
        if (theirs === undefined) continue
        if (before !== undefined && theirs !== before) {
          setAside.push({ file, stage: stage.number, plan: "(the file deleted)", kept: theirs })
          continue
        }
      } else if (theirs === undefined && before !== undefined) {
        // They deleted a file the stage changes.
        setAside.push({ file, stage: stage.number, plan: after, kept: "(the file deleted)" })
        continue
      } else {
        const merged = merge3(before ?? "", after, theirs ?? "", "theirs")
        target = merged.text
        for (const c of merged.conflicts) setAside.push({ file, stage: stage.number, plan: c.ours, kept: c.theirs })
        if (target === theirs) continue
      }
      const current = now === undefined ? [] : fileLines(now).lines
      const ids = now === undefined ? [] : lines.of(file, now)
      const fp: FilePlan = {
        lines: [],
        remove: new Map(),
        ours: new Set(),
        finalNewline: target === undefined || target === "" || target.endsWith("\n"),
        deleted: target === undefined,
      }
      let at = 0
      for (const op of lineDiff(current, target === undefined ? [] : fileLines(target).lines)) {
        if (op.kind === "add") fp.lines.push({ text: op.text })
        else if (op.kind === "remove") fp.remove.set(ids[at++]!, op.text)
        else fp.lines.push({ text: op.text, id: ids[at++]! })
      }
      files.set(file, fp)
    }
    this.number = stage.number
    this.files = files
    this.setAside = [...this.setAside, ...setAside]
  }

  /**
   * The file's stage as it reads in `text`, whose lines have the identities `ids`. A line of the
   * plan that was in the file and no longer is was deleted by someone: it's dropped. A line still
   * to write that someone typed as is, in its place, counts as written. `exists`: the file exists.
   */
  view(file: string, text: string, ids: readonly number[], exists = true): FileView | undefined {
    const fp = this.files.get(file)
    if (!fp) return undefined
    const { lines } = fileLines(text)
    const at = new Map<number, number>()
    for (let i = 0; i < lines.length; i++) at.set(ids[i]!, i + 1)
    // Every identity gone: the file changed without the change being heard, say on disk. Its lines
    // are found again by their text, instead of all being taken as deleted.
    const known = fp.lines.filter((l) => l.id !== undefined && !l.dropped)
    if (known.length > 0 && !known.some((l) => at.has(l.id!))) realign(fp, lines, ids)

    const present = new Map<number, number>()
    for (let i = 0; i < fp.lines.length; i++) {
      const l = fp.lines[i]!
      if (l.dropped || l.id === undefined) continue
      const line = at.get(l.id)
      if (line === undefined) l.dropped = true
      else present.set(line, i)
    }
    const removing = new Map<number, number>()
    for (const [id, was] of fp.remove) {
      const line = at.get(id)
      // Gone: it's out. Changed by someone else than `write`: it's theirs now, and stays.
      if (line === undefined || (lines[line - 1] !== was && !fp.ours.has(id))) fp.remove.delete(id)
      else removing.set(line, id)
    }
    this.match(fp, lines, ids, present, removing)
    // What `write` left half typed, and nothing matched, goes back out.
    for (const id of fp.ours) {
      const line = at.get(id)
      if (line === undefined) fp.ours.delete(id)
      else if (!present.has(line) && !removing.has(line)) {
        fp.remove.set(id, lines[line - 1]!)
        removing.set(line, id)
      }
    }

    const missing: number[] = []
    for (let i = 0; i < fp.lines.length; i++) if (fp.lines[i]!.id === undefined && !fp.lines[i]!.dropped) missing.push(i)
    const items: Item[] = []
    let next = 0
    for (let line = 1; line <= lines.length; line++) {
      const index = present.get(line)
      if (index !== undefined) {
        while (next < missing.length && missing[next]! < index) items.push(this.write(fp, missing[next++]!))
        items.push({ kind: "line", index, line })
      } else if (removing.has(line)) items.push({ kind: "remove", line, id: removing.get(line)!, text: lines[line - 1]! })
      else items.push({ kind: "extra", line })
    }
    while (next < missing.length) items.push(this.write(fp, missing[next++]!))
    const pending = items.filter((i) => i.kind === "write" || i.kind === "remove").length
    const newline = lines.length > 0 && pending === 0 && !fp.deleted && text.endsWith("\n") !== fp.finalNewline
    return { file, lines, items, pending, newline, remove: fp.deleted && exists && pending === 0 }
  }

  private write(fp: FilePlan, index: number): Item {
    return { kind: "write", index, text: fp.lines[index]!.text }
  }

  /**
   * Lines still to write that are in the file as is, typed by the programmer or by the agent's own
   * `type`: they count as written. Only between the plan's lines around them, in order, and first
   * among the lines `write` made.
   */
  private match(fp: FilePlan, lines: string[], ids: readonly number[], present: Map<number, number>, removing: Map<number, number>): void {
    const lineOf = new Map<number, number>()
    for (const [line, index] of present) lineOf.set(index, line)
    for (const oursOnly of [true, false]) {
      let after = 0
      for (let i = 0; i < fp.lines.length; i++) {
        const l = fp.lines[i]!
        if (l.dropped) continue
        const line = lineOf.get(i)
        if (line !== undefined) {
          after = line
          continue
        }
        let before = lines.length + 1
        for (let j = i + 1; j < fp.lines.length; j++) {
          const later = lineOf.get(j)
          if (later !== undefined) {
            before = later
            break
          }
        }
        const want = l.text.trim()
        for (let n = after + 1; n < before; n++) {
          if (present.has(n) || removing.has(n) || lines[n - 1]!.trim() !== want) continue
          if (oursOnly && !fp.ours.has(ids[n - 1]!)) continue
          l.id = ids[n - 1]!
          present.set(n, i)
          lineOf.set(i, n)
          after = n
          break
        }
      }
    }
  }

  /** Takes lines out of the plan: lines to write aren't, lines to take out stay. */
  drop(file: string, items: Item[]): void {
    const fp = this.files.get(file)
    if (!fp) return
    for (const item of items) {
      if (item.kind === "write") fp.lines[item.index]!.dropped = true
      else if (item.kind === "remove") fp.remove.delete(item.id)
    }
  }

  /** `write` turned a line due to go into a line of the plan, by editing it. */
  edited(file: string, index: number, id: number): void {
    const fp = this.files.get(file)
    if (!fp) return
    fp.lines[index]!.id = id
    fp.remove.delete(id)
  }

  /** Lines `write` made, so what an interruption leaves half typed is taken back out. */
  made(file: string, ids: Iterable<number>): void {
    const fp = this.files.get(file)
    if (fp) for (const id of ids) fp.ours.add(id)
  }

  /** The identities of the plan's lines in the file, to `rebind` them after an edit of the agent's. */
  held(file: string, ids: readonly number[]): Map<number, number> {
    const fp = this.files.get(file)
    const held = new Map<number, number>()
    if (!fp) return held
    const live = new Set(ids)
    fp.lines.forEach((l, i) => {
      if (l.id !== undefined && !l.dropped && live.has(l.id)) held.set(l.id, i)
    })
    return held
  }

  /**
   * After an edit of the agent's: a line of the plan the edit replaced with a new line of the same
   * text, as deleting the lines around an empty line can, is still in the file. Only a line the
   * programmer deletes is dropped.
   */
  rebind(file: string, held: Map<number, number>, text: string, ids: readonly number[]): void {
    const fp = this.files.get(file)
    if (!fp) return
    const { lines } = fileLines(text)
    const live = new Set(ids.slice(0, lines.length))
    const taken = new Set<number>()
    for (const l of fp.lines) if (l.id !== undefined) taken.add(l.id)
    for (const id of fp.remove.keys()) taken.add(id)
    for (const [id, index] of held) {
      if (live.has(id)) continue
      const l = fp.lines[index]!
      // Its place: between the nearest lines of the plan around it that are still in the file.
      const lineOf = (j: number) => {
        const other = fp.lines[j]!.id
        return other !== undefined && live.has(other) ? ids.indexOf(other) + 1 : undefined
      }
      let after = 0
      for (let j = index - 1; j >= 0 && after === 0; j--) after = lineOf(j) ?? 0
      let before = lines.length + 1
      for (let j = index + 1; j < fp.lines.length && before === lines.length + 1; j++) before = lineOf(j) ?? lines.length + 1
      l.id = undefined
      for (let n = after + 1; n < before; n++) {
        const candidate = ids[n - 1]!
        if (taken.has(candidate) || lines[n - 1] !== l.text) continue
        l.id = candidate
        taken.add(candidate)
        break
      }
      if (l.id === undefined) l.dropped = true
    }
  }
}

/** Finds the plan's lines in the file again by their text, once their identities are lost. */
function realign(fp: FilePlan, lines: string[], ids: readonly number[]): void {
  const kept = fp.lines.filter((l) => !l.dropped)
  const removing = [...fp.remove.values()]
  fp.remove = new Map()
  fp.ours = new Set()
  let n = 0
  let k = 0
  for (const part of diffArrays(kept.map((l) => l.text), lines)) {
    for (const text of part.value) {
      if (part.added) {
        // In the file, not the plan: due to go if the stage took out a line like it.
        const id = ids[n++]!
        const i = removing.indexOf(text)
        if (i !== -1) {
          removing.splice(i, 1)
          fp.remove.set(id, text)
        }
      } else if (part.removed) kept[k++]!.id = undefined
      else kept[k++]!.id = ids[n++]!
    }
  }
}

type DiffOp = { kind: "keep" | "add" | "remove"; text: string }

/**
 * The lines that turn `before` into `after`, with each change slid along the equal lines next to it
 * when that joins it to another change. The diff alone can match a blank line on the far side of a
 * kept one and split a change in two around it: a method added before two blank lines comes out as
 * the method, then a kept blank line, then one more blank line added on its own. `write` plays
 * each piece separately, so the presenter's next `write` would type just that blank line.
 */
function lineDiff(before: string[], after: string[]): DiffOp[] {
  const ops: DiffOp[] = []
  for (const part of diffArrays(before, after)) {
    const kind = part.added ? "add" : part.removed ? "remove" : "keep"
    for (const text of part.value) ops.push({ kind, text })
  }
  const changed = (i: number) => i >= 0 && i < ops.length && ops[i]!.kind !== "keep"
  // Sliding a run of one kind over equal kept lines only changes which of the equal lines are the
  // kept ones: the texts stay where they are, so both files still read the same. Only the kinds move.
  const relabel = (from: number, to: number, kind: DiffOp["kind"]) => {
    for (let i = from; i < to; i++) ops[i]!.kind = kind
  }
  let s = 0
  while (s < ops.length) {
    const kind = ops[s]!.kind
    let e = s + 1
    while (e < ops.length && ops[e]!.kind === kind) e++
    if (kind === "keep" || changed(s - 1) || changed(e)) {
      s = e
      continue
    }
    let joined = false
    for (let k = 1; !joined && s - k >= 0 && ops[s - k]!.kind === "keep" && ops[s - k]!.text === ops[e - k]!.text; k++) {
      if (!changed(s - k - 1)) continue
      relabel(e - k, e, "keep")
      relabel(s - k, e - k, kind)
      joined = true
    }
    for (let k = 1; !joined && e + k - 1 < ops.length && ops[e + k - 1]!.kind === "keep" && ops[e + k - 1]!.text === ops[s + k - 1]!.text; k++) {
      if (!changed(e + k)) continue
      relabel(s, s + k, "keep")
      relabel(s + k, e + k, kind)
      joined = true
    }
    s = e
  }
  return ops
}
