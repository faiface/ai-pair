package ai.pair.host

import ai.pair.setup.AgentSetup
import com.intellij.ide.util.PropertiesComponent
import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity

class PairStartup : ProjectActivity {
    override suspend fun execute(project: Project) {
        project.service<PairHost>().start()
        val properties = PropertiesComponent.getInstance()
        if (properties.getBoolean(OFFERED_SETUP)) return
        properties.setValue(OFFERED_SETUP, true)
        NotificationGroupManager.getInstance().getNotificationGroup("AI Pair")
            .createNotification("AI Pair is installed. Connect it to your agent?", NotificationType.INFORMATION)
            .addAction(NotificationAction.createSimpleExpiring("Set Up Agent") { AgentSetup.setUpAgent(project) })
            .notify(project)
    }
}

private const val OFFERED_SETUP = "ai.pair.offeredSetup"
