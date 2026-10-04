// The EditorPort for VS Code: documents, edits, the agent cursor, follow mode.

import * as fs from "node:fs"
import * as path from "node:path"
import * as vscode from "vscode"
import { samePath, withinFolder } from "@ai-pair/core"
import type {
  AgentState,
  Change,
  CommandOutcome,
  Controller,
  CursorView,
  EditOptions,
  EditorPort,
  Focus,
  Ref,
  RunOptions,
  SharedSelection,
} from "@ai-pair/core"
import { PairTerminals } from "./terminal"

type OwnEdit = { offset: number; deleteLength: number; text: string }

/** A place follow mode keeps in view. */
type Target = { file: string; offset: number }

/** States in which the programmer's view follows the agent cursor. */
const FOLLOWING: ReadonlySet<AgentState> = new Set(["typing", "read", "thinking", "listening"])

/** View changes within this long after our own navigation are ours, not the programmer's. */
const SELF_NAV_MS = 400

/** With smooth scrolling, our own scroll has finished once the visible ranges stay unchanged this long. */
const SCROLL_QUIET_MS = 50

/** The longest we wait for our own scroll to finish. */
const SCROLL_MAX_MS = 500

/** How long follow mode's scroll glides, easing out, however far it goes. */
const GLIDE_MS = 500

/** A glide's frame. */
const FRAME_MS = 16

/** A shared selection is cut off here; the agent can `read` the rest. */
const MAX_EXCERPT = 8000

function cursorDecoration(color: string, style: string, opacity: number) {
  return vscode.window.createTextEditorDecorationType({
    before: {
      contentText: "\u200b",
      textDecoration: `none; position: relative; border-left: 2px ${style} ${color}; margin-left: -1px; margin-right: -1px; opacity: ${opacity};`,
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  })
}

/** `color` and `foreground`: the label's background and its text, a pair of theme colors. */
function labelDecoration(text: string, color: string, foreground: string, opacity: number) {
  return vscode.window.createTextEditorDecorationType({
    before: {
      contentText: text,
      textDecoration: `none; position: absolute; transform: translateY(-105%); z-index: 10; pointer-events: none; padding: 0 4px; border-radius: 3px; font-size: 0.75em; line-height: 1.35; white-space: nowrap; background-color: ${color}; color: ${foreground}; opacity: ${opacity};`,
    },
  })
}

/**
 * Where `line` is in the view: how many visible lines are above it, negative above the view, and as
 * many as there are visible lines, or more, below it. Folded lines don't count.
 */
function row(ranges: readonly vscode.Range[], line: number): number {
  const first = ranges[0]!.start.line
  if (line < first) return line - first
  let above = 0
  for (const r of ranges) {
    if (line <= r.end.line) return above + Math.max(0, line - r.start.line)
    above += r.end.line - r.start.line + 1
  }
  return above + line - ranges.at(-1)!.end.line - 1
}

const CURSOR = "var(--vscode-aiPair-cursor)"
const READ = "var(--vscode-aiPair-cursorRead)"
const CURSOR_TEXT = "var(--vscode-aiPair-cursorForeground)"
const READ_TEXT = "var(--vscode-aiPair-cursorReadForeground)"

export class VsCodeEditor implements EditorPort, vscode.Disposable {
  controller?: Controller
  /** The programmer's selection changed: what the panel offers to send along with a reply. */
  onSelection?: (ref: Ref | undefined) => void
  private lastEditor?: vscode.TextEditor
  private lastSelectionKey = ""
  private readonly terminals = new PairTerminals()
  private readonly mirror = new Map<string, string>()
  private readonly own = new Map<string, OwnEdit[]>()
  /** Files we're saving: changes to them meanwhile are by save participants, like format on save. */
  private readonly saving = new Set<string>()
  private cursor: CursorView | null = null
  private state: AgentState = "thinking"
  private point: { file: string; start: number; end: number } | null = null
  private focus: Focus = "cursor"
  private pulse?: ReturnType<typeof setInterval>
  private pulseOn = true
  private selfNavUntil = 0
  /**
   * How many lines each editor group's viewport shows, as last seen without a document's end in view,
   * or measured. A zoom or a resize since, with a document's end in view, goes unnoticed.
   */
  private readonly viewportLines = new Map<vscode.ViewColumn | undefined, number>()
  /** Our own scroll is under way: until it finishes, the visible ranges are the ones from before it. */
  private scrolling = false
  private readonly disposables: vscode.Disposable[] = []
  private readonly cursorTypes: Record<string, vscode.TextEditorDecorationType>
  private labelTypes: Record<string, vscode.TextEditorDecorationType> = {}
  private readonly selectionType = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor("aiPair.selectionBackground"),
  })
  private readonly pointType = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor("aiPair.pointBackground"),
    border: "1px solid",
    borderColor: new vscode.ThemeColor("aiPair.pointBorder"),
    borderRadius: "2px",
  })

  constructor(
    private readonly root: string,
    agentName: string,
  ) {
    this.cursorTypes = {
      typing: cursorDecoration(CURSOR, "solid", 1),
      read: cursorDecoration(READ, "solid", 1),
      readDim: cursorDecoration(CURSOR, "solid", 0.6),
      thinking: cursorDecoration(CURSOR, "solid", 0.45),
      running: cursorDecoration(CURSOR, "solid", 0.6),
      paused: cursorDecoration(CURSOR, "dashed", 0.6),
      listening: cursorDecoration(CURSOR, "dotted", 0.8),
      navigator: cursorDecoration(CURSOR, "dotted", 0.8),
    }
    this.setAgentName(agentName)
    for (const doc of vscode.workspace.textDocuments) this.track(doc)
    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument((doc) => this.track(doc)),
      vscode.workspace.onDidCloseTextDocument((doc) => this.mirror.delete(doc.uri.fsPath)),
      vscode.workspace.onDidChangeTextDocument((e) => this.onChange(e)),
      vscode.window.onDidChangeActiveTextEditor((e) => this.onActiveEditor(e)),
      vscode.window.onDidChangeTextEditorVisibleRanges((e) => this.onScroll(e)),
      vscode.window.onDidChangeVisibleTextEditors((editors) => {
        for (const editor of editors) this.viewport(editor)
        this.redraw()
      }),
      vscode.window.onDidChangeTextEditorSelection((e) => this.onSelectionChange(e.textEditor)),
      this.terminals,
    )
    this.lastEditor = vscode.window.activeTextEditor
  }

  setAgentName(name: string): void {
    for (const t of Object.values(this.labelTypes)) t.dispose()
    this.labelTypes = {
      typing: labelDecoration(name, CURSOR, CURSOR_TEXT, 1),
      read: labelDecoration(name, READ, READ_TEXT, 1),
      readDim: labelDecoration(name, CURSOR, CURSOR_TEXT, 1),
      thinking: labelDecoration(name, CURSOR, CURSOR_TEXT, 0.6),
      running: labelDecoration(`${name} · running`, CURSOR, CURSOR_TEXT, 0.8),
      paused: labelDecoration(`${name} · paused`, CURSOR, CURSOR_TEXT, 0.8),
      listening: labelDecoration(`${name} · listening`, CURSOR, CURSOR_TEXT, 0.8),
      navigator: labelDecoration(`${name} · your turn`, CURSOR, CURSOR_TEXT, 0.8),
    }
    this.redraw()
  }

  // ---- EditorPort ----------------------------------------------------------

  /** Spelled the way VS Code spells it: an open document's path, else a workspace folder's. */
  resolvePath(file: string): string {
    const resolved = vscode.Uri.file(path.resolve(this.root, file)).fsPath
    const open = vscode.workspace.textDocuments.find((d) => d.uri.scheme === "file" && samePath(d.uri.fsPath, resolved))
    if (open) return open.uri.fsPath
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const inside = withinFolder(folder.uri.fsPath, resolved)
      if (inside) return inside
    }
    return resolved
  }

  displayPath(file: string): string {
    return this.inWorkspace(file) ? path.relative(this.root, file) : file
  }

  async getText(file: string): Promise<string> {
    return (await this.document(file)).getText()
  }

  async eol(file: string): Promise<string> {
    return (await this.document(file)).eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n"
  }

  async isDirty(file: string): Promise<boolean> {
    return this.openDocument(file)?.isDirty ?? false
  }

  async show(file: string): Promise<void> {
    const uri = vscode.Uri.file(file)
    try {
      await vscode.workspace.fs.stat(uri)
    } catch {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(file)))
      await vscode.workspace.fs.writeFile(uri, new Uint8Array())
    }
    if (this.visibleEditor(file)) return
    this.selfNav()
    const doc = await vscode.workspace.openTextDocument(uri)
    await vscode.window.showTextDocument(doc, {
      preview: false,
      preserveFocus: true,
      viewColumn: vscode.window.activeTextEditor?.viewColumn,
    })
  }

  async edit(file: string, offset: number, deleteLength: number, text: string, options: EditOptions): Promise<void> {
    const editor = this.visibleEditor(file)
    const entry: OwnEdit = { offset, deleteLength, text }
    const pending = this.own.get(file) ?? []
    this.own.set(file, pending)
    pending.push(entry)
    try {
      if (editor) {
        const doc = editor.document
        const range = new vscode.Range(doc.positionAt(offset), doc.positionAt(offset + deleteLength))
        if (!(await editor.edit((b) => b.replace(range, text), options))) throw new Error("The edit was rejected.")
      } else {
        // Not visible (e.g. the programmer looked away): no control over undo stops.
        const doc = await this.document(file)
        const range = new vscode.Range(doc.positionAt(offset), doc.positionAt(offset + deleteLength))
        const edit = new vscode.WorkspaceEdit()
        edit.replace(doc.uri, range, text)
        if (!(await vscode.workspace.applyEdit(edit))) throw new Error("The edit was rejected.")
      }
    } finally {
      const i = pending.indexOf(entry)
      if (i !== -1) pending.splice(i, 1)
    }
  }

  async save(file: string): Promise<void> {
    const doc = this.openDocument(file)
    if (!doc?.isDirty) return
    this.saving.add(file)
    try {
      // A save that fails, say because the file on disk is newer, resolves to false instead of throwing.
      if (!(await doc.save())) throw new Error("the editor didn't save it; the file on disk may have changed")
    } finally {
      this.saving.delete(file)
    }
  }

  renderCursor(cursor: CursorView | null, state: AgentState, focus: Focus): void {
    this.cursor = cursor
    this.focus = focus
    if (state !== this.state) {
      this.state = state
      this.updatePulse()
    }
    this.redraw()
  }

  renderPoint(point: { file: string; start: number; end: number } | null): void {
    this.point = point
    this.redraw()
  }

  reveal(): void {
    const target = this.target()
    if (target) void this.show(target.file).then(() => this.follow())
  }

  follow(): void {
    const target = this.target()
    if (target && FOLLOWING.has(this.state)) this.keepInView(target)
  }

  runCommand(command: string, options: RunOptions): Promise<CommandOutcome> {
    return this.terminals.run(command, options)
  }

  // ---- The programmer's selection ------------------------------------------

  /** What the programmer has selected in a workspace file, if anything. */
  programmerSelection(): SharedSelection | undefined {
    const editor = this.lastEditor
    if (!editor || !vscode.window.visibleTextEditors.includes(editor)) return undefined
    const doc = editor.document
    const sel = editor.selection
    if (doc.uri.scheme !== "file" || !this.inWorkspace(doc.uri.fsPath) || sel.isEmpty) return undefined
    const text = doc.getText(sel)
    const excerpt: SharedSelection = {
      file: doc.uri.fsPath,
      from: { line: sel.start.line + 1, column: sel.start.character + 1 },
      to: { line: sel.end.line + 1, column: sel.end.character + 1 },
      text: text.length > MAX_EXCERPT ? text.slice(0, MAX_EXCERPT) : text,
    }
    if (text.length > MAX_EXCERPT) excerpt.truncated = true
    return excerpt
  }

  selectionRef(): Ref | undefined {
    const s = this.programmerSelection()
    return s && { file: this.displayPath(s.file), line: s.from.line, endLine: s.to.line }
  }

  private onSelectionChange(editor: vscode.TextEditor): void {
    if (editor.document.uri.scheme !== "file") return
    this.lastEditor = editor
    // The agent's typing shifts the programmer's selection on every keystroke; only real changes count.
    const ref = this.selectionRef()
    const key = ref ? `${ref.file}:${ref.line}:${ref.endLine}` : ""
    if (key === this.lastSelectionKey) return
    this.lastSelectionKey = key
    this.onSelection?.(ref)
  }

  // ---- Programmer activity -------------------------------------------------

  private track(doc: vscode.TextDocument): void {
    if (doc.uri.scheme === "file") this.mirror.set(doc.uri.fsPath, doc.getText())
  }

  private onChange(e: vscode.TextDocumentChangeEvent): void {
    const doc = e.document
    if (doc.uri.scheme !== "file" || e.contentChanges.length === 0) return
    const file = doc.uri.fsPath
    const before = this.mirror.get(file)
    const after = doc.getText()
    this.mirror.set(file, after)

    // Applied from the highest offset down, each change leaves the offsets below it valid.
    const changes: Change[] = [...e.contentChanges]
      .sort((a, b) => b.rangeOffset - a.rangeOffset)
      .map((c) => ({ offset: c.rangeOffset, deleteLength: c.rangeLength, text: c.text }))

    const pending = this.own.get(file)
    const own = pending?.[0]
    const change = changes[0]!
    if (
      own &&
      changes.length === 1 &&
      change.offset === own.offset &&
      change.deleteLength === own.deleteLength &&
      change.text === own.text
    ) {
      pending!.shift()
      return
    }

    if (before === undefined || !this.inWorkspace(file)) return
    if (this.byProgrammer(e, after)) this.controller?.userEdit(file, before, after, changes)
    else this.controller?.otherEdit(file, before, after, changes)
  }

  /**
   * VS Code doesn't say who made a change, but two kinds aren't the programmer's. Edits by save
   * participants (format on save, trimming whitespace) while we save; those of the programmer's own
   * saves arrive before any event says a save has begun, so they count as theirs. And a reload from
   * disk: it leaves a clean document (`isDirty` is still as it was before the change) reading
   * exactly what's on disk, which typing into a clean document never does. Anything unsure counts as
   * the programmer's, so it interrupts.
   */
  private byProgrammer(e: vscode.TextDocumentChangeEvent, after: string): boolean {
    const file = e.document.uri.fsPath
    if (this.saving.has(file)) return false
    if (e.reason !== undefined || e.document.isDirty) return true
    try {
      return fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "") !== after
    } catch {
      return true
    }
  }

  // Looking away from what the view follows pauses playback: the cursor, or the code it points at.

  private onActiveEditor(editor: vscode.TextEditor | undefined): void {
    if (editor?.document.uri.scheme === "file") this.onSelectionChange(editor)
    const target = this.target()
    if (!editor || Date.now() < this.selfNavUntil || !target || !FOLLOWING.has(this.state)) return
    if (editor.document.uri.fsPath !== target.file) this.controller?.pause("away")
  }

  private onScroll(e: vscode.TextEditorVisibleRangesChangeEvent): void {
    this.viewport(e.textEditor)
    const target = this.target()
    if (Date.now() < this.selfNavUntil || !target || !FOLLOWING.has(this.state)) return
    if (e.textEditor.document.uri.fsPath !== target.file) return
    const line = e.textEditor.document.positionAt(target.offset).line
    const visible = e.visibleRanges.some((r) => r.start.line <= line && line <= r.end.line)
    if (!visible) this.controller?.pause("away")
  }

  // ---- Rendering -----------------------------------------------------------

  /** What follow mode keeps in view: the agent cursor, or the start of the code it points at. */
  private target(): Target | null {
    if (this.focus === "point" && this.point) return { file: this.point.file, offset: this.point.start }
    return this.cursor
  }

  /**
   * Keeps the target out of the viewport's top and bottom quarters: from there, or from out of view,
   * scrolls it to a third of the way down. At the top of a file it may have to sit higher.
   */
  private keepInView(target: Target): void {
    if (this.scrolling) return
    const editor = this.visibleEditor(target.file)
    const view = editor && this.viewport(editor)
    if (!editor || !view) return
    const line = editor.document.positionAt(target.offset).line
    const at = row(editor.visibleRanges, line)
    const { height } = view
    // Not knowing the height, at a document's end, the target is in view: everything to the end is.
    if (height === undefined ? at >= 0 : at >= height / 4 && at < (height * 3) / 4) return
    if (height !== undefined && this.landing(editor, line, height) === view.top) return
    // At a document's end, the height may be out of date, so measure it on the way.
    const measure = view.atEnd && this.scrollsBeyondEnd(editor)
    void this.scroll(editor, line, measure ? undefined : (height ?? view.rows))
  }

  /**
   * Scrolls the target to a third of the way down. Without `height`, first to the middle, which VS
   * Code can do knowing its viewport, so the lines above it are half of the viewport's; then on, from
   * where the target is by then. Afterwards, catches up with the target if it moved to another line
   * meanwhile. Only then: a landing the editor can't reach would otherwise be tried again and again.
   */
  private async scroll(editor: vscode.TextEditor, line: number, height?: number): Promise<void> {
    this.scrolling = true
    const from = editor.visibleRanges[0]!.start.line
    try {
      if (height === undefined) {
        await this.revealLine(editor, line, vscode.TextEditorRevealType.InCenter)
        // Near a document's start, the middle is out of reach and the view stays at its top.
        if (editor.visibleRanges[0] && editor.visibleRanges[0].start.line > 0) {
          height = 2 * row(editor.visibleRanges, line)
          this.viewportLines.set(editor.viewColumn, height)
        }
        const target = this.target()
        if (height === undefined || target?.file !== editor.document.uri.fsPath || !FOLLOWING.has(this.state)) return
        line = editor.document.positionAt(target.offset).line
      }
      await this.glide(editor, from, this.landing(editor, line, height), height)
    } finally {
      this.scrolling = false
    }
    const target = this.target()
    if (target?.file !== editor.document.uri.fsPath || editor.document.positionAt(target.offset).line !== line) this.follow()
  }

  /**
   * Scrolls the view's top line from `from` to `to`, easing out, a line at a time: the API scrolls by
   * lines. With `editor.smoothScrolling`, VS Code animates the scroll itself.
   */
  private async glide(editor: vscode.TextEditor, from: number, to: number, height: number): Promise<void> {
    const smooth = vscode.workspace.getConfiguration("editor", editor.document).get("smoothScrolling", false)
    if (smooth) return this.revealTop(editor, to, height)
    // Back from the middle, if measuring went there, before anyone sees it.
    if (editor.visibleRanges[0]?.start.line !== from) await this.revealTop(editor, from, height)
    const started = Date.now()
    let top = from
    while (top !== to) {
      await new Promise((resolve) => setTimeout(resolve, FRAME_MS))
      if (!FOLLOWING.has(this.state)) return
      const t = Math.min(1, (Date.now() - started) / GLIDE_MS)
      const next = Math.round(from + (to - from) * (1 - (1 - t) ** 3))
      if (next === top) continue
      top = next
      await this.revealTop(editor, top, height)
    }
  }

  /**
   * Scrolls `top` to the top of the view. A reveal at the top leaves room above for sticky scroll or
   * `editor.cursorSurroundingLines`, up to half the viewport, so it reveals that much lower.
   */
  private revealTop(editor: vscode.TextEditor, top: number, height: number): Promise<void> {
    const options = vscode.workspace.getConfiguration("editor", editor.document)
    const sticky = options.get("stickyScroll.enabled", true) ? options.get("stickyScroll.maxLineCount", 5) : 0
    const room = Math.floor(Math.min(height / 2, Math.max(options.get("cursorSurroundingLines", 0), sticky)))
    return this.revealLine(editor, top + room, vscode.TextEditorRevealType.AtTop)
  }

  /** The top line of the view that has `line` a third of the way down, as far as the editor can scroll. */
  private landing(editor: vscode.TextEditor, line: number, height: number): number {
    const last = editor.document.lineCount - 1
    const max = this.scrollsBeyondEnd(editor) ? last : Math.max(0, last + 1 - height)
    return Math.max(0, Math.min(max, line - Math.floor(height / 3)))
  }

  /** Whether the editor scrolls on past a document's last line, up to where it's the top one. */
  private scrollsBeyondEnd(editor: vscode.TextEditor): boolean {
    return vscode.workspace.getConfiguration("editor", editor.document).get("scrollBeyondLastLine", true)
  }

  /**
   * Reveals a line, and waits for the scroll to finish, so the visible ranges are the new ones. Without
   * smooth scrolling, that's their first change: waiting any longer would show a measuring stop.
   */
  private revealLine(editor: vscode.TextEditor, line: number, type: vscode.TextEditorRevealType): Promise<void> {
    const smooth = vscode.workspace.getConfiguration("editor", editor.document).get("smoothScrolling", false)
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(quiet)
        clearTimeout(max)
        changes.dispose()
        resolve()
      }
      let quiet = setTimeout(done, SCROLL_QUIET_MS)
      const max = setTimeout(done, SCROLL_MAX_MS)
      const changes = vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
        if (e.textEditor !== editor) return
        if (!smooth) return done()
        clearTimeout(quiet)
        quiet = setTimeout(done, SCROLL_QUIET_MS)
      })
      this.selfNav()
      editor.revealRange(new vscode.Range(line, 0, line, 0), type)
    })
  }

  /**
   * The editor's view: its top line, how many lines it shows, and how many its viewport fits, if
   * known. At a document's end the visible ranges stop at its last line, short of the viewport's
   * bottom, so there the height is the one last seen or measured.
   */
  private viewport(editor: vscode.TextEditor): { top: number; rows: number; atEnd: boolean; height?: number } | undefined {
    const ranges = editor.visibleRanges
    if (ranges.length === 0) return undefined
    const rows = ranges.reduce((n, r) => n + r.end.line - r.start.line + 1, 0)
    const atEnd = ranges.at(-1)!.end.line >= editor.document.lineCount - 1
    if (!atEnd) this.viewportLines.set(editor.viewColumn, rows)
    const known = this.viewportLines.get(editor.viewColumn)
    const height = !atEnd ? rows : known === undefined ? undefined : Math.max(rows, known)
    return { top: ranges[0]!.start.line, rows, atEnd, height }
  }

  private redraw(): void {
    const cursorKey = this.state === "read" ? (this.pulseOn ? "read" : "readDim") : this.state
    for (const editor of vscode.window.visibleTextEditors) {
      const file = editor.document.uri.fsPath
      const doc = editor.document
      const here = this.cursor && this.cursor.file === file ? this.cursor : null
      const at = here ? [new vscode.Range(doc.positionAt(here.offset), doc.positionAt(here.offset))] : []
      for (const [key, type] of Object.entries(this.cursorTypes)) editor.setDecorations(type, key === cursorKey ? at : [])
      for (const [key, type] of Object.entries(this.labelTypes)) editor.setDecorations(type, key === cursorKey ? at : [])
      const sel = here?.selection
      editor.setDecorations(
        this.selectionType,
        sel ? [new vscode.Range(doc.positionAt(sel.start), doc.positionAt(sel.end))] : [],
      )
      const point = this.point && this.point.file === file ? this.point : null
      editor.setDecorations(
        this.pointType,
        point ? [new vscode.Range(doc.positionAt(point.start), doc.positionAt(point.end))] : [],
      )
    }
  }

  private updatePulse(): void {
    clearInterval(this.pulse)
    this.pulse = undefined
    this.pulseOn = true
    if (this.state !== "read") return
    this.pulse = setInterval(() => {
      this.pulseOn = !this.pulseOn
      this.redraw()
    }, 450)
  }

  // ---- Helpers -------------------------------------------------------------

  private selfNav(): void {
    this.selfNavUntil = Date.now() + SELF_NAV_MS
  }

  private inWorkspace(file: string): boolean {
    return !path.relative(this.root, file).startsWith("..")
  }

  private openDocument(file: string): vscode.TextDocument | undefined {
    return vscode.workspace.textDocuments.find((d) => d.uri.fsPath === file)
  }

  private async document(file: string): Promise<vscode.TextDocument> {
    return this.openDocument(file) ?? (await vscode.workspace.openTextDocument(vscode.Uri.file(file)))
  }

  private visibleEditor(file: string): vscode.TextEditor | undefined {
    return vscode.window.visibleTextEditors.find((e) => e.document.uri.fsPath === file)
  }

  dispose(): void {
    clearInterval(this.pulse)
    for (const d of this.disposables) d.dispose()
    for (const t of [...Object.values(this.cursorTypes), ...Object.values(this.labelTypes)]) t.dispose()
    this.selectionType.dispose()
    this.pointType.dispose()
  }
}
