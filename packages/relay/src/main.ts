// pair-mcp: the MCP server the agent harness launches. It forwards tool calls to the editor.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { discoveryDir } from "@ai-pair/protocol"
import authorMarkdown from "../../../AUTHOR_GUIDE.md"
import presenterMarkdown from "../../../PRESENTER_GUIDE.md"
import { EditorLink } from "./link"
import { createServer, guideBody } from "./server"

async function main(): Promise<void> {
  const cwd = process.cwd()
  const guides = { author: guideBody(authorMarkdown), presenter: guideBody(presenterMarkdown) }
  const server = createServer(new EditorLink(cwd, discoveryDir()), guides, cwd)
  await server.connect(new StdioServerTransport())
}

main().catch((e: unknown) => {
  console.error(e)
  process.exit(1)
})
