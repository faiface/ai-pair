package ai.pair.terminal

import com.google.gson.JsonObject
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.EDT
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.util.io.FileUtil
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.terminal.frontend.toolwindow.TerminalToolWindowTab
import com.intellij.terminal.frontend.toolwindow.TerminalToolWindowTabsManager
import com.intellij.util.execution.ParametersListUtil
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import org.jetbrains.plugins.terminal.TerminalOptionsProvider
import org.jetbrains.plugins.terminal.TerminalProjectOptionsProvider
import org.jetbrains.plugins.terminal.view.shellIntegration.TerminalBlockId
import org.jetbrains.plugins.terminal.view.shellIntegration.TerminalCommandBlock
import org.jetbrains.plugins.terminal.view.shellIntegration.TerminalCommandExecutionListener
import org.jetbrains.plugins.terminal.view.shellIntegration.TerminalCommandFinishedEvent
import org.jetbrains.plugins.terminal.view.shellIntegration.TerminalCommandStartedEvent
import org.jetbrains.plugins.terminal.view.shellIntegration.getOutputText
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The agent's `run` commands, played in a Terminal tab the programmer can see, output captured through shell
 * integration: packages/vscode/src/terminal.ts on IntelliJ's (experimental) terminal API. See `run` in PROTOCOL.md.
 */
class PairTerminals(private val project: Project) {
    /** Tabs this opened; EDT only. */
    private val owned = mutableListOf<Owned>()
    /** Calls still waiting for an answer, by call id, so `cancel` can answer early. */
    private val waiting = ConcurrentHashMap<Int, Run>()

    fun run(id: Int, command: String, cwd: String, waitMs: Long, answer: (JsonObject) -> Unit) {
        val run = Run(answer) { waiting.remove(id) }
        waiting[id] = run
        // Reading the Terminal's shell blocks, which the EDT forbids.
        ApplicationManager.getApplication().executeOnPooledThread {
            val shell = ParametersListUtil.parse(TerminalProjectOptionsProvider.getInstance(project).shellPath)
            ApplicationManager.getApplication().invokeLater({ start(run, command, cwd, waitMs, shell) }, project.disposed)
        }
    }

    fun cancel(id: Int) {
        val run = waiting[id] ?: return
        ApplicationManager.getApplication().invokeLater { run.finish(ended = false) }
    }

    private fun start(run: Run, command: String, cwd: String, waitMs: Long, shell: List<String>) {
        if (run.answered) return
        val tab = acquire(cwd, shell)
        tab.busy = true
        ToolWindowManager.getInstance(project).getToolWindow("Terminal")?.show()
        val view = tab.tab.view
        view.coroutineScope.launch(Dispatchers.EDT) {
            val integration = withTimeoutOrNull(SHELL_INTEGRATION_MS) { view.shellIntegrationDeferred.await() }
            if (run.answered) {
                tab.busy = false
                return@launch
            }
            if (integration == null) {
                // Without shell integration we can't tell when it ends, so the tab is never reused.
                view.createSendTextBuilder().shouldExecute().send(command)
                return@launch run.answer(JsonObject().apply { addProperty("output", "[output not captured: this terminal has no shell integration]") })
            }

            var ours: TerminalBlockId? = null
            run.outcome = { ended ->
                val block = integration.blocksModel.blocks.firstOrNull { it.id == ours } as? TerminalCommandBlock
                outcome(block?.getOutputText(view.outputModels.regular), if (ended) block?.exitCode else null, running = !ended, tab.shell)
            }
            val listening = Disposer.newDisposable()
            integration.addCommandExecutionListener(listening, object : TerminalCommandExecutionListener {
                override fun commandStarted(event: TerminalCommandStartedEvent) {
                    if (ours == null) ours = event.commandBlock.id
                }

                override fun commandFinished(event: TerminalCommandFinishedEvent) {
                    val block = event.commandBlock
                    if (block.id != ours) return
                    Disposer.dispose(listening)
                    tab.busy = false
                    run.answer(outcome(block.getOutputText(event.outputModel), block.exitCode, running = false, tab.shell))
                }
            })
            view.createSendTextBuilder().shouldExecute().send(command)
            delay(waitMs)
            run.finish(ended = false)
        }
    }

    /** A free tab of ours in [cwd], or a new one running [configured], the Terminal's shell. */
    private fun acquire(cwd: String, configured: List<String>): Owned {
        val manager = TerminalToolWindowTabsManager.getInstance(project)
        owned.retainAll { it.tab in manager.tabs }
        owned.firstOrNull { !it.busy && FileUtil.pathsEqual(it.tab.view.getCurrentDirectory() ?: it.cwd, cwd) }?.let { return it }
        // cmd has no shell integration, so its output could never be captured: the agent's tab uses PowerShell instead.
        val swap = configured.firstOrNull()?.let(::shellName) == "cmd" && TerminalOptionsProvider.instance.shellIntegration
        val shell = if (swap) listOf(POWERSHELL) else configured
        val tab = manager.createTabBuilder().workingDirectory(cwd).apply { if (swap) shellCommand(shell) }
            .tabName("AI Pair").requestFocus(false).createTab()
        return Owned(tab, cwd, shell.firstOrNull()?.let(::shellName)).also { owned += it }
    }
}

/** `bash` for `/bin/bash`, `powershell` for `C:\...\PowerShell.exe`: what the agent writes its commands for. */
private fun shellName(executable: String) =
    executable.substringAfterLast('/').substringAfterLast('\\').lowercase().removeSuffix(".exe")

private class Owned(val tab: TerminalToolWindowTab, val cwd: String, val shell: String?) {
    var busy = false
}

/** One `runCommand` call, answered exactly once. */
private class Run(private val reply: (JsonObject) -> Unit, private val done: () -> Unit) {
    private val replied = AtomicBoolean(false)
    val answered get() = replied.get()

    /** What to answer if the wait ends now: set once the command is sent. */
    var outcome: (ended: Boolean) -> JsonObject = { JsonObject().apply { addProperty("output", ""); addProperty("notStarted", true) } }

    fun finish(ended: Boolean) {
        if (!answered) answer(outcome(ended))
    }

    fun answer(result: JsonObject) {
        if (!replied.compareAndSet(false, true)) return
        done()
        reply(result)
    }
}

private fun outcome(output: String?, exitCode: Int?, running: Boolean, shell: String?) = JsonObject().apply {
    val text = output.orEmpty().replace("\r\n", "\n")
    addProperty("output", text.takeLast(MAX_OUTPUT))
    if (text.length > MAX_OUTPUT) addProperty("truncated", true)
    if (running) addProperty("running", true) else exitCode?.let { addProperty("exitCode", it) }
    shell?.let { addProperty("shell", it) }
}

/** How long a new terminal gets to report shell integration before the command is just typed in. */
private const val SHELL_INTEGRATION_MS = 5000L

/** What the agent's tab runs instead of cmd: the IDE's own default shell on Windows. */
private const val POWERSHELL = "powershell.exe"

/** Output kept for the agent: the tail, where the result and the errors are. */
private const val MAX_OUTPUT = 12_000
