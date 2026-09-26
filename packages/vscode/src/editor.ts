// The EditorPort for VS Code: documents, edits, the agent cursor, follow mode.

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

function labelDecoration(text: string, color: string, opacity: number) {
  return vscode.window.createTextEditorDecorationType({
    before: {
      contentText: text,
      textDecoration: `none; position: absolute; transform: translateY(-105%); z-index: 10; pointer-events: none; padding: 0 4px; border-radius: 3px; font-size: 0.75em; line-height: 1.35; white-space: nowrap; background-color: ${color}; color: #1b1b1b; opacity: ${opacity};`,
    },
  })
}

const CURSOR = "var(--vscode-aiPair-cursor)"
const READ = "var(--vscode-aiPair-cursorRead)"

export class VsCodeEditor implements EditorPort, vscode.Disposable {
  controller?: Controller
  /** The programmer's selection changed: what the panel offers to send along with a reply. */
  onSelection?: (ref: Ref | undefined) => void
  private lastEditor?: vscode.TextEditor
  private lastSelectionKey = ""
  private readonly terminals = new PairTerminals()
  private readonly mirror = new Map<string, string>()
  private readonly own = new Map<string, OwnEdit[]>()
  private cursor: CursorView | null = null
  private state: AgentState = "thinking"
  private point: { file: string; start: number; end: number } | null = null
  private focus: Focus = "cursor"
  private pulse?: ReturnType<typeof setInterval>
  private pulseOn = true
  private selfNavUntil = 0
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
      vscode.window.onDidChangeVisibleTextEditors(() => this.redraw()),
      vscode.window.onDidChangeTextEditorSelection((e) => this.onSelectionChange(e.textEditor)),
      this.terminals,
    )
    this.lastEditor = vscode.window.activeTextEditor
  }

  setAgentName(name: string): void {
    for (const t of Object.values(this.labelTypes)) t.dispose()
    this.labelTypes = {
      typing: labelDecoration(name, CURSOR, 1),
      read: labelDecoration(name, READ, 1),
      readDim: labelDecoration(name, CURSOR, 1),
      thinking: labelDecoration(name, CURSOR, 0.6),
      running: labelDecoration(`${name} · running`, CURSOR, 0.8),
      paused: labelDecoration(`${name} · paused`, CURSOR, 0.8),
      listening: labelDecoration(`${name} · listening`, CURSOR, 0.8),
      navigator: labelDecoration(`${name} · your turn`, CURSOR, 0.8),
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
    await this.openDocument(file)?.save()
  }

  renderCursor(cursor: CursorView | null, state: AgentState, focus: Focus): void {
    this.cursor = cursor
    this.focus = focus
    if (state !== this.state) {
      this.state = state
      this.updatePulse()
    }
    this.redraw()
    const target = this.target()
    if (target && FOLLOWING.has(state)) this.follow(target)
  }

  renderPoint(point: { file: string; start: number; end: number } | null): void {
    this.point = point
    this.redraw()
  }

  reveal(): void {
    const target = this.target()
    if (target) void this.show(target.file).then(() => this.follow(target, true))
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
    this.controller?.userEdit(file, before, after, changes)
  }

  // Looking away from what the view follows pauses playback: the cursor, or the code it points at.

  private onActiveEditor(editor: vscode.TextEditor | undefined): void {
    if (editor?.document.uri.scheme === "file") this.onSelectionChange(editor)
    const target = this.target()
    if (!editor || Date.now() < this.selfNavUntil || !target || !FOLLOWING.has(this.state)) return
    if (editor.document.uri.fsPath !== target.file) this.controller?.pause("away")
  }

  private onScroll(e: vscode.TextEditorVisibleRangesChangeEvent): void {
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

  /** Keeps the target in the upper part of the viewport, scrolling only when it leaves a band. */
  private follow(target: Target, force = false): void {
    const editor = this.visibleEditor(target.file)
    const visible = editor?.visibleRanges[0]
    if (!editor || !visible) return
    const line = editor.document.positionAt(target.offset).line
    const height = Math.max(1, visible.end.line - visible.start.line)
    const top = visible.start.line + Math.floor(height * 0.1)
    const bottom = visible.start.line + Math.floor(height * 0.6)
    // At the top of a file the target can't sit lower in the viewport, and that's fine.
    const inBand = line <= bottom && (line >= top || visible.start.line === 0)
    if (!force && inBand) return
    const scrollTo = Math.max(0, line - Math.floor(height / 3))
    this.selfNav()
    editor.revealRange(new vscode.Range(scrollTo, 0, scrollTo, 0), vscode.TextEditorRevealType.AtTop)
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
