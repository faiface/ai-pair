package ai.pair

import com.intellij.driver.sdk.singleProject
import com.intellij.ide.starter.di.di
import com.intellij.ide.starter.driver.engine.runIdeWithDriver
import com.intellij.ide.starter.ide.IdeProductProvider
import com.intellij.ide.starter.ide.installer.ExistingIdeInstaller
import com.intellij.ide.starter.models.TestCase
import com.intellij.ide.starter.path.GlobalPaths
import com.intellij.ide.starter.plugins.PluginConfigurator
import com.intellij.ide.starter.project.LocalProjectInfo
import com.intellij.ide.starter.runner.Starter
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.kodein.di.DI
import org.kodein.di.bindSingleton
import java.io.File
import java.util.concurrent.TimeUnit
import kotlin.io.path.Path
import kotlin.io.path.createTempDirectory

// Runs a real IDE with the plugin (Starter), plays the programmer in it (Driver) and the agent through the launcher, as
// VS Code's test/integration.ts does in VS Code: the demo, a programmer edit interrupting, the agent's file saved
// verbatim (its own saves and the IDE's autosave), taking and handing back the turn, and a `run`. Changes by others
// aren't reported as such yet (see the plan's Known bugs), so VS Code's scenario for them isn't here.
// ./gradlew integrationTest -PplatformPath=<IDE>: one IDE start, about a minute and a half.

const val EXPECTED_TODOS = """export interface Todo {
  id: number;
  title: string;
  done: boolean;
}

const todos: Todo[] = [];
let nextId = 1;

export function createTodo(title: string): Todo {
  const todo = { id: nextId++, title, done: false };
  todos.push(todo);
  return todo;
}

export function listTodos(): Todo[] {
  return todos;
}
"""

const val EXPECTED_SERVER = """import express from "express";
import { createTodo, listTodos } from "./todos";

const app = express();
app.use(express.json());

app.post("/todos", (req, res) => {
  const todo = createTodo(req.body.title);
  res.status(201).json(todo);
});

app.get("/todos", (req, res) => {
  res.json(listTodos());
});

app.listen(3000, () => console.log("Listening on http://localhost:3000"));
"""

/** Batch numbers count on across sessions. */
val COMPLETED = Regex("""Batch \d+ completed""")

/** GoLand's own error, logged at every start, that names the plugin only because the panel asks whether JCEF works. */
const val JCEF_STARTUP_ERROR = "com.intellij.ui.jcef.JBCefApp\$Holder <clinit> requests com.intellij.util.net.internal.ProxyMigrationService instance. Class initialization must not depend on services. Consider using instance of the service on-demand instead."

class IntegrationTest {
    init {
        val build = Path(System.getProperty("ai.pair.build"))
        di = DI {
            extend(di)
            bindSingleton<GlobalPaths>(overrides = true) { object : GlobalPaths(build) {} }
        }
    }

    @Test
    fun pairs() {
        val root = createTempDirectory("ai-pair-project-").toFile()
        val home = createTempDirectory("ai-pair-home-").toFile()
        try {
            val product = IdeProductProvider.GO.copy(getInstaller = { ExistingIdeInstaller(Path(System.getProperty("ai.pair.ide"))) })
            val context = Starter.newContext("pairs", TestCase(product, LocalProjectInfo(root.toPath())))
                .apply { PluginConfigurator(this).installPluginFromPath(Path(System.getProperty("path.to.build.plugin"))) }
                .applyVMOptionsPatch { withEnv("AI_PAIR_HOME", home.path) }
            val run = context.runIdeWithDriver().useDriverAndCloseIde {
                // The plugin starts the host once the project is open.
                until("the host's discovery file") { File(home, "windows").listFiles()?.isNotEmpty() == true }
                val ide = Programmer(this, singleProject(), root)
                // Commands run without asking, as in host.test.ts: the panel's Run button isn't the test's to press.
                ide.command("setConfirmCommands", """{"confirm": false}""")
                val launcher = utility(AgentSetup::class).writeLauncher().getPath()
                Agent(launcher, root, home).use { agent -> pair(ide, agent, root) }
            }
            val errors = File(run.runContext.logsDir.toFile(), "errors").listFiles().orEmpty()
                .map { File(it, "message.txt").readText().trim() }
                .filter { it.lineSequence().first() != JCEF_STARTUP_ERROR }
            assertEquals(emptyList<String>(), errors, "the IDE logged errors")
        } finally {
            root.deleteRecursively()
            home.deleteRecursively()
        }
    }

    private fun pair(ide: Programmer, agent: Agent, root: File) {
        assertEquals(listOf("end", "listen", "read", "start", "step"), agent.tools().sorted())
        fun call(name: String, args: String = "{}") = agent.call(name, args).get(60, TimeUnit.SECONDS)
        fun step(actions: String = "[]") = agent.step(actions).get(60, TimeUnit.SECONDS)
        // A new file is saved with the OS's line separator; the document always has \n.
        fun disk(name: String) = File(root, name).readText().replace("\r\n", "\n")

        // The demo, sped up. If our own edits were mistaken for the programmer's, it would stop early.
        ide.command("setSpeed", """{"speed": 20}""")
        val started = System.currentTimeMillis()
        ide.command("playDemo")
        until("the demo to start") { ide.host.getSessionActive() }
        until("the demo to end", 120_000) { !ide.host.getSessionActive() }
        println("demo played in ${System.currentTimeMillis() - started} ms")
        assertEquals(EXPECTED_TODOS, ide.buffer("ai-pair-demo/src/todos.ts"))
        assertEquals(EXPECTED_SERVER, ide.buffer("ai-pair-demo/src/server.ts"))
        assertEquals(EXPECTED_SERVER, disk("ai-pair-demo/src/server.ts"), "saved after each batch")

        // A programmer edit mid-typing interrupts, and the report shows exactly what was typed.
        ide.command("setSpeed", """{"speed": 1}""")
        val alphabet = "abcdefghijklmnopqrstuvwxyz"
        call("start", """{"task": "interrupt test"}""")
        step("""[{"move": {"file": "scratch.txt", "line": 1, "to": "line_end"}}, {"type": "$alphabet▌"}]""")
        val pending = agent.step("""[{"type": "!▌"}]""")
        // Past the pauses around moving into a new file (~1 s), and into the typing.
        Thread.sleep(1500)
        ide.type("scratch.txt", 0, "X")
        val report = pending.get(60, TimeUnit.SECONDS)
        // What's left of the cut `type` comes back first, ready to resubmit.
        val left = Regex("""Batch \d+ interrupted, in scratch\.txt:\n[\s\S]*?Not played:\n {2}\{"type":"([a-z]*)▌"}""").find(report)
            ?.groupValues?.get(1) ?: error("Not an interrupted typing:\n$report")
        val typed = alphabet.dropLast(left.length)
        assertTrue(typed.isNotEmpty() && left.isNotEmpty(), "left: $left")
        assertTrue(report.startsWith("The programmer edited scratch.txt:\n"), report)
        assertTrue(Regex("""Batch \d+ discarded\.""").containsMatchIn(report), report)
        assertEquals("X$typed", ide.buffer("scratch.txt"))
        assertTrue("1  X$typed▌\n   (end of file, with no newline after the last line)" in report, report)
        call("end", """{"summary": "Bye."}""")
        println("interrupted after typing \"$typed\"")

        // Saves keep what the agent typed, though IntelliJ strips trailing spaces on save by default: a strip would
        // be an edit the agent didn't make, and the batch planned behind it would be discarded. Its own saves, and
        // the IDE's autosave of its file during the session, here while it pauses to let its words be read.
        call("start", """{"task": "verbatim saves"}""")
        step("""[
            {"move": {"file": "tool.txt", "line": 1, "to": "line_end"}},
            {"type": "abc\nend   ▌"},
            {"say": "That line ends in spaces, and the IDE saves it by itself while you read this, as it does when its window loses focus."}
        ]""")
        // The agent creates the file as it moves into it.
        until("the agent's typing") { runCatching { ide.buffer("tool.txt") }.getOrNull() == "abc\nend   " }
        ide.saveAll()
        assertEquals("abc\nend   ", disk("tool.txt"), "autosaved verbatim")
        val saved = step("""[{"type": "\n▌"}]""") + "\n" + step()
        assertTrue(Regex("""Batch \d+ completed[\s\S]*Batch \d+ completed""").containsMatchIn(saved), saved)
        assertTrue("edited" !in saved && "was changed" !in saved, saved)
        assertEquals("abc\nend   \n", disk("tool.txt"))
        call("end", """{"summary": "Bye."}""")
        println("the agent's saves are verbatim")
        ide.command("setSpeed", """{"speed": 20}""")

        // The programmer takes the turn, edits, and hands it back; the agent's next move still lands where it meant.
        call("start", """{"task": "turns"}""")
        step("""[
            {"move": {"file": "hello.go", "line": 1, "to": "line_end"}},
            {"type_fast": "package main\n\n▌"},
            {"type": "func hello() string {\n▌\n}\n"},
            {"type": "\treturn \"hello from the agent\"▌"}
        ]""")
        assertTrue(COMPLETED.containsMatchIn(step()))
        val listening = agent.call("listen")
        ide.command("toggleTurn")
        assertTrue("The programmer took the turn." in listening.get(60, TimeUnit.SECONDS))
        val end = ide.buffer("hello.go").length
        ide.type("hello.go", end, "// mine")
        ide.command("toggleTurn")
        var heard = ""
        while ("handed the turn back" !in heard) heard += call("listen")
        assertTrue("The programmer edited hello.go:" in heard, heard)
        step("""[{"move": {"at": "the agent▌\""}}, {"type": " and you▌"}]""")
        assertTrue(COMPLETED.containsMatchIn(step()))
        assertEquals(
            "package main\n\nfunc hello() string {\n\treturn \"hello from the agent and you\"\n}\n// mine",
            ide.buffer("hello.go"),
        )
        call("end", """{"summary": "Bye."}""")
        println("turns taken and handed back")

        // A command in the agent's terminal tab, its output captured.
        call("start", """{"task": "run"}""")
        // Quoted: PowerShell's echo prints each argument on a line of its own.
        step("""[{"run": "echo 'hello from run'"}]""")
        val ran = step()
        assertTrue(Regex("""Ran `echo 'hello from run'` in \w+: exited with 0\. Output:\n```\n[^`]*hello from run\n```""").containsMatchIn(ran), ran)
        call("end", """{"summary": "Bye."}""")
        println("run captured")
    }
}
