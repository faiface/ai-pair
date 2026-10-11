package ai.pair.host

import ai.pair.editor.PairEditor
import ai.pair.panel.NarrationPanel
import ai.pair.settings.PairSettings
import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.intellij.execution.ExecutionException
import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.ide.plugins.PluginManagerCore
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.Disposable
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.extensions.PluginId
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.util.io.FileUtil
import java.io.Writer
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/** Runs the Node host for one project and speaks its stdio protocol: packages/intellij-host/src/wire.ts. */
@Service(Service.Level.PROJECT)
class PairHost(private val project: Project) : Disposable {
    private val log = logger<PairHost>()
    val editor = PairEditor(project, this)
    val panel = NarrationPanel(project, this).also { Disposer.register(this, it) }
    private var process: Process? = null
    private var input: Writer? = null

    val sessionActive get() = editor.sessionActive

    fun start() {
        val root = project.basePath?.let(FileUtil::toSystemDependentName) ?: return
        val plugin = PluginManagerCore.getPlugin(PluginId.getId("ai.pair")) ?: return
        val script = plugin.pluginPath.resolve("host/intellij-host.cjs")
        val node = NodeLocator.find()
        if (node == null) {
            hostFailed("Node.js wasn't found. Install Node 20 or later, or start the IDE from a shell where `node` works, then reopen the project.")
            return
        }
        val process = try {
            GeneralCommandLine(node.path, script.toString())
                .withParentEnvironmentType(GeneralCommandLine.ParentEnvironmentType.CONSOLE)
                .withWorkDirectory(root)
                .createProcess()
        } catch (e: ExecutionException) {
            log.warn("AI Pair host didn't start", e)
            hostFailed("Couldn't start the host with ${node.path}: ${e.message}")
            return
        }
        this.process = process
        input = process.outputStream.bufferedWriter(Charsets.UTF_8)
        thread(name = "AI Pair host", isDaemon = true) { read(process) }
        thread(name = "AI Pair host log", isDaemon = true) {
            process.errorStream.bufferedReader(Charsets.UTF_8).forEachLine { log.warn("host: $it") }
        }
        val settings = service<PairSettings>().effective(project)
        editor.setAgentName(settings.agentName)
        send(message("init") {
            addProperty("root", root)
            add("workspaceFolders", JsonArray().apply { add(root) })
            addProperty("speed", settings.speed)
            add("timing", PairSettings.parseTiming(settings.timing) ?: JsonObject())
            addProperty("confirmCommands", settings.confirmCommands)
        })
    }

    /** Tells the programmer the host isn't running, so pairing isn't available; this isn't a plugin error. */
    private fun hostFailed(reason: String) {
        log.warn("AI Pair host not started: $reason")
        NotificationGroupManager.getInstance().getNotificationGroup("AI Pair")
            .createNotification("AI Pair can't start", reason, NotificationType.ERROR)
            .notify(project)
    }

    /** The settings changed, on the settings page or the panel's speed menu. */
    fun settingsChanged(old: PairSettings.Values, new: PairSettings.Values) {
        if (new.speed != old.speed) {
            command("setSpeed", JsonObject().apply { addProperty("speed", new.speed) })
            panel.showSpeed(new.speed)
        }
        if (new.timing != old.timing) {
            command("setTiming", JsonObject().apply { add("overrides", PairSettings.parseTiming(new.timing) ?: JsonObject()) })
        }
        if (new.confirmCommands != old.confirmCommands) {
            command("setConfirmCommands", JsonObject().apply { addProperty("confirm", new.confirmCommands) })
        }
        if (new.agentName != old.agentName) editor.setAgentName(new.agentName)
    }

    fun answer(id: Int, result: JsonElement) = send(message("result") { addProperty("id", id); add("result", result) })

    fun fail(id: Int, error: String) = send(message("error") { addProperty("id", id); addProperty("message", error) })

    fun command(method: String, args: JsonObject = JsonObject()) =
        send(message("command") { addProperty("method", method); add("args", args) })

    @Synchronized
    private fun send(message: JsonObject) {
        val input = input ?: return
        try {
            input.write("$message\n")
            input.flush()
        } catch (e: java.io.IOException) {
            log.warn("AI Pair host is gone", e)
        }
    }

    private fun read(process: Process) {
        process.inputStream.bufferedReader(Charsets.UTF_8).forEachLine { line ->
            val m = JsonParser.parseString(line).asJsonObject
            when (m["type"].asString) {
                "ready" -> {
                    log.info("AI Pair host ready: ${m["discovery"].asString}")
                    panel.setPage(m["panel"].asString)
                }
                "call" -> editor.call(m["id"].asInt, m["method"].asString, m["args"].asJsonObject)
                "cancel" -> editor.cancel(m["id"].asInt)
                "notice" -> {
                    val args = m["args"].asJsonObject
                    if (m["method"].asString == "post") panel.post(args["event"].asJsonObject)
                    editor.notice(m["method"].asString, args)
                }
            }
        }
        log.info("AI Pair host exited")
    }

    override fun dispose() {
        synchronized(this) {
            input?.close()
            input = null
        }
        process?.let { if (!it.waitFor(2, TimeUnit.SECONDS)) it.destroy() }
    }
}

private fun message(type: String, build: JsonObject.() -> Unit) =
    JsonObject().apply {
        addProperty("type", type)
        build()
    }
