import * as os from "node:os"
import * as path from "node:path"
import * as vscode from "vscode"
import { Bridge, Controller, createCopy } from "@ai-pair/core"
import { discoveryDir } from "@ai-pair/protocol"
import { playDemo } from "./demo"
import { VsCodeEditor } from "./editor"
import { NarrationPanel } from "./panel"
import { AgentStarter, registerServerProvider, setUpAgent, writeLauncher } from "./setup"
import { VoiceEngine, type VoiceModel } from "./voice"

/** The switches whose recordings ship in media/keys, one folder each, as the picker names them. */
const SWITCHES: Record<string, { label: string; detail: string }> = {
  holypanda: { label: "Holy Panda", detail: "Tactile: a deep, rounded thock" },
  cream: { label: "NovelKeys Cream", detail: "Linear: smooth and creamy" },
  alpaca: { label: "Alpaca", detail: "Linear: soft and quiet, a light clack" },
  mxbrown: { label: "Cherry MX Brown", detail: "Tactile: the classic office board" },
  topre: { label: "Topre", detail: "Rubber dome: muted and cushioned" },
  buckling: { label: "Buckling Spring", detail: "IBM Model M: loud, crisp, old-school" },
}

/** The pairing modes the panel offers: build it, or learn it at three splits of the work. */
type ModeId = "build" | "learn-show" | "learn-together" | "learn-try"
const MODES: Record<ModeId, { label: string; description: string; drive?: "show" | "together" | "try" }> = {
  build: { label: "Build", description: "Get it done; show me as you go" },
  "learn-show": { label: "Show me", description: "The agent drives and teaches", drive: "show" },
  "learn-together": { label: "Together", description: "A worked example, then I try the next one like it", drive: "together" },
  "learn-try": { label: "Let me try", description: "I drive; the agent navigates", drive: "try" },
}

/** Returned from `activate`, for integration tests. */
export type Api = { controller: Controller; playDemo: () => Promise<void>; launcher: string; ready: Promise<void> }

export function activate(context: vscode.ExtensionContext): Api {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir()
  const config = () => vscode.workspace.getConfiguration("aiPair")

  const editor = new VsCodeEditor(root, config().get("agentName", "Agent"))
  const speed = {
    get: () => config().get("speed", 1),
    set: (value: number) => void config().update("speed", value, vscode.ConfigurationTarget.Global),
  }
  const panel = new NarrationPanel((file) => editor.resolvePath(file), speed, {
    current: () => editor.programmerSelection(),
    ref: () => editor.selectionRef(),
  })
  const controller = new Controller(editor, panel, createCopy)
  editor.controller = controller
  editor.onSelection = (ref) => panel.showSelection(ref)
  panel.controller = controller
  controller.setSpeed(speed.get())
  controller.setTiming(config().get("timing", {}))
  controller.setConfirmCommands(config().get("confirmCommands", true))
  controller.setWorkAhead(config().get("workAheadBatches", 2))

  const bridge = new Bridge(controller, {
    dir: discoveryDir(),
    workspaceFolders: () => (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
  })
  const ready = bridge.start()
  ready.catch((e: unknown) => void vscode.window.showErrorMessage(`AI Pair couldn't start its local server: ${String(e)}`))
  const launcher = writeLauncher(context.extensionPath)
  const starter = new AgentStarter(launcher, context.globalState, path.join(context.extensionPath, "dist", "ompExtension.js"))
  panel.starter = starter
  // The pairing mode: remembered across sessions, applied to the next one; a running session keeps its own.
  let modeId: ModeId =
    (["build", "learn-show", "learn-together", "learn-try"] as ModeId[]).find((id) => id === context.globalState.get("aiPair.mode")) ?? "build"
  const applyMode = (): void => {
    const mode = MODES[modeId]
    controller.setMode(mode.drive ? "learn" : "build", mode.drive)
    panel.showMode({ id: modeId, label: mode.label })
  }
  const setMode = (id: ModeId): void => {
    modeId = id
    void context.globalState.update("aiPair.mode", modeId)
    applyMode()
  }
  panel.mode = {
    set: (id) => {
      const found = (["build", "learn-show", "learn-together", "learn-try"] as ModeId[]).find((m) => m === id)
      if (found) setMode(found)
    },
    choice: () => ({ id: modeId, label: MODES[modeId].label }),
  }
  applyMode()
  const voice = new VoiceEngine(panel, {
    extensionPath: context.extensionPath,
    storagePath: context.globalStorageUri.fsPath,
    config: () => ({
      enabled: config().get("voice.enabled", false),
      model: config().get<VoiceModel>("voice.model", "kokoro"),
      voice: config().get("voice.voice", "af_heart"),
      chatterboxVoice: config().get("voice.chatterboxVoice", ""),
      rate: config().get("voice.rate", 1),
      pace: speed.get(),
      runtimePath: config().get("voice.runtimePath", ""),
    }),
    setEnabled: (on) => void config().update("voice.enabled", on, vscode.ConfigurationTarget.Global),
    setVoice: async (model, voice) => {
      const global = vscode.ConfigurationTarget.Global
      // Each engine remembers its own voice; Phonon has only its built-in one, so there is nothing to store for it.
      if (model === "kokoro") await config().update("voice.voice", voice, global)
      else if (model === "chatterbox") await config().update("voice.chatterboxVoice", voice, global)
      await config().update("voice.model", model, global)
    },
  })
  panel.voice = voice
  controller.setVoice(voice)
  if (config().get("voice.enabled", false)) voice.setEnabled(true)
  const typingSounds = () => {
    const chosen = config().get("typingSounds.switch", "holypanda")
    const key = chosen in SWITCHES ? chosen : "holypanda"
    return {
      enabled: config().get("typingSounds.enabled", false),
      volume: Math.min(1, Math.max(0, config().get("typingSounds.volume", 0.5))),
      sounds: vscode.Uri.joinPath(context.extensionUri, "media", "keys", key),
      name: SWITCHES[key]!.label,
    }
  }
  // The panel's keyboard menu: the switches by name and feel, each heard as it's moved to.
  panel.switches = {
    choices: () => ({
      current: config().get("typingSounds.switch", "holypanda"),
      items: Object.entries(SWITCHES).map(([id, s]) => ({ id, name: s.label, tag: s.detail })),
    }),
    set: (id) => {
      if (!(id in SWITCHES)) return
      void (async () => {
        const global = vscode.ConfigurationTarget.Global
        await config().update("typingSounds.switch", id, global)
        // Choosing a switch is asking to hear it.
        if (!config().get("typingSounds.enabled", false)) await config().update("typingSounds.enabled", true, global)
      })()
    },
    preview: (id) => {
      if (id in SWITCHES) panel.previewTypingSound(vscode.Uri.joinPath(context.extensionUri, "media", "keys", id))
    },
  }
  panel.showTypingSounds(typingSounds())
  controller.setKeys(panel)
  registerServerProvider(context)
  // The author's prepared version of each changed file, for the multi-diff compare command below.
  // Its documents are told to refresh on every compare: a later session prepares other text under
  // the same URIs, and VS Code would otherwise keep showing the first.
  const preparedScheme = "aiPairPrepared"
  const preparedChanged = new vscode.EventEmitter<vscode.Uri>()
  const preparedProvider: vscode.TextDocumentContentProvider = {
    onDidChange: preparedChanged.event,
    // A file the author deleted has no text: the diff shows it emptied against the real file.
    provideTextDocumentContent: (uri) => controller.prepared.find((p) => p.file === uri.fsPath)?.text ?? "",
  }

  context.subscriptions.push(
    preparedChanged,
    vscode.workspace.registerTextDocumentContentProvider(preparedScheme, preparedProvider),
    vscode.commands.registerCommand("aiPair.comparePrepared", () => {
      const prepared = controller.prepared
      if (prepared.length === 0) {
        void vscode.window.showInformationMessage("AI Pair: nothing prepared to compare.")
        return
      }
      // Each entry shows the prepared text on the left and the real file on the right.
      const entries = prepared.map((p) => {
        const fileUri = vscode.Uri.file(p.file)
        const preparedUri = fileUri.with({ scheme: preparedScheme })
        preparedChanged.fire(preparedUri)
        return [fileUri, preparedUri, fileUri]
      })
      void vscode.commands.executeCommand("vscode.changes", "AI Pair: Prepared ↔ Final", entries)
    }),
    { dispose: () => bridge.dispose() },
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) bridge.focused()
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => bridge.writeDiscovery()),
    vscode.commands.registerCommand("aiPair.setUpAgent", () => setUpAgent(launcher)),
    vscode.commands.registerCommand("aiPair.startAgent", () => starter.start()),
    vscode.commands.registerCommand("aiPair.pickStartAgent", () => starter.pick()),
    vscode.commands.registerCommand("aiPair.pickMode", () => panel.openMenu("mode")),
    vscode.commands.registerCommand("aiPair.toggleVoice", () => voice.toggle()),
    vscode.commands.registerCommand("aiPair.selectVoice", () => panel.openMenu("voice")),
    vscode.commands.registerCommand("aiPair.toggleTypingSounds", () =>
      config().update("typingSounds.enabled", !typingSounds().enabled, vscode.ConfigurationTarget.Global),
    ),
    vscode.commands.registerCommand("aiPair.selectTypingSound", () => panel.openMenu("keys")),
    voice,
    editor,
    vscode.window.registerWebviewViewProvider(NarrationPanel.viewId, panel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("aiPair.speed")) {
        controller.setSpeed(speed.get())
        panel.showSpeed(speed.get())
      }
      if (e.affectsConfiguration("aiPair.timing")) controller.setTiming(config().get("timing", {}))
      if (e.affectsConfiguration("aiPair.agentName")) editor.setAgentName(config().get("agentName", "Agent"))
      if (e.affectsConfiguration("aiPair.confirmCommands")) {
        controller.setConfirmCommands(config().get("confirmCommands", true))
      }
      if (e.affectsConfiguration("aiPair.workAheadBatches")) controller.setWorkAhead(config().get("workAheadBatches", 2))
      if (e.affectsConfiguration("aiPair.voice.enabled")) voice.setEnabled(config().get("voice.enabled", false), true)
      if (e.affectsConfiguration("aiPair.voice.model")) voice.followModel(true)
      if (e.affectsConfiguration("aiPair.voice.voice") || e.affectsConfiguration("aiPair.voice.chatterboxVoice")) panel.showVoiceStatus(voice.status())
      if (e.affectsConfiguration("aiPair.typingSounds")) {
        panel.showTypingSounds(typingSounds())
        panel.showSwitchChoices()
      }
    }),
    vscode.commands.registerCommand("aiPair.playDemo", () => {
      if (!vscode.workspace.workspaceFolders?.length) {
        void vscode.window.showErrorMessage("Open a folder first: the demo creates files in ai-pair-demo/.")
        return
      }
      void playDemo(controller, root)
    }),
    vscode.commands.registerCommand("aiPair.togglePause", () => {
      if (controller.isPaused) controller.resume()
      else controller.pause()
    }),
    vscode.commands.registerCommand("aiPair.interrupt", () => controller.userInterrupt()),
    vscode.commands.registerCommand("aiPair.toggleTurn", () => {
      if (controller.turn === "user") controller.handBack()
      else controller.takeTurn()
    }),
    vscode.commands.registerCommand("aiPair.endSession", () => controller.endSession()),
    vscode.commands.registerCommand("aiPair.focusReply", () => panel.focusReply()),
    vscode.commands.registerCommand("aiPair.askAboutSelection", () => panel.focusReply()),
    { dispose: () => controller.disconnect() },
  )
  if (!context.globalState.get("aiPair.offeredSetup")) {
    void context.globalState.update("aiPair.offeredSetup", true)
    void vscode.window
      .showInformationMessage("AI Pair is installed. Connect it to your agent?", "Set Up Agent")
      .then((answer) => answer && setUpAgent(launcher))
  }

  return { controller, playDemo: () => playDemo(controller, root), launcher, ready }
}

export function deactivate(): void {}
