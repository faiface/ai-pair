import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import type { AuthorReport, FileContent, Report, ToolName } from "@ai-pair/protocol"
import { RelayError, type EditorLink } from "./link"
import { renderAuthorReport, renderFile, renderReport } from "./render"
import { modeGuide } from "./modeGuide"
import { TOOLS } from "./tools"

/** The extension's version, which the build defines; unbuilt, as in tests, there's none. */
declare const AI_PAIR_VERSION: string | undefined
const VERSION = typeof AI_PAIR_VERSION === "string" ? AI_PAIR_VERSION : "dev"

/** Always loaded by the harness, so kept short; the full guides come with `start` and `join`. */
export const INSTRUCTIONS = `Live pair programming in the programmer's editor (VS Code with the AI Pair extension). When the programmer asks to pair, call \`start\` with your working directory right away, before reading their code: you're the session's author, and its result includes the author guide, which you follow for the whole session. You work in a private copy and record stages; a presenter plays them in the programmer's editor at a human pace, with narration, and the programmer can interrupt or take over at any moment. When you're asked to present a session instead, call \`join\` and follow the presenter guide it returns. Never end your turn during a session: the author calls \`wait\`, the presenter \`listen\`.`

/** The agent-facing part of a guide: everything after the first horizontal rule. */
export function guideBody(markdown: string): string {
  const rule = /\r?\n---\r?\n/.exec(markdown)
  return (rule ? markdown.slice(rule.index + rule[0].length) : markdown).trim()
}

export type Guides = { author: string; presenter: string }

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
export function createServer(link: EditorLink, guides: Guides, cwd: string): McpServer {
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

  const render = (tool: ToolName, result: unknown): string => {
    switch (tool) {
      case "read":
        return renderFile(result as FileContent)
      case "tell_author":
        return "The author will hear it."
      case "start":
      case "stage":
      case "wait":
      case "tell_presenter":
        return renderAuthorReport(result as AuthorReport, tool)
      default:
        return renderReport(result as Report, tool)
    }
  }

  const run = async (tool: ToolName, args: object, signal: AbortSignal, before?: () => Promise<object>): Promise<CallToolResult> => {
    try {
      if (before) args = { ...args, ...(await before()) }
      const result = await link.call(tool, args as Record<string, unknown>, signal)
      const content: CallToolResult["content"] = [{ type: "text", text: render(tool, result) }]
      if (tool === "start" || tool === "join") {
        const guide = tool === "start" ? guides.author : guides.presenter
        content.push({ type: "text", text: `# ${tool === "start" ? "Author" : "Presenter"} guide\n\n${guide}` })
        // The mode page comes last: it refines the guide for this session, so it's read with it fresh.
        const page = modeGuide(result as Report | AuthorReport)
        if (page) content.push({ type: "text", text: page })
      }
      return { content }
    } catch (e) {
      const code = e instanceof RelayError ? e.code : "internal"
      const message = e instanceof Error ? e.message : String(e)
      return { isError: true, content: [{ type: "text", text: `${code}: ${message}` }] }
    }
  }

  // The agent's working directory is found the same way for the author and the presenter, which
  // may run in a relay of its own: the one it gives, the harness's roots, and the relay's own.
  const locate = async (given: string | undefined) => {
    const folders = [...(given && path.isAbsolute(given) ? [given] : []), ...(await roots()), cwd]
    return link.locate(folders)
  }
  server.registerTool("start", TOOLS.start, ({ cwd: given, ...args }, extra) =>
    run("start", args, extra.signal, async () => ({ cwd: await locate(given) })),
  )
  server.registerTool("stage", TOOLS.stage, (args, extra) => run("stage", args, extra.signal))
  server.registerTool("wait", TOOLS.wait, (args, extra) => run("wait", args, extra.signal))
  server.registerTool("tell_presenter", TOOLS.tell_presenter, (args, extra) => run("tell_presenter", args, extra.signal))
  server.registerTool("join", TOOLS.join, ({ cwd: given }, extra) =>
    run("join", {}, extra.signal, async () => {
      // A subagent that shares the author's relay is on the author's window already: locating
      // anew from its own folder could switch windows and cut the author off.
      if (!link.connected) await locate(given)
      return {}
    }),
  )
  server.registerTool("tell_author", TOOLS.tell_author, (args, extra) => run("tell_author", args, extra.signal))
  server.registerTool("step", TOOLS.step, (args, extra) => run("step", args, extra.signal))
  server.registerTool("listen", TOOLS.listen, (args, extra) => run("listen", args, extra.signal))
  server.registerTool("end", TOOLS.end, (args, extra) => run("end", args, extra.signal))
  server.registerTool("read", TOOLS.read, (args, extra) => run("read", args, extra.signal))

  server.registerPrompt(
    "start",
    {
      description: "Start pair programming: the agent works ahead in a private copy, and its work plays in your editor at a human pace, narrated.",
      argsSchema: { task: z.string().optional().describe("What to work on.") },
    },
    ({ task }) => ({ messages: [{ role: "user", content: { type: "text", text: startPrompt(task) } }] }),
  )

  return server
}
