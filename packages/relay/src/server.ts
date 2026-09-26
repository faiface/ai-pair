import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import type { FileContent, Report, ToolName } from "@ai-pair/protocol"
import { RelayError, type EditorLink } from "./link"
import { renderFile, renderReport } from "./render"
import { TOOLS } from "./tools"

/** Always loaded by the harness, so kept short; the full guide comes with `start`. */
export const INSTRUCTIONS = `Live pair programming in the programmer's editor (VS Code with the AI Pair extension). When the programmer asks to pair, call \`start\`: its result includes the pairing guide, which you follow for the whole session. During a session, everything you do through \`step\` appears in their editor at a human pace, with your narration, and they can interrupt or take over at any moment. Never end your turn during a session; call \`listen\` instead.`

/** The agent-facing part of AGENT_GUIDE.md: everything after the first horizontal rule. */
export function agentGuide(markdown: string): string {
  const rule = /\r?\n---\r?\n/.exec(markdown)
  return (rule ? markdown.slice(rule.index + rule[0].length) : markdown).trim()
}

export function startPrompt(task?: string): string {
  const what = task?.trim() ? `The task: ${task.trim()}` : "Ask me what we're working on, unless it's clear from our conversation."
  return `Let's pair program. ${what}\n\nStart a session with the \`start\` tool of the pair server, then follow the guide it returns.`
}

/** `cwd` is the agent's working directory: its paths are relative to it. */
export function createServer(link: EditorLink, guide: string, cwd: string): McpServer {
  const server = new McpServer({ name: "ai-pair", version: "0.0.1" }, { instructions: INSTRUCTIONS })

  const run = async (tool: ToolName, args: object, signal: AbortSignal): Promise<CallToolResult> => {
    try {
      const result = await link.call(tool, args as Record<string, unknown>, signal)
      const text = tool === "read" ? renderFile(result as FileContent) : renderReport(result as Report, tool)
      const content: CallToolResult["content"] = [{ type: "text", text }]
      if (tool === "start") content.push({ type: "text", text: `# Pairing guide\n\n${guide}` })
      return { content }
    } catch (e) {
      const code = e instanceof RelayError ? e.code : "internal"
      const message = e instanceof Error ? e.message : String(e)
      return { isError: true, content: [{ type: "text", text: `${code}: ${message}` }] }
    }
  }

  server.registerTool("start", TOOLS.start, (args, extra) => run("start", { ...args, cwd }, extra.signal))
  server.registerTool("step", TOOLS.step, (args, extra) => run("step", args, extra.signal))
  server.registerTool("listen", TOOLS.listen, (args, extra) => run("listen", args, extra.signal))
  server.registerTool("end", TOOLS.end, (args, extra) => run("end", args, extra.signal))
  server.registerTool("read", TOOLS.read, (args, extra) => run("read", args, extra.signal))

  server.registerPrompt(
    "start",
    {
      description: "Start pair programming: the agent works in your editor at a human pace, narrating as it goes.",
      argsSchema: { task: z.string().optional().describe("What to work on.") },
    },
    ({ task }) => ({ messages: [{ role: "user", content: { type: "text", text: startPrompt(task) } }] }),
  )

  return server
}
