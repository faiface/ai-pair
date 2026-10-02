// Plays a short scripted session in the editor window that has <folder> open, through the real relay,
// for trying an editor integration without an agent: bun packages/intellij-host/scripts/drive.ts <folder>

import * as path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { discoveryDir } from "@ai-pair/protocol"
import { EditorLink } from "../../relay/src/link"
import { createServer } from "../../relay/src/server"

const folder = path.resolve(process.argv[2] ?? ".")
const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
await createServer(new EditorLink(folder, discoveryDir()), "", folder).connect(serverSide)
const client = new Client({ name: "drive", version: "0" })
await client.connect(clientSide)

async function call(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const result = await client.callTool({ name, arguments: args })
  const text = (result.content as { text: string }[])[0]!.text
  console.log(`--- ${name}\n${text}`)
  return text
}

await call("start", { task: "Trying the editor integration" })
await call("step", { actions: [
  { say: "A new file, then a function typed into it: its braces first, then the body." },
  { move: { file: "hello.go" } },
  { type_fast: ["package main\n\n", ""] },
  { type: ["func hello() string {\n", "\n}\n"] },
  { type: ["\treturn \"hello from the agent\"", ""] },
  { say: "And a selection, to see how it's drawn." },
  { select: { text: "hello from the agent" } },
  { point: { text: "func hello() string {" } },
  { say: "And this is what pointing at code looks like." },
  { say: "And a command in the terminal." },
  { run: "go version" },
] })
await call("step", { actions: [] })
console.log(">>> Take the turn (Tools > AI Pair > Take / Hand Back the Turn), edit hello.go, then hand the turn back.")
while (!(await call("listen")).includes("handed the turn back")) {}
await call("step", { actions: [
  { say: "I see your edit. One more change, which should land in the right place despite it." },
  { move: { before: "the agent", after: "\"" } },
  { type: [" and you", ""] },
] })
await call("step", { actions: [] })
await call("end", { summary: "That was the scripted session." })
await client.close()
// The relay's WebSocket to the editor stays open after the client closes.
process.exit(0)
