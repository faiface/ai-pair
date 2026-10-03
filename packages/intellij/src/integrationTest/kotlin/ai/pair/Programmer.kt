package ai.pair

import com.intellij.driver.client.Driver
import com.intellij.driver.client.Remote
import com.intellij.driver.model.OnDispatcher
import com.intellij.driver.sdk.Editor
import com.intellij.driver.sdk.FileEditor
import com.intellij.driver.sdk.FileEditorManager
import com.intellij.driver.sdk.Project
import com.intellij.driver.sdk.VirtualFile
import java.io.File

// The IDE's and the plugin's classes the test calls, through Driver: only public ones.

@Remote("ai.pair.host.PairHost", plugin = "ai.pair")
interface PairHost {
    fun getSessionActive(): Boolean
    fun command(method: String, args: GsonObject)
}

@Remote("ai.pair.setup.AgentSetup", plugin = "ai.pair")
interface AgentSetup {
    fun writeLauncher(): JavaFile
}

@Remote("java.io.File")
interface JavaFile {
    fun getPath(): String
}

@Remote("com.google.gson.JsonParser")
interface GsonParser {
    fun parseString(json: String): GsonElement
}

@Remote("com.google.gson.JsonElement")
interface GsonElement {
    fun getAsJsonObject(): GsonObject
}

@Remote("com.google.gson.JsonObject")
interface GsonObject

@Remote("com.intellij.openapi.vfs.LocalFileSystem")
interface LocalFileSystems {
    fun getInstance(): LocalFileSystem
}

@Remote("com.intellij.openapi.vfs.LocalFileSystem")
interface LocalFileSystem {
    fun refreshAndFindFileByPath(path: String): VirtualFile?
    fun findFileByPath(path: String): RefreshableFile?
}

@Remote("com.intellij.openapi.vfs.VirtualFile")
interface RefreshableFile {
    fun refresh(asynchronous: Boolean, recursive: Boolean)
}

@Remote("com.intellij.openapi.fileEditor.FileDocumentManager")
interface FileDocumentManager {
    fun getDocument(file: VirtualFile): Document?
    fun saveAllDocuments()
}

@Remote("com.intellij.openapi.editor.Document")
interface Document {
    fun getText(): String
}

@Remote("com.intellij.openapi.editor.actionSystem.TypedAction")
interface TypedActions {
    fun getInstance(): TypedAction
}

@Remote("com.intellij.openapi.editor.actionSystem.TypedAction")
interface TypedAction {
    fun actionPerformed(editor: Editor, char: Char, context: DataContext)
}

@Remote("com.intellij.openapi.editor.ex.util.EditorUtil")
interface EditorUtil {
    fun getEditorDataContext(editor: Editor): DataContext
}

@Remote("com.intellij.openapi.actionSystem.DataContext")
interface DataContext

@Remote("com.intellij.openapi.command.undo.UndoManager")
interface UndoManagers {
    fun getInstance(project: Project): UndoManager
}

@Remote("com.intellij.openapi.command.undo.UndoManager")
interface UndoManager {
    fun undo(editor: FileEditor)
}

@Remote("com.intellij.openapi.fileEditor.impl.text.TextEditorProvider")
interface TextEditorProviders {
    fun getInstance(): TextEditorProvider
}

@Remote("com.intellij.openapi.fileEditor.impl.text.TextEditorProvider")
interface TextEditorProvider {
    fun getTextEditor(editor: Editor): FileEditor
}

/** What the programmer does in the IDE, and what it shows them. */
class Programmer(private val driver: Driver, private val project: Project, private val root: File) {
    val host = driver.service(PairHost::class, project)

    /** A command to the host, as the plugin's actions and settings send them (wire.ts's `Commands`). */
    fun command(method: String, args: String = "{}") =
        host.command(method, driver.utility(GsonParser::class).parseString(args).getAsJsonObject())

    /** What the IDE has for a file, which may not be saved yet. */
    fun buffer(name: String): String {
        val file = driver.utility(LocalFileSystems::class).getInstance()
            .refreshAndFindFileByPath(File(root, name).invariantSeparatorsPath) ?: error("No $name in the IDE")
        return driver.withReadAction { service(FileDocumentManager::class).getDocument(file)!!.getText() }
    }

    /** Has the IDE look at a file changed on disk, as it does by itself when its window gains focus. */
    fun refresh(name: String) = driver.utility(LocalFileSystems::class).getInstance()
        .findFileByPath(File(root, name).invariantSeparatorsPath)!!.refresh(true, false)

    /** Saves every file, as the IDE's autosave does when its window loses focus or sits idle. */
    fun saveAll() = driver.withWriteAction { service(FileDocumentManager::class).saveAllDocuments() }

    /**
     * Types into the file in front, at `offset`, through the IDE's own typing (`TypedAction`), as keystrokes do. Each
     * character is its own command; a document change from outside one is refused.
     */
    fun type(name: String, offset: Int, text: String) {
        val editor = inFront(name)
        driver.withContext(OnDispatcher.EDT) {
            editor.getCaretModel().moveToOffset(offset)
            val context = utility(EditorUtil::class).getEditorDataContext(editor)
            val typing = utility(TypedActions::class).getInstance()
            for (c in text) typing.actionPerformed(editor, c, context)
        }
    }

    /** Undoes the last step in the file in front, as Ctrl+Z there does. */
    fun undo(name: String) {
        val editor = driver.utility(TextEditorProviders::class).getInstance().getTextEditor(inFront(name))
        driver.withWriteAction { utility(UndoManagers::class).getInstance(project).undo(editor) }
    }

    private fun inFront(name: String): Editor {
        val editor = driver.service(FileEditorManager::class, project).getSelectedTextEditor() ?: error("No editor in front")
        val front = driver.withReadAction { editor.getVirtualFile().getName() }
        check(front == File(name).name) { "$front is in front, not $name" }
        return editor
    }
}

/** Waits until `done`, checking every 50 ms. */
fun until(what: String, timeoutMs: Long = 60_000, done: () -> Boolean) {
    val deadline = System.currentTimeMillis() + timeoutMs
    while (!done()) {
        check(System.currentTimeMillis() < deadline) { "Timed out waiting for $what" }
        Thread.sleep(50)
    }
}
