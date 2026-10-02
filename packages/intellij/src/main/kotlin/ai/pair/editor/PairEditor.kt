package ai.pair.editor

import ai.pair.host.PairHost
import ai.pair.terminal.PairTerminals
import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonNull
import com.google.gson.JsonObject
import com.google.gson.JsonPrimitive
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.WriteAction
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.editor.Document
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.editor.LogicalPosition
import com.intellij.openapi.editor.event.DocumentEvent
import com.intellij.openapi.editor.event.DocumentListener
import com.intellij.openapi.editor.event.SelectionEvent
import com.intellij.openapi.editor.event.SelectionListener
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.FileEditorManagerEvent
import com.intellij.openapi.fileEditor.FileEditorManagerListener
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.fileEditor.TextEditor
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.io.FileUtil
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VfsUtil
import com.intellij.openapi.vfs.VirtualFile
import java.io.File
import java.awt.Point
import kotlin.math.max

/** The host's editor calls and notices (wire.ts's `Calls` and `Notices`), on IntelliJ documents. */
class PairEditor(private val project: Project, private val host: PairHost) {
    private val cursor = AgentCursor()
    private val terminals = PairTerminals(project)

    /** Edits in the same group are one undo step; each `undoStopBefore` starts a new group. */
    private var undoSteps = 0
    private var undoGroup = ""

    /** Set while our own edit is applied, so the listener doesn't report it as the programmer's. */
    private var applying = false
    var sessionActive = false
        private set

    private var cursorAt: Spot? = null
    private var point: Span? = null
    private var state = "thinking"
    private var focus = "cursor"
    private var selfNavUntil = 0L
    private var lastSelection = ""

    init {
        val listener = object : DocumentListener {
            override fun documentChanged(event: DocumentEvent) = onChange(event)
        }
        EditorFactory.getInstance().eventMulticaster.addDocumentListener(listener, host)
        Disposer.register(host) { cursor.dispose() }
        val tabs = object : FileEditorManagerListener {
            override fun selectionChanged(event: FileEditorManagerEvent) = onSelectedFile(event.newFile)
        }
        project.messageBus.connect(host).subscribe(FileEditorManagerListener.FILE_EDITOR_MANAGER, tabs)
        EditorFactory.getInstance().eventMulticaster.addVisibleAreaListener({ onScroll(it.editor) }, host)
        val selections = object : SelectionListener {
            override fun selectionChanged(e: SelectionEvent) = onSelection()
        }
        EditorFactory.getInstance().eventMulticaster.addSelectionListener(selections, host)
    }

    fun call(id: Int, method: String, args: JsonObject) {
        if (method == "runCommand") {
            return terminals.run(id, args["command"].asString, args["cwd"].asString, args["waitMs"].asLong) { host.answer(id, it) }
        }
        ApplicationManager.getApplication().invokeLater({
            runCatching { perform(method, args) }
                .onSuccess { host.answer(id, it) }
                .onFailure { host.fail(id, it.message ?: it.toString()) }
        }, project.disposed)
    }

    fun cancel(id: Int) = terminals.cancel(id)

    fun setAgentName(name: String) = ApplicationManager.getApplication().invokeLater({ cursor.name = name }, project.disposed)

    fun notice(method: String, args: JsonObject) {
        ApplicationManager.getApplication().invokeLater({
            when (method) {
                "renderCursor" -> renderCursor(args)
                "renderPoint" -> renderPoint(args)
                "reveal" -> target()?.let {
                    show(it.file)
                    follow(it, force = true)
                }
                "post" -> args["event"].asJsonObject.let { if (it["type"].asString == "session") sessionActive = it["active"].asBoolean }
            }
        }, project.disposed)
    }

    private fun perform(method: String, args: JsonObject): JsonElement {
        val file = args["file"]?.asString
        return when (method) {
            "getText" -> JsonPrimitive(document(file!!).text)
            "eol" -> JsonPrimitive("\n")
            "isDirty" -> JsonPrimitive(FileDocumentManager.getInstance().isDocumentUnsaved(document(file!!)))
            "show" -> show(file!!)
            "edit" -> edit(
                document(file!!),
                args["offset"].asInt,
                args["deleteLength"].asInt,
                args["text"].asString,
                args["options"].asJsonObject["undoStopBefore"].asBoolean,
            )
            "save" -> JsonNull.INSTANCE.also { FileDocumentManager.getInstance().saveDocument(document(file!!)) }
            else -> error("`$method` isn't supported in IntelliJ yet.")
        }
    }

    private fun show(path: String): JsonElement {
        val file = find(path) ?: WriteAction.computeAndWait<VirtualFile, Exception> {
            val io = File(path)
            VfsUtil.createDirectories(FileUtil.toSystemIndependentName(io.parent)).createChildData(this, io.name)
        }
        val manager = FileEditorManager.getInstance(project)
        if (file !in manager.selectedFiles) {
            selfNavUntil = System.currentTimeMillis() + SELF_NAV_MS
            manager.openTextEditor(OpenFileDescriptor(project, file), false)
        }
        return JsonNull.INSTANCE
    }

    private fun edit(document: Document, offset: Int, deleteLength: Int, text: String, newUndoStep: Boolean): JsonElement {
        if (newUndoStep) undoGroup = "ai-pair-${++undoSteps}"
        WriteCommandAction.writeCommandAction(project).withName("AI Pair").withGroupId(undoGroup).run<Exception> {
            applying = true
            try {
                document.replaceString(offset, offset + deleteLength, text)
            } finally {
                applying = false
            }
        }
        return JsonNull.INSTANCE
    }

    // The programmer's selection, offered with replies to the agent.

    /** What the programmer has selected in a project file, as a `SharedSelection`, if anything. */
    fun programmerSelection(): JsonObject? {
        val editor = FileEditorManager.getInstance(project).selectedTextEditor ?: return null
        val file = FileDocumentManager.getInstance().getFile(editor.document) ?: return null
        val selection = editor.selectionModel
        val text = selection.selectedText
        if (text.isNullOrEmpty() || !inProject(file)) return null
        return JsonObject().apply {
            addProperty("file", path(file))
            add("from", position(editor.document, selection.selectionStart))
            add("to", position(editor.document, selection.selectionEnd))
            addProperty("text", text.take(MAX_EXCERPT))
            if (text.length > MAX_EXCERPT) addProperty("truncated", true)
        }
    }

    /** The selection as the panel shows it: the file as the agent names it, and its lines. */
    fun selectionRef(): JsonObject? = programmerSelection()?.let {
        JsonObject().apply {
            addProperty("file", displayPath(it["file"].asString))
            addProperty("line", it["from"].asJsonObject["line"].asInt)
            addProperty("endLine", it["to"].asJsonObject["line"].asInt)
        }
    }

    /** The agent's typing moves the programmer's selection on every keystroke; only real changes count. */
    private fun onSelection() {
        val ref = selectionRef()
        val key = ref?.toString() ?: ""
        if (key == lastSelection) return
        lastSelection = key
        host.panel.showSelection(ref)
    }

    private fun onChange(event: DocumentEvent) {
        if (applying || !sessionActive) return
        val file = FileDocumentManager.getInstance().getFile(event.document) ?: return
        if (!inProject(file)) return
        val after = event.document.immutableCharSequence
        val before = StringBuilder(after).replace(event.offset, event.offset + event.newLength, event.oldFragment.toString())
        val change = JsonObject().apply {
            addProperty("offset", event.offset)
            addProperty("deleteLength", event.oldLength)
            addProperty("text", event.newFragment.toString())
        }
        host.command("userEdit", JsonObject().apply {
            addProperty("file", FileUtil.toSystemDependentName(file.path))
            addProperty("before", before.toString())
            add("changes", JsonArray().apply { add(change) })
        })
    }

    private fun renderCursor(args: JsonObject) {
        val view = args["cursor"].objectOrNull()
        cursorAt = view?.let { Spot(it["file"].asString, it["offset"].asInt) }
        state = args["state"].asString
        focus = args["focus"].asString
        cursor.render(
            cursorAt?.let { visibleEditor(it.file) },
            cursorAt?.offset ?: 0,
            view?.get("selection").objectOrNull()?.let { it["start"].asInt..<it["end"].asInt },
            state,
        )
        val target = target()
        if (target != null && state in FOLLOWING) follow(target)
    }

    private fun renderPoint(args: JsonObject) {
        point = args["point"].objectOrNull()?.let { Span(it["file"].asString, it["start"].asInt, it["end"].asInt) }
        cursor.renderPoint(point?.let { visibleEditor(it.file) }, point?.start ?: 0, point?.end ?: 0)
    }

    private fun target(): Spot? = point?.takeIf { focus == "point" }?.let { Spot(it.file, it.start) } ?: cursorAt

    /** Keeps the target in the upper part of the view, scrolling only when it leaves that band. */
    private fun follow(target: Spot, force: Boolean = false) {
        val editor = visibleEditor(target.file) ?: return
        val area = editor.scrollingModel.visibleArea
        val first = editor.xyToLogicalPosition(Point(0, area.y)).line
        val height = max(1, area.height / editor.lineHeight)
        val line = editor.offsetToLogicalPosition(target.offset.coerceIn(0, editor.document.textLength)).line
        // At the top of a file the target can't sit lower in the view, and that's fine.
        val inBand = line <= first + height * 6 / 10 && (line >= first + height / 10 || first == 0)
        if (!force && inBand) return
        selfNavUntil = System.currentTimeMillis() + SELF_NAV_MS
        editor.scrollingModel.scrollVertically(editor.logicalPositionToXY(LogicalPosition(max(0, line - height / 3), 0)).y)
    }

    // Looking away from what the view follows pauses playback, until the programmer resumes it.

    private fun onSelectedFile(file: VirtualFile?) {
        val target = followed() ?: return
        if (file == null || !FileUtil.pathsEqual(path(file), target.file)) pauseAway()
    }

    private fun onScroll(editor: Editor) {
        val target = followed() ?: return
        val file = FileDocumentManager.getInstance().getFile(editor.document) ?: return
        if (editor.project != project || !FileUtil.pathsEqual(path(file), target.file)) return
        val area = editor.scrollingModel.visibleArea
        val first = editor.xyToLogicalPosition(Point(0, area.y)).line
        val last = editor.xyToLogicalPosition(Point(0, area.y + area.height)).line
        val line = editor.offsetToLogicalPosition(target.offset.coerceIn(0, editor.document.textLength)).line
        if (line !in first..last) pauseAway()
    }

    /** What the view follows, if it's following now and the view didn't just change by our own doing. */
    private fun followed(): Spot? = target()?.takeIf { state in FOLLOWING && System.currentTimeMillis() >= selfNavUntil }

    private fun pauseAway() = host.command("pause", JsonObject().apply { addProperty("reason", "away") })

    private fun inProject(file: VirtualFile): Boolean {
        val root = project.basePath ?: return false
        return file.isInLocalFileSystem && FileUtil.isAncestor(root, file.path, false)
    }

    private fun displayPath(file: String): String {
        val relative = project.basePath?.let { FileUtil.getRelativePath(File(it), File(file)) }
        return if (relative == null || relative.startsWith("..")) file else relative
    }

    private fun visibleEditor(path: String): Editor? {
        val file = find(path) ?: return null
        return (FileEditorManager.getInstance(project).getSelectedEditor(file) as? TextEditor)?.editor
    }

    private fun find(path: String): VirtualFile? {
        val independent = FileUtil.toSystemIndependentName(path)
        val fs = LocalFileSystem.getInstance()
        return fs.findFileByPath(independent) ?: fs.refreshAndFindFileByPath(independent)
    }

    private fun document(path: String): Document {
        val file = find(path) ?: error("No such file: $path")
        return FileDocumentManager.getInstance().getDocument(file) ?: error("Not a text file: $path")
    }
}

private data class Spot(val file: String, val offset: Int)

private data class Span(val file: String, val start: Int, val end: Int)

/** States in which the programmer's view follows the agent. */
private val FOLLOWING = setOf("typing", "read", "thinking", "listening")

/** View changes this soon after our own scrolling are ours, not the programmer's. */
private const val SELF_NAV_MS = 400

private fun JsonElement?.objectOrNull(): JsonObject? = this?.takeUnless { it.isJsonNull }?.asJsonObject

private fun path(file: VirtualFile): String = FileUtil.toSystemDependentName(file.path)

/** A shared selection is cut off here; the agent can `read` the rest. */
private const val MAX_EXCERPT = 8000

private fun position(document: Document, offset: Int): JsonObject {
    val line = document.getLineNumber(offset)
    return JsonObject().apply {
        addProperty("line", line + 1)
        addProperty("column", offset - document.getLineStartOffset(line) + 1)
    }
}
