import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import type { FileContent, Report, ToolName } from "@ai-pair/protocol"
import { RelayError, type EditorLink } from "./link"
import { renderFile, renderReport } from "./render"
import { TOOLS } from "./tools"

/** The extension's version, which the build defines; unbuilt, as in tests, there's none. */
declare const AI_PAIR_VERSION: string | undefined
const VERSION = typeof AI_PAIR_VERSION === "string" ? AI_PAIR_VERSION : "dev"

/** Always loaded by the harness, so kept short; the full guide comes with `start`. */
export const INSTRUCTIONS = `Live pair programming in the programmer's editor (VS Code or a JetBrains IDE, with AI Pair installed). When the programmer asks to pair, call \`start\` with your working directory: its result includes the pairing guide, which you follow for the whole session. During a session, everything you do through \`step\` appears in their editor at a human pace, with your narration, and they can interrupt or take over at any moment. Never end your turn during a session; call \`listen\` instead.`

/** The agent-facing part of AGENT_GUIDE.md: everything after the first horizontal rule. */
export function agentGuide(markdown: string): string {
  const rule = /\r?\n---\r?\n/.exec(markdown)
  return (rule ? markdown.slice(rule.index + rule[0].length) : markdown).trim()
}

export function startPrompt(task?: string): string {
  const what = task?.trim() ? `The task: ${task.trim()}` : "Ask me what we're working on, unless it's clear from our conversation."
  return `Let's pair program. ${what}\n\nStart a session with the \`start\` tool of the pair server, then follow the guide it returns.`
}

/** How long to wait for the harness to list its roots: one that claims to but never answers mustn't block `start`. */
const ROOTS_MS = 2000

/**
 * `cwd` is the relay's working directory. The agent's paths are relative to its own, which `start`
 * finds as the first of these that a VS Code window has open: the one the agent gives, the harness's
 * roots, and `cwd`. Some harnesses start MCP servers in `/` or in their own install folder.
 */
export function createServer(link: EditorLink, guide: string, cwd: string): McpServer {
  const server = new McpServer({ name: "ai-pair", version: VERSION }, { instructions: INSTRUCTIONS })

  const roots = async (): Promise<string[]> => {
    if (!server.server.getClientCapabilities()?.roots) return []
    try {
      const { roots } = await server.server.listRoots(undefined, { timeout: ROOTS_MS })
      return roots.filter((r) => r.uri.startsWith("file:")).map((r) => fileURLToPath(r.uri))
    } catch {
      return []
    }
  }

  const run = async (tool: ToolName, args: object, signal: AbortSignal, before?: () => Promise<object>): Promise<CallToolResult> => {
    try {
      if (before) args = { ...args, ...(await before()) }
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

  server.registerTool("start", TOOLS.start, ({ cwd: given, ...args }, extra) =>
    run("start", args, extra.signal, async () => {
      const folders = [...(given && path.isAbsolute(given) ? [given] : []), ...(await roots()), cwd]
      return { cwd: link.locate(folders) }
    }),
  )
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
