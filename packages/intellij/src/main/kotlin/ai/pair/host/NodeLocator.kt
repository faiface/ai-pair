package ai.pair.host

import com.intellij.execution.configurations.PathEnvironmentVariableUtil
import com.intellij.openapi.application.PathManager
import com.intellij.openapi.util.SystemInfo
import com.intellij.util.EnvironmentUtil
import java.io.File

/**
 * Finds the Node that runs the host and the relay. An IDE started from a desktop launcher doesn't see the PATH of the
 * programmer's shell, where version managers like nvm put Node, so after PATH this looks where those install it.
 */
object NodeLocator {
    private val executable = if (SystemInfo.isWindows) "node.exe" else "node"

    /** Node's file, or `null` if there is none to be found. */
    fun find(): File? =
        PathEnvironmentVariableUtil.findInPath(executable, EnvironmentUtil.getValue("PATH"), null)
            ?: candidates().firstOrNull { it.isFile && it.canExecute() }

    private fun candidates(): Sequence<File> {
        val home = File(System.getProperty("user.home"))
        fun env(name: String) = System.getenv(name)?.takeIf { it.isNotBlank() }?.let(::File)
        // A version manager's versions, newest first, each with Node at `path`.
        fun versions(dir: File?, path: String) = (dir?.listFiles { f -> f.isDirectory }.orEmpty())
            .sortedWith { a, b -> VERSIONS.compare(b.name, a.name) }
            .map { File(it, path) }
        return sequence {
            yieldAll(versions(File(env("NVM_DIR") ?: File(home, ".nvm"), "versions/node"), "bin/$executable"))
            yieldAll(versions(File(env("FNM_DIR") ?: File(home, ".local/share/fnm"), "node-versions"), "installation/bin/$executable"))
            yieldAll(versions(File(env("ASDF_DATA_DIR") ?: File(home, ".asdf"), "installs/nodejs"), "bin/$executable"))
            yieldAll(versions(File(env("MISE_DATA_DIR") ?: File(home, ".local/share/mise"), "installs/node"), "bin/$executable"))
            yield(File(env("VOLTA_HOME") ?: File(home, ".volta"), "bin/$executable"))
            // The Node the IDE downloads for its own JavaScript support.
            yieldAll(versions(File(PathManager.getConfigPath(), "node/versions"), "bin/$executable"))
            if (SystemInfo.isWindows) {
                yield(File(env("ProgramFiles") ?: File("C:\\Program Files"), "nodejs/$executable"))
            } else {
                for (dir in listOf("/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/snap/bin")) yield(File(dir, executable))
            }
        }
    }

    /** Orders a directory named like `v24.11.1` or `24.18.0` by its numbers. */
    private val VERSIONS = Comparator<String> { a, b -> compare(numbers(a), numbers(b)) }

    private fun numbers(name: String) = Regex("\\d+").findAll(name).map { it.value.toInt() }.toList()

    private fun compare(a: List<Int>, b: List<Int>): Int {
        for (i in 0 until maxOf(a.size, b.size)) {
            val c = a.getOrElse(i) { 0 }.compareTo(b.getOrElse(i) { 0 })
            if (c != 0) return c
        }
        return 0
    }
}
