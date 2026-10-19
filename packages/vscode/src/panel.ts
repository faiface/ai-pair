// The narration panel: a webview view in the secondary side bar. See "Narration panel" in DESIGN.md.

import * as vscode from "vscode"
import type { Controller, PanelEvent, PanelPort, Ref, SharedSelection } from "@ai-pair/core"
import { panelHtml } from "./panelHtml"

/** What the panel asks of its Start button: run the chosen agent in a terminal. Which agent is
 *  chosen rarely, by command, so the panel doesn't carry a picker for it. */
export type StarterPort = {
  start(): void
}

/** A pairing mode as the panel shows it: its id lights the toggle, its word sits beside the status. */
export type ModeChoice = { id: string; label: string }

/** What the panel asks of the pairing mode: set the next session's, and read it back. */
export type ModePort = {
  set(id: string): void
  choice(): ModeChoice
}

/** How the voice is doing, as the panel shows it. `ready` is when words are actually spoken. */
export type VoiceStatus = { enabled: boolean; state: "off" | "loading" | "ready" | "error"; voice: string; detail?: string }

/** One voice the panel's menu offers: its friendly name, a short tag, whether choosing it
 *  fetches its engine first, and its shipped sample file when it has one. The raw voice id
 *  stays out of the friendly parts; nobody picks by that. */
export type VoiceRow = { model: string; voice: string; name: string; tag: string; download?: boolean; preview?: string }

/** Everything the voice menu shows: the current pick, the two engines' voices, the second's note. */
export type VoiceChoices = { current: { model: string; voice: string }; kokoro: VoiceRow[]; chatterbox: VoiceRow[]; chatterboxNote: string }

/** What the panel asks of the voice. */
export type VoicePanelPort = {
  toggle(): void
  status(): VoiceStatus
  choices(): VoiceChoices
  choose(model: string, voice: string): void
  /** Offer a recording of the programmer's own to sound like (a file picker). */
  chooseRecording(): void
}

/** Messages from the webview. */
type FromPanel =
  | { type: "ready" }
  | { type: "reply"; text: string; attach?: boolean }
  | { type: "draft"; empty: boolean }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "interrupt" }
  | { type: "turn"; message?: string; attach?: boolean }
  | { type: "end" }
  | { type: "open"; file: string; line: number }
  /** A file named in a message: a path, or just its name. */
  | { type: "openFile"; file: string }
  | { type: "openUrl"; url: string }
  /** A command the intro offers, like Set Up Agent. */
  | { type: "command"; command: string }
  | { type: "speed"; value: number }
  | { type: "runDecision"; id: number; run: boolean; allow?: "program" | "all" }
  | { type: "agentStart" }
  | { type: "modeSet"; id: string }
  | { type: "voiceToggle" }
  | { type: "voiceSet"; model: string; voice: string }
  | { type: "voiceRecording" }

const MAX_LOG = 400

/** The commands the panel may run: the ones its intro links to. */
const PANEL_COMMANDS: ReadonlySet<string> = new Set(["aiPair.playDemo", "aiPair.setUpAgent"])

export class NarrationPanel implements PanelPort, vscode.WebviewViewProvider {
  static readonly viewId = "aiPair.narration"
  controller?: Controller
  starter?: StarterPort
  mode?: ModePort
  voice?: VoicePanelPort
  private view?: vscode.WebviewView
  /** Everything posted so far, replayed when the view is (re)created. */
  private readonly log: PanelEvent[] = []
  private modeChoice: ModeChoice = { id: "build", label: "Build" }
  private voiceStatus: VoiceStatus = { enabled: false, state: "off", voice: "af_heart" }

  constructor(
    private readonly resolvePath: (file: string) => string,
    private readonly speed: { get: () => number; set: (value: number) => void },
    private readonly selection: { current: () => SharedSelection | undefined; ref: () => Ref | undefined },
  ) {}

  /** The programmer's selection changed. Not logged: only the current one matters. */
  showSelection(ref: Ref | undefined): void {
    void this.view?.webview.postMessage({ type: "selection", ref })
  }

  /** The speed setting changed. Not logged: only the current value matters. */
  showSpeed(value: number): void {
    void this.view?.webview.postMessage({ type: "speed", value })
  }

  /** The pairing mode changed, or a session started under it. Not logged: only now matters. */
  showMode(choice: ModeChoice): void {
    this.modeChoice = choice
    void this.view?.webview.postMessage({ type: "modeChoice", ...choice })
  }

  /** The voice was turned on or off, loaded, or failed. Not logged: only now matters. Its menu
   *  rides along: what changed may be exactly what the menu shows (a new pick, a fetch done). */
  showVoiceStatus(status: VoiceStatus): void {
    this.voiceStatus = status
    void vscode.commands.executeCommand("setContext", "aiPair.voiceOn", status.enabled)
    void this.view?.webview.postMessage({ type: "voiceState", ...status })
    this.showVoiceChoices()
  }

  /** The voice menu's rows, as they now stand, sample files turned into page URLs. Not logged. */
  showVoiceChoices(): void {
    const webview = this.view?.webview
    if (!this.voice || !webview) return
    const choices = this.voice.choices()
    const shown = (rows: VoiceRow[]) => rows.map((r) => (r.preview ? { ...r, preview: webview.asWebviewUri(vscode.Uri.file(r.preview)).toString() } : r))
    void webview.postMessage({ type: "voiceChoices", ...choices, kokoro: shown(choices.kokoro), chatterbox: shown(choices.chatterbox) })
  }

  /** Opens one of the panel's own menus (from a command). The page ignores it mid-session,
   *  when the row these live on is put away. */
  openMenu(menu: "mode" | "voice"): void {
    this.reveal()
    void this.view?.webview.postMessage({ type: "openMenu", menu })
  }

  post(event: PanelEvent): void {
    this.log.push(event)
    if (this.log.length > MAX_LOG) this.log.splice(0, this.log.length - MAX_LOG)
    void this.view?.webview.postMessage(event)
    if (event.type === "session") {
      void vscode.commands.executeCommand("setContext", "aiPair.active", event.active)
      if (event.active) this.reveal()
    }
    // Nothing plays until the programmer answers, so the question is brought into view.
    if (event.type === "run" && event.phase === "confirm") this.reveal()
  }

  focusReply(): void {
    this.reveal(false)
    void this.view?.webview.postMessage({ type: "focusReply" })
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    view.webview.options = { enableScripts: true }
    view.webview.html = panelHtml(view.webview.cspSource)
    view.webview.onDidReceiveMessage((m: FromPanel) => this.receive(m))
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined
    })
  }

  private reveal(preserveFocus = true): void {
    if (this.view) this.view.show(preserveFocus)
    else void vscode.commands.executeCommand(`${NarrationPanel.viewId}.focus`)
  }

  private receive(m: FromPanel): void {
    const c = this.controller
    switch (m.type) {
      case "ready":
        void this.view?.webview.postMessage({ type: "replay", events: this.log })
        this.showSpeed(this.speed.get())
        this.showSelection(this.selection.ref())
        this.showMode(this.mode?.choice() ?? this.modeChoice)
        this.showVoiceStatus(this.voice?.status() ?? this.voiceStatus)
        return
      case "speed":
        this.speed.set(m.value)
        return
      case "reply": {
        if (!c?.isActive) return
        // Replying means "go on with this", so any pause ends.
        c.resume()
        c.userMessage(m.text, m.attach ? this.selection.current() : undefined)
        return
      }
      case "agentStart":
        this.starter?.start()
        return
      case "modeSet":
        this.mode?.set(m.id)
        return
      case "voiceToggle":
        this.voice?.toggle()
        return
      case "voiceSet":
        this.voice?.choose(m.model, m.voice)
        return
      case "voiceRecording":
        this.voice?.chooseRecording()
        return
      case "draft":
        // Typing a reply pauses playback, the way a pair stops when you start talking.
        if (!c?.isActive) return
        if (m.empty) c.resume("reply")
        else c.pause("reply")
        return
      case "pause":
        c?.pause()
        return
      case "resume":
        c?.resume()
        return
      case "interrupt":
        c?.userInterrupt()
        return
      case "turn":
        c?.resume()
        if (c?.turn === "user") c.handBack(m.message, m.attach ? this.selection.current() : undefined)
        else c?.takeTurn()
        return
      case "end":
        c?.endSession()
        return
      case "runDecision":
        c?.decideRun(m.id, m.run, m.allow)
        return
      case "open": {
        const uri = vscode.Uri.file(this.resolvePath(m.file))
        const position = new vscode.Position(Math.max(0, m.line - 1), 0)
        void vscode.window.showTextDocument(uri, { selection: new vscode.Range(position, position) })
        return
      }
      case "openFile":
        void this.openByName(m.file)
        return
      case "command":
        if (PANEL_COMMANDS.has(m.command)) void vscode.commands.executeCommand(m.command)
        return
      case "openUrl":
        if (/^https?:\/\//.test(m.url)) void vscode.env.openExternal(vscode.Uri.parse(m.url))
        return
    }
  }

  /** Opens a file the agent named: as a path in the workspace, else the file of that name, asking if there are several. */
  private async openByName(name: string): Promise<void> {
    const direct = vscode.Uri.file(this.resolvePath(name))
    try {
      await vscode.workspace.fs.stat(direct)
      await vscode.window.showTextDocument(direct)
      return
    } catch {
      // Not a path from the workspace's root: look for it by name.
    }
    const found = await vscode.workspace.findFiles(`**/${name}`, "**/node_modules/**", 20)
    if (found.length === 0) {
      void vscode.window.showInformationMessage(`AI Pair: couldn't find ${name} in the workspace.`)
      return
    }
    let uri = found[0]!
    if (found.length > 1) {
      const picked = await vscode.window.showQuickPick(
        found.map((u) => ({ label: vscode.workspace.asRelativePath(u), uri: u })),
        { placeHolder: `Which ${name}?` },
      )
      if (!picked) return
      uri = picked.uri
    }
    await vscode.window.showTextDocument(uri)
  }
}
