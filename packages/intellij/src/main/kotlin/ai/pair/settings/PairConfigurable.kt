package ai.pair.settings

import com.intellij.openapi.components.service
import com.intellij.openapi.options.BoundConfigurable
import com.intellij.openapi.options.ConfigurationException
import com.intellij.openapi.project.Project
import com.intellij.ui.components.JBCheckBox
import com.intellij.ui.components.JBTextArea
import com.intellij.ui.components.JBTextField
import com.intellij.ui.dsl.builder.AlignX
import com.intellij.ui.dsl.builder.COLUMNS_LARGE
import com.intellij.ui.dsl.builder.Cell
import com.intellij.ui.dsl.builder.LabelPosition
import com.intellij.ui.dsl.builder.bindSelected
import com.intellij.ui.dsl.builder.bindText
import com.intellij.ui.dsl.builder.bindValue
import com.intellij.ui.dsl.builder.columns
import com.intellij.ui.dsl.builder.panel
import com.intellij.ui.dsl.builder.rows
import com.intellij.ui.dsl.builder.selected
import javax.swing.JSpinner

/**
 * Settings | Tools | AI Pair: the settings for all projects and this project's overrides, like VS
 * Code's User and Workspace tabs. The descriptions are VS Code's (packages/vscode/package.json).
 *
 * The bindings only load the fields and tell whether they changed: `apply` reads every field
 * itself, since the UI DSL applies only the fields that changed.
 */
class PairConfigurable(private val project: Project) : BoundConfigurable("AI Pair") {
    private val settings = service<PairSettings>()
    private val overrides get() = project.service<PairProjectSettings>().state

    private lateinit var speed: Cell<JSpinner>
    private lateinit var agentName: Cell<JBTextField>
    private lateinit var confirmCommands: Cell<JBCheckBox>
    private lateinit var timing: Cell<JBTextArea>
    private lateinit var overrideSpeed: Cell<JBCheckBox>
    private lateinit var projectSpeed: Cell<JSpinner>
    private lateinit var overrideAgentName: Cell<JBCheckBox>
    private lateinit var projectAgentName: Cell<JBTextField>
    private lateinit var overrideTiming: Cell<JBCheckBox>
    private lateinit var projectTiming: Cell<JBTextArea>

    override fun createPanel() = panel {
        group("All Projects") {
            row("Speed:") {
                speed = spinner(PairSettings.MIN_SPEED..PairSettings.MAX_SPEED, 0.05)
                    .bindValue({ settings.state.speed }, {})
                    .comment(SPEED)
            }
            row("Agent name:") {
                agentName = textField().bindText({ settings.state.agentName }, {}).comment(AGENT_NAME)
            }
            row {
                confirmCommands = checkBox("Confirm commands")
                    .bindSelected({ settings.state.confirmCommands }, {})
                    .comment(CONFIRM_COMMANDS)
            }
            row {
                timing = timing(textArea().label("Timing:", LabelPosition.TOP))
                    .bindText({ settings.state.timing }, {})
                    .comment(TIMING)
            }
        }
        group("This Project") {
            row {
                overrideSpeed = checkBox("Speed:").bindSelected({ overrides.speed != null }, {})
                projectSpeed = spinner(PairSettings.MIN_SPEED..PairSettings.MAX_SPEED, 0.05)
                    .bindValue({ overrides.speed ?: settings.state.speed }, {})
                    .enabledIf(overrideSpeed.selected)
            }
            row {
                overrideAgentName = checkBox("Agent name:").bindSelected({ overrides.agentName != null }, {})
                projectAgentName = textField()
                    .bindText({ overrides.agentName ?: settings.state.agentName }, {})
                    .enabledIf(overrideAgentName.selected)
            }
            row { overrideTiming = checkBox("Timing:").bindSelected({ overrides.timing != null }, {}) }
            row {
                projectTiming = timing(textArea())
                    .bindText({ overrides.timing ?: "{}" }, {})
                    .enabledIf(overrideTiming.selected)
            }
        }
    }

    private fun timing(cell: Cell<JBTextArea>) = cell.rows(6).columns(COLUMNS_LARGE).align(AlignX.FILL)

    override fun apply() {
        val values = PairSettings.Values(
            speed = speed.component.speed,
            agentName = agentName.component.text.ifBlank { "Agent" },
            timing = checkedTiming(timing.component.text, "All Projects"),
            confirmCommands = confirmCommands.component.isSelected,
        )
        val projectOverrides = PairProjectSettings.Overrides(
            speed = projectSpeed.component.speed.takeIf { overrideSpeed.component.isSelected },
            agentName = projectAgentName.component.text.takeIf { overrideAgentName.component.isSelected && it.isNotBlank() },
            timing = projectTiming.component.text.takeIf { overrideTiming.component.isSelected }
                ?.let { checkedTiming(it, "This Project") },
        )
        settings.update {
            settings.loadState(values)
            project.service<PairProjectSettings>().loadState(projectOverrides)
        }
        // Loads the fields back from what was saved, e.g. a blank agent name as "Agent".
        reset()
    }

    /** `text`, if it's a JSON object; the Settings dialog shows the exception and keeps the page open. */
    private fun checkedTiming(text: String, group: String): String {
        if (PairSettings.parseTiming(text) == null) throw ConfigurationException("$group timing must be a JSON object, e.g. {}")
        return text.ifBlank { "{}" }
    }
}

private val JSpinner.speed get() = (value as Number).toDouble()

private const val SPEED = "Overall playback speed: typing, pauses, and reading time. The panel's speed menu offers 0.4× to 3×."
private const val AGENT_NAME = "Name shown on the agent's cursor."
private const val CONFIRM_COMMANDS =
    "Ask in the Pair panel before running each command the agent plays in the terminal (<code>run</code>). " +
        "Turning this off lets the agent run commands without Claude Code's own permission prompt."
private const val TIMING =
    "Calibration: override any playback timing, in milliseconds at normal speed. See " +
        "<code>packages/core/src/timing.ts</code> for every key and its default, e.g. " +
        "<code>{ \"afterSelectMs\": 900, \"type\": { \"wordStartMs\": 140 } }</code>."
