package ai.pair.actions

import ai.pair.host.PairHost
import ai.pair.setup.AgentSetup
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.ActionPlaces
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.components.service
import com.intellij.openapi.project.DumbAware

/** An action that forwards one command to the host (wire.ts's `Commands`). */
abstract class PairAction(private val method: String) : AnAction(), DumbAware {
    override fun actionPerformed(e: AnActionEvent) {
        e.project?.service<PairHost>()?.command(method)
    }

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled = e.project?.service<PairHost>()?.sessionActive == true
    }

    override fun getActionUpdateThread() = ActionUpdateThread.BGT
}

class TogglePauseAction : PairAction("togglePause")

class InterruptAction : PairAction("userInterrupt")

class ToggleTurnAction : PairAction("toggleTurn")

class EndSessionAction : PairAction("endSession")

class FocusReplyAction : AnAction(), DumbAware {
    override fun actionPerformed(e: AnActionEvent) {
        e.project?.service<PairHost>()?.panel?.focusReply()
    }

    override fun update(e: AnActionEvent) {
        val selectionNeeded = e.place == ActionPlaces.EDITOR_POPUP
        val active = e.project?.service<PairHost>()?.sessionActive == true
        val selected = e.getData(CommonDataKeys.EDITOR)?.selectionModel?.hasSelection() == true
        e.presentation.isEnabledAndVisible = active && (!selectionNeeded || selected)
    }

    override fun getActionUpdateThread() = ActionUpdateThread.EDT
}

class SetUpAgentAction : AnAction(), DumbAware {
    override fun actionPerformed(e: AnActionEvent) {
        AgentSetup.setUpAgent(e.project ?: return)
    }

    override fun getActionUpdateThread() = ActionUpdateThread.BGT
}

/** The scripted demo session (packages/vscode/src/demoScript.ts), in the project's ai-pair-demo/. */
class PlayDemoAction : AnAction(), DumbAware {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val host = project.service<PairHost>()
        if (host.sessionActive) {
            NotificationGroupManager.getInstance().getNotificationGroup("AI Pair")
                .createNotification("A pairing session is already active.", NotificationType.WARNING)
                .notify(project)
            return
        }
        host.command("playDemo")
    }

    /** The demo creates files in the project folder, as VS Code's needs an open folder. */
    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled = e.project?.basePath != null
    }

    override fun getActionUpdateThread() = ActionUpdateThread.BGT
}
