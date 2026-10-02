package ai.pair.panel

import ai.pair.host.PairHost
import com.intellij.openapi.components.service
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.content.ContentFactory

class PanelToolWindowFactory : ToolWindowFactory, DumbAware {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val panel = project.service<PairHost>().panel
        toolWindow.contentManager.addContent(ContentFactory.getInstance().createContent(panel.component(), null, false))
    }
}
