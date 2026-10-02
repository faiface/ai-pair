package ai.pair.setup

import com.google.gson.GsonBuilder
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.intellij.execution.configurations.PathEnvironmentVariableUtil
import com.intellij.ide.plugins.PluginManagerCore
import com.intellij.openapi.extensions.PluginId
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.util.SystemInfo
import com.intellij.terminal.frontend.toolwindow.TerminalToolWindowTabsManager
import com.intellij.util.EnvironmentUtil
import java.awt.datatransfer.StringSelection
import java.io.File

/** The launcher for pair-mcp, and connecting it to the programmer's agent: packages/vscode/src/setup.ts for IntelliJ. */
object AgentSetup {
    /**
     * Writes a launcher at a fixed path that runs this plugin's relay with Node, so the agent's MCP configuration never
     * changes. VS Code's extension writes the same file; either one works, as long as both ship the same relay.
     */
    fun writeLauncher(): File {
        val home = System.getenv("AI_PAIR_HOME")?.let(::File) ?: File(System.getProperty("user.home"), ".ai-pair")
        val bin = File(home, "bin").apply { mkdirs() }
        val plugin = PluginManagerCore.getPlugin(PluginId.getId("ai.pair")) ?: error("The AI Pair plugin isn't loaded.")
        val relay = plugin.pluginPath.resolve("host/relay.cjs").toString()
        val node = PathEnvironmentVariableUtil.findInPath(if (SystemInfo.isWindows) "node.exe" else "node", EnvironmentUtil.getValue("PATH"), null)?.path ?: "node"
        if (SystemInfo.isWindows) {
            return File(bin, "pair-mcp.cmd").apply { writeText("@echo off\r\n\"$node\" \"$relay\" %*\r\n") }
        }
        return File(bin, "pair-mcp").apply {
            writeText("#!/bin/sh\nexec \"$node\" \"$relay\" \"\$@\"\n")
            setExecutable(true)
        }
    }

    fun setUpAgent(project: Project) {
        val launcher = writeLauncher().path
        val choice = Messages.showDialog(
            project,
            "Which agent do you pair with?\n\n" +
                "Claude Code (CLI): all projects, runs `claude mcp add` in a terminal.\n" +
                "Claude Code (this project): writes .mcp.json here; also works in the Claude desktop app.\n" +
                "Another agent: copies an MCP server configuration to the clipboard.",
            "Set Up Agent",
            arrayOf("Claude Code (CLI)", "Claude Code (this project)", "Another agent", "Cancel"),
            0,
            Messages.getQuestionIcon(),
        )
        when (choice) {
            0 -> {
                val tab = TerminalToolWindowTabsManager.getInstance(project).createTabBuilder().tabName("AI Pair setup").createTab()
                tab.view.createSendTextBuilder().shouldExecute().send("claude mcp add --scope user pair -- ${quoted(launcher)}")
                Messages.showInfoMessage(project, "Once it's added, restart Claude Code and ask it to pair.", "Set Up Agent")
            }
            1 -> {
                val file = File(project.basePath ?: return, ".mcp.json")
                val config = runCatching { JsonParser.parseString(file.readText()).asJsonObject }.getOrElse { JsonObject() }
                val servers = config.getAsJsonObject("mcpServers") ?: JsonObject().also { config.add("mcpServers", it) }
                servers.add("pair", JsonObject().apply {
                    addProperty("type", "stdio")
                    addProperty("command", portable(launcher))
                })
                file.writeText(GsonBuilder().setPrettyPrinting().create().toJson(config) + "\n")
                Messages.showInfoMessage(project, "Wrote .mcp.json. Start a new Claude Code session in this folder, approve the pair server, and ask it to pair.", "Set Up Agent")
            }
            2 -> {
                val server = JsonObject().apply { addProperty("command", launcher) }
                val config = JsonObject().apply { add("mcpServers", JsonObject().apply { add("pair", server) }) }
                CopyPasteManager.getInstance().setContents(StringSelection(GsonBuilder().setPrettyPrinting().create().toJson(config)))
                Messages.showInfoMessage(project, "Copied. Add it to your agent's MCP configuration: a stdio server named \"pair\" running $launcher.", "Set Up Agent")
            }
        }
    }
}

private fun quoted(path: String): String = when {
    SystemInfo.isWindows -> if (path.contains(' ')) "\"$path\"" else path
    else ->
        if (Regex("[\\s\"'\$`\\\\]").containsMatchIn(path)) "\"" + path.replace(Regex("([\"\\\\\$`])"), "\\\\\$1") + "\"" else path
}

/** The launcher's path with the home directory as a variable, so the file works for anyone who clones the project. */
private fun portable(launcher: String): String {
    val home = System.getProperty("user.home")
    if (!launcher.startsWith(home + File.separator)) return launcher
    return (if (SystemInfo.isWindows) "\${USERPROFILE}" else "\${HOME}") + launcher.substring(home.length)
}
