// The demo session in IntelliJ, as VS Code's demo.ts plays it: sets up its files, then plays the
// shared script (packages/vscode/src/demoScript.ts).

import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { Controller } from "@ai-pair/core"
import { INITIAL_SERVER, playScript, SERVER, TODOS } from "../../vscode/src/demoScript"
import type { RemoteEditor } from "./remote"

export async function playDemo(controller: Controller, editor: RemoteEditor, root: string): Promise<void> {
  // The plugin warns about this; it may not have heard yet that a session started.
  if (controller.isActive) return
  const server = path.join(root, SERVER)
  const todos = path.join(root, TODOS)
  await fs.mkdir(path.dirname(server), { recursive: true })
  await fs.writeFile(server, INITIAL_SERVER)
  await fs.rm(todos, { force: true })
  // VS Code's file system updates open documents by itself; IntelliJ's VFS needs telling.
  await editor.refresh([server, todos])
  await playScript(controller)
}
