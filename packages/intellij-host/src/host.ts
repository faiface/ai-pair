// The host process: the unmodified Controller and Bridge, with the editor and the narration panel on
// the other side of stdio, in the IntelliJ plugin.

import { createInterface } from "node:readline"
import type { Readable, Writable } from "node:stream"
import { Bridge, Controller } from "@ai-pair/core"
import { discoveryDir } from "@ai-pair/protocol"
import { Link, RemoteEditor } from "./remote"
import { panelHtml } from "../../vscode/src/panelHtml"
import type { Init, PluginMessage } from "./wire"

/** Serves the plugin on the other end of `input` and `output`, until `input` ends. */
export async function runHost(input: Readable, output: Writable, dir = discoveryDir()): Promise<void> {
  const link = new Link(output)
  let session: Session | undefined
  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    if (!line.trim()) continue
    const m = JSON.parse(line) as PluginMessage
    if (m.type === "init") session = await open(m, link, dir)
    else if (m.type === "result") link.answer(m.id, m.result)
    else if (m.type === "error") link.answer(m.id, undefined, m.message)
    else if (session) command(session, m)
  }
  link.close()
  session?.controller.disconnect()
  session?.bridge.dispose()
}

type Session = { controller: Controller; bridge: Bridge; editor: RemoteEditor }
type CommandMessage = Extract<PluginMessage, { type: "command" }>

async function open(init: Init, link: Link, dir: string): Promise<Session> {
  const editor = new RemoteEditor(link, init.root, init.workspaceFolders)
  const controller = new Controller(editor, { post: (event) => link.notify("post", { event }) })
  controller.setSpeed(init.speed)
  controller.setTiming(init.timing)
  controller.setConfirmCommands(init.confirmCommands)
  const bridge = new Bridge(controller, { dir, workspaceFolders: () => editor.folders })
  await bridge.start()
  link.send({ type: "ready", discovery: bridge.file, panel: panelHtml("'self'") })
  return { controller, bridge, editor }
}

function command({ controller: c, bridge, editor }: Session, m: CommandMessage): void {
  switch (m.method) {
    case "userEdit": {
      const { file, before, changes } = m.args
      const after = changes.reduce((text, change) => text.slice(0, change.offset) + change.text + text.slice(change.offset + change.deleteLength), before)
      return c.userEdit(file, before, after, changes)
    }
    case "userMessage":
      return c.userMessage(m.args.text, m.args.selection)
    case "userInterrupt":
      return c.userInterrupt()
    case "pause":
      return c.pause(m.args.reason)
    case "resume":
      return c.resume(m.args.reason)
    case "togglePause":
      return c.isPaused ? c.resume() : c.pause()
    case "takeTurn":
      return c.takeTurn()
    case "handBack":
      return c.handBack(m.args.message, m.args.selection)
    case "toggleTurn":
      c.resume()
      return c.turn === "user" ? c.handBack(m.args.message, m.args.selection) : c.takeTurn()
    case "endSession":
      return c.endSession()
    case "decideRun":
      return c.decideRun(m.args.id, m.args.run, m.args.remember)
    case "setSpeed":
      return c.setSpeed(m.args.speed)
    case "setTiming":
      return c.setTiming(m.args.overrides)
    case "setConfirmCommands":
      return c.setConfirmCommands(m.args.confirm)
    case "focused":
      return bridge.focused()
    case "setWorkspaceFolders":
      editor.folders = m.args.folders
      return bridge.writeDiscovery()
  }
}
