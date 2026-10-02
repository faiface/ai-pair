package ai.pair.settings

import ai.pair.host.PairHost
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.components.service
import com.intellij.openapi.components.serviceIfCreated
import com.intellij.openapi.project.Project
import com.intellij.openapi.project.ProjectManager

/**
 * The counterpart of VS Code's `aiPair.*` settings (packages/vscode/package.json), in the same two
 * levels: these, for all projects (VS Code's user settings), and each project's
 * `PairProjectSettings` (its `.vscode/settings.json`).
 */
@Service(Service.Level.APP)
@State(name = "AiPairSettings", storages = [Storage("aiPair.xml")])
class PairSettings : PersistentStateComponent<PairSettings.Values> {
    data class Values(
        var speed: Double = 1.0,
        var agentName: String = "Agent",
        /** A JSON object of overrides, the shape of packages/core/src/timing.ts. */
        var timing: String = "{}",
        var confirmCommands: Boolean = true,
    )

    @Volatile
    private var values = Values()

    override fun getState() = values

    override fun loadState(state: Values) {
        values = state
    }

    /**
     * The values in effect in `project`: its overrides over these. `confirmCommands` is never
     * overridden, as VS Code's is application-scoped: a project mustn't turn it off.
     */
    fun effective(project: Project): Values {
        val overrides = project.service<PairProjectSettings>().state
        val timing = parseTiming(values.timing) ?: JsonObject()
        return values.copy(
            speed = overrides.speed ?: values.speed,
            agentName = overrides.agentName ?: values.agentName,
            timing = (overrides.timing?.let(::parseTiming)?.let { merge(timing, it) } ?: timing).toString(),
        )
    }

    /** Changes these or a project's overrides in `change`, then tells each open project's host what changed there. */
    @Synchronized
    fun update(change: () -> Unit) {
        val before = ProjectManager.getInstance().openProjects.filterNot { it.isDisposed }.associateWith(::effective)
        change()
        for ((project, old) in before) {
            if (project.isDisposed) continue
            val new = effective(project)
            if (new != old) project.serviceIfCreated<PairHost>()?.settingsChanged(old, new)
        }
    }

    companion object {
        const val MIN_SPEED = 0.25
        const val MAX_SPEED = 4.0

        /** The overrides as the host takes them; `null` if `text` isn't a JSON object. */
        fun parseTiming(text: String): JsonObject? =
            runCatching { JsonParser.parseString(text.ifBlank { "{}" }) }.getOrNull()?.takeIf { it.isJsonObject }?.asJsonObject

        /** VS Code's merge of object settings: `over`'s keys over `base`'s, recursively. */
        private fun merge(base: JsonObject, over: JsonObject): JsonObject = base.deepCopy().apply {
            for ((key, value) in over.entrySet()) {
                val mine = get(key)
                add(key, if (mine is JsonObject && value is JsonObject) merge(mine, value) else value.deepCopy())
            }
        }
    }
}

/**
 * A project's own overrides of `PairSettings`, the counterpart of `.vscode/settings.json`: saved in
 * `.idea/aiPair.xml`, which can be shared with the project. `null` uses the value for all projects.
 */
@Service(Service.Level.PROJECT)
@State(name = "AiPairProjectSettings", storages = [Storage("aiPair.xml")])
class PairProjectSettings : PersistentStateComponent<PairProjectSettings.Overrides> {
    data class Overrides(
        var speed: Double? = null,
        var agentName: String? = null,
        /** Merged over the timing for all projects, key by key. */
        var timing: String? = null,
    )

    @Volatile
    private var overrides = Overrides()

    override fun getState() = overrides

    override fun loadState(state: Overrides) {
        overrides = state
    }
}
