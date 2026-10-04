package ai.pair.terminal

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File
import java.util.concurrent.TimeUnit

// A tab an earlier `run` left in another directory (`cd sub; …`) is reused, moved back to the session's directory as
// part of the agent's command, rather than a new tab opened for each `run`.

/** A directory name that would end a careless quote in either kind of shell. */
const val AWKWARD = "it's \u2018quoted\u2019 dir"

val WINDOWS = System.getProperty("os.name").startsWith("Windows")

class PairTerminalsTest {
    @Test
    fun `PowerShell moves with Set-Location, quotes doubled`() {
        assertEquals("Set-Location -LiteralPath 'C:\\proj'; go version", inDirectory("go version", "C:\\proj", "powershell"))
        assertEquals(
            "Set-Location -LiteralPath 'C:\\it''s \u2018\u2018quoted\u2019\u2019 dir'; go version",
            inDirectory("go version", "C:\\$AWKWARD", "pwsh"),
        )
    }

    @Test
    fun `POSIX shells move with cd, quotes closed and reopened`() {
        for (shell in listOf("bash", "zsh", "sh")) {
            assertEquals("cd -- '/proj' && go version", inDirectory("go version", "/proj", shell), shell)
        }
        assertEquals("cd -- '/it'\\''s \u2018quoted\u2019 dir' && go version", inDirectory("go version", "/$AWKWARD", "bash"))
    }

    @Test
    fun `other shells get a new tab instead`() {
        for (shell in listOf("fish", "cmd", "wsl", null)) assertNull(inDirectory("go version", "/proj", shell), shell)
    }

    @Test
    fun `PowerShell runs the command in the directory`(@TempDir temp: File) {
        assumeTrue(WINDOWS, "PowerShell is Windows's")
        // Windows PowerShell reads a script without a byte order mark in the ANSI code page.
        val script = File(temp, "line.ps1")
        val output = ranIn(temp, "powershell", { script.writeText("\uFEFF$it\n") }, listOf("powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script.path))
        assertEquals("in the directory", output)
    }

    @Test
    fun `bash runs the command in the directory`(@TempDir temp: File) {
        // On Windows, the bash on the PATH may be WSL's, which doesn't take Windows paths.
        assumeTrue(!WINDOWS, "bash outside Windows")
        val script = File(temp, "line.sh")
        assertEquals("in the directory", ranIn(temp, "bash", { script.writeText("$it\n") }, listOf("bash", script.path)))
    }

    /**
     * What `cat marker.txt` prints, moved by [inDirectory] into a directory named [AWKWARD] from another one: [write]
     * puts the line in a script, as typed into the Terminal, and [command] runs it.
     */
    private fun ranIn(temp: File, shell: String, write: (String) -> Unit, command: List<String>): String {
        val dir = File(temp, AWKWARD).apply { mkdirs() }
        File(dir, "marker.txt").writeText("in the directory\n")
        val elsewhere = File(temp, "elsewhere").apply { mkdirs() }
        write(inDirectory("cat marker.txt", dir.path, shell)!!)
        val process = ProcessBuilder(command).directory(elsewhere).redirectErrorStream(true).start()
        val output = process.inputStream.bufferedReader(Charsets.UTF_8).readText()
        check(process.waitFor(30, TimeUnit.SECONDS)) { "$shell didn't finish" }
        assertEquals(0, process.exitValue(), output)
        return output.trim()
    }
}
