package ai.pair.panel

import ai.pair.editor.AgentCursor
import ai.pair.host.PairHost
import ai.pair.settings.PairSettings
import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.service
import com.intellij.openapi.editor.colors.EditorColorsManager
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.util.io.FileUtil
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.ui.JBColor
import com.intellij.ui.components.JBLabel
import com.intellij.ui.jcef.JBCefApp
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefJSQuery
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.UIUtil
import java.awt.Color
import java.io.File
import javax.swing.JComponent

/** The narration panel: VS Code's panel page in a JCEF browser, its buttons forwarded to the host as commands. */
class NarrationPanel(private val project: Project, private val host: PairHost) : Disposable {
    /** Everything posted so far, replayed when the page (re)loads. */
    private val log = ArrayDeque<JsonObject>()
    private var page: String? = null
    private var browser: JBCefBrowser? = null
    private var query: JBCefJSQuery? = null

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
            html.replace("const vscode = acquireVsCodeApi();", bridge).replace("</head>", "<style>${theme()}</style></head>"),
        )
    }

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
        }
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
        val path = if (File(file).isAbsolute) file else File(project.basePath ?: return, file).path
        val vf = LocalFileSystem.getInstance().findFileByPath(FileUtil.toSystemIndependentName(path)) ?: return
        OpenFileDescriptor(project, vf, (line - 1).coerceAtLeast(0), 0).navigate(true)
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
    }
}

private fun css(c: Color) = "rgba(${c.red}, ${c.green}, ${c.blue}, ${c.alpha / 255.0})"
