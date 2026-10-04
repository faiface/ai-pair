package ai.pair.panel

import ai.pair.editor.AgentCursor
import ai.pair.host.PairHost
import ai.pair.settings.PairSettings
import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.google.gson.JsonPrimitive
import com.intellij.ide.BrowserUtil
import com.intellij.ide.ui.LafManagerListener
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.Disposable
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.application.ReadAction
import com.intellij.openapi.components.service
import com.intellij.openapi.editor.colors.EditorColorsListener
import com.intellij.openapi.editor.colors.EditorColorsManager
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.ui.popup.util.BaseListPopupStep
import com.intellij.openapi.util.io.FileUtil
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.psi.search.FilenameIndex
import com.intellij.psi.search.GlobalSearchScope
import com.intellij.ui.JBColor
import com.intellij.ui.components.JBLabel
import com.intellij.ui.jcef.JBCefApp
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefJSQuery
import com.intellij.util.concurrency.AppExecutorUtil
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.UIUtil
import java.awt.Color
import java.io.File
import javax.swing.Icon
import javax.swing.JComponent

/** The narration panel: VS Code's panel page in a JCEF browser, its buttons forwarded to the host as commands. */
class NarrationPanel(private val project: Project, private val host: PairHost) : Disposable {
    /** Everything posted so far, replayed when the page (re)loads. */
    private val log = ArrayDeque<JsonObject>()
    private var page: String? = null
    private var browser: JBCefBrowser? = null
    private var query: JBCefJSQuery? = null

    init {
        // Like VS Code's webviews, the page is restyled in place, so a half-typed reply and the scroll survive.
        // The UI theme and the editor scheme (colours, and Settings | Editor | Font) change separately.
        ApplicationManager.getApplication().messageBus.connect(this).apply {
            subscribe(LafManagerListener.TOPIC, LafManagerListener { retheme() })
            subscribe(EditorColorsManager.TOPIC, EditorColorsListener { retheme() })
        }
    }

    fun component(): JComponent {
        if (!JBCefApp.isSupported()) return JBLabel("AI Pair needs JCEF, which this IDE doesn't support.")
        val browser = browser ?: JBCefBrowser().also {
            browser = it
            query = JBCefJSQuery.create(it).apply {
                addHandler { request -> receive(JsonParser.parseString(request).asJsonObject); null }
            }
            Disposer.register(this, it)
            load()
        }
        return browser.component
    }

    fun setPage(html: String) = ApplicationManager.getApplication().invokeLater {
        page = html
        load()
    }

    fun post(event: JsonObject) {
        synchronized(log) {
            log.addLast(event)
            while (log.size > MAX_LOG) log.removeFirst()
        }
        send(event)
        if (event["type"].asString == "session" && event["active"].asBoolean) {
            ApplicationManager.getApplication().invokeLater { ToolWindowManager.getInstance(project).getToolWindow(ID)?.show() }
        }
    }

    fun showSelection(ref: JsonObject?) = send(JsonObject().apply {
        addProperty("type", "selection")
        add("ref", ref)
    })

    /** Shows the panel with the cursor in the reply box. */
    fun focusReply() {
        ToolWindowManager.getInstance(project).getToolWindow(ID)?.show()
        send(JsonObject().apply { addProperty("type", "focusReply") })
    }

    private fun load() {
        val browser = browser ?: return
        val query = query ?: return
        val html = page ?: return
        val bridge = "const vscode = { postMessage: (m) => { const s = JSON.stringify(m); ${query.inject("s")} } };"
        browser.loadHTML(
            html.replace("const vscode = acquireVsCodeApi();", bridge).replace("</head>", "<style id=\"$THEME\">${theme()}</style></head>"),
        )
    }

    /** Swaps in a fresh `theme()`; later, on the EDT, once the new theme is in place. */
    private fun retheme() = ApplicationManager.getApplication().invokeLater({
        val css = JsonPrimitive(theme())
        browser?.cefBrowser?.executeJavaScript("{ const t = document.getElementById('$THEME'); if (t) t.textContent = $css; }", "", 0)
    }, ModalityState.any())

    private fun send(message: JsonObject) {
        browser?.cefBrowser?.executeJavaScript("window.postMessage($message, '*')", "", 0)
    }

    /** A message from the page: the counterpart of `receive` in packages/vscode/src/panel.ts. */
    private fun receive(m: JsonObject) {
        when (m["type"].asString) {
            "ready" -> {
                val events = JsonArray().apply { synchronized(log) { log.forEach(::add) } }
                send(JsonObject().apply { addProperty("type", "replay"); add("events", events) })
                showSpeed(service<PairSettings>().effective(project).speed)
                ApplicationManager.getApplication().invokeLater { showSelection(host.editor.selectionRef()) }
            }
            // Like VS Code's, the menu sets the speed for all projects; a project's own speed still wins.
            "speed" -> m["value"].asDouble.let { value ->
                val settings = service<PairSettings>()
                settings.update { settings.loadState(settings.state.copy(speed = value)) }
            }
            // Replying means "go on with this", so any pause ends.
            "reply" -> {
                host.command("resume")
                host.command("userMessage", withSelection(m))
            }
            // Typing a reply pauses playback, the way a pair stops when you start talking.
            "draft" -> host.command(if (m["empty"].asBoolean) "resume" else "pause", JsonObject().apply { addProperty("reason", "reply") })
            "pause" -> host.command("pause")
            "resume" -> host.command("resume")
            "interrupt" -> host.command("userInterrupt")
            "turn" -> host.command("toggleTurn", withSelection(m))
            "end" -> host.command("endSession")
            "runDecision" -> host.command("decideRun", m)
            "open" -> ApplicationManager.getApplication().invokeLater { open(m["file"].asString, m["line"].asInt) }
            "openFile" -> ApplicationManager.getApplication().invokeLater({ openByName(m["file"].asString) }, project.disposed)
            "openUrl" -> m["url"].asString.takeIf { it.startsWith("http://") || it.startsWith("https://") }?.let(BrowserUtil::browse)
            // The intro's commands, as the IDE's own actions: Tools > AI Pair, with their checks.
            "command" -> PANEL_ACTIONS[m["command"].asString]?.let { id ->
                ApplicationManager.getApplication().invokeLater({ runAction(id) }, project.disposed)
            }
        }
    }

    private fun runAction(id: String) {
        val manager = ActionManager.getInstance()
        manager.tryToExecute(manager.getAction(id) ?: return, null, browser?.component, PLACE, true)
    }

    /** The page's message, plus the programmer's selection if it asked to attach it. */
    private fun withSelection(m: JsonObject): JsonObject {
        if (m["attach"]?.asBoolean != true) return m
        var selection: JsonObject? = null
        ApplicationManager.getApplication().invokeAndWait { selection = host.editor.programmerSelection() }
        return m.deepCopy().apply { add("selection", selection) }
    }

    /** The speed setting changed. */
    fun showSpeed(speed: Double) = send(JsonObject().apply { addProperty("type", "speed"); addProperty("value", speed) })

    /** Opens a file the page names, relative to the project or absolute, at a line. */
    private fun open(file: String, line: Int) {
        val vf = find(file) ?: return
        OpenFileDescriptor(project, vf, (line - 1).coerceAtLeast(0), 0).navigate(true)
    }

    /** A file relative to the project, or absolute. */
    private fun find(file: String): VirtualFile? {
        val path = if (File(file).isAbsolute) file else File(project.basePath ?: return null, file).path
        return LocalFileSystem.getInstance().findFileByPath(FileUtil.toSystemIndependentName(path))
    }

    /** Opens a file the agent named: as a path in the project, else the file of that name, asking if there are several. */
    private fun openByName(name: String) {
        find(name)?.takeUnless { it.isDirectory }?.let { return OpenFileDescriptor(project, it).navigate(true) }
        // Not a path from the project's root: look for it by name, as VS Code's `**/name`.
        ReadAction.nonBlocking<List<VirtualFile>> {
            FilenameIndex.getVirtualFilesByName(name.substringAfterLast('/'), GlobalSearchScope.projectScope(project))
                .filter { it.path.endsWith("/$name") && "/node_modules/" !in it.path }
                .sortedBy { it.path }
                .take(MAX_FOUND)
        }.inSmartMode(project).expireWith(this).finishOnUiThread(ModalityState.nonModal()) { found ->
            when (found.size) {
                0 -> NotificationGroupManager.getInstance().getNotificationGroup("AI Pair")
                    .createNotification("AI Pair: couldn't find $name in the project.", NotificationType.INFORMATION)
                    .notify(project)
                1 -> OpenFileDescriptor(project, found[0]).navigate(true)
                // The IDE's own file chooser look, file-type icons included, where VS Code has a plain quick pick.
                else -> JBPopupFactory.getInstance().createListPopup(object : BaseListPopupStep<VirtualFile>("Which $name?", found) {
                    override fun getTextFor(value: VirtualFile) = FileUtil.getRelativePath(project.basePath ?: "", value.path, '/') ?: value.path
                    override fun getIconFor(value: VirtualFile): Icon? = value.fileType.icon
                    override fun isSpeedSearchEnabled() = true
                    override fun onChosen(selectedValue: VirtualFile, finalChoice: Boolean) =
                        doFinalStep { OpenFileDescriptor(project, selectedValue).navigate(true) }
                }).showCenteredInCurrentWindow(project)
            }
        }.submit(AppExecutorUtil.getAppExecutorService())
    }

    override fun dispose() {}

    private fun theme(): String {
        val scheme = EditorColorsManager.getInstance().globalScheme
        val font = UIUtil.getLabelFont()
        val vars = mapOf(
            "foreground" to css(UIUtil.getLabelForeground()),
            "descriptionForeground" to css(UIUtil.getContextHelpForeground()),
            "font-family" to "'${font.family}', system-ui, sans-serif",
            "font-size" to "${font.size}px",
            "editor-font-family" to "'${scheme.editorFontName}', monospace",
            "editor-font-size" to "${scheme.editorFontSize}px",
            "button-background" to css(JBUI.CurrentTheme.Button.defaultButtonColorStart()),
            "button-foreground" to css(JBColor.namedColor("Button.default.foreground", JBColor.WHITE)),
            "button-hoverBackground" to css(JBUI.CurrentTheme.Button.defaultButtonColorEnd()),
            "button-border" to css(JBUI.CurrentTheme.Button.buttonOutlineColorStart(false)),
            "button-secondaryBackground" to css(JBUI.CurrentTheme.Button.buttonColorStart()),
            "button-secondaryForeground" to css(UIUtil.getLabelForeground()),
            "button-secondaryHoverBackground" to css(JBUI.CurrentTheme.ActionButton.hoverBackground()),
            "input-background" to css(UIUtil.getTextFieldBackground()),
            "input-foreground" to css(UIUtil.getTextFieldForeground()),
            "input-border" to css(JBColor.border()),
            "input-placeholderForeground" to css(UIUtil.getContextHelpForeground()),
            "focusBorder" to css(JBUI.CurrentTheme.Focus.focusColor()),
            "sideBarSectionHeader-border" to css(JBColor.border()),
            // The page's --surface: the band and the speed menu, see-through without it.
            "editor-background" to css(scheme.defaultBackground),
            "textCodeBlock-background" to css(scheme.defaultBackground),
            "textLink-foreground" to css(JBUI.CurrentTheme.Link.Foreground.ENABLED),
            "aiPair-cursor" to css(AgentCursor.CURSOR),
            "aiPair-cursorRead" to css(AgentCursor.READ),
        )
        val root = vars.entries.joinToString(" ") { "--vscode-${it.key}: ${it.value};" }
        return ":root { $root } body { background: ${css(UIUtil.getPanelBackground())}; }"
    }

    companion object {
        const val ID = "AI Pair"
        private const val MAX_LOG = 400
        private const val THEME = "ai-pair-theme"
        /** Files found by name, at most: VS Code's limit. */
        private const val MAX_FOUND = 20
        private const val PLACE = "AiPairPanel"

        /** The commands the page may run, VS Code's ids to this plugin's actions: the ones its intro links to. */
        private val PANEL_ACTIONS = mapOf("aiPair.playDemo" to "ai.pair.PlayDemo", "aiPair.setUpAgent" to "ai.pair.SetUpAgent")
    }
}

private fun css(c: Color) = "rgba(${c.red}, ${c.green}, ${c.blue}, ${c.alpha / 255.0})"
