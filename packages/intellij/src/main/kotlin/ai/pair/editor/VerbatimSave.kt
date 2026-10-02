package ai.pair.editor

import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.TrailingSpacesOptionsProvider
import com.intellij.openapi.editor.Document
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import java.util.concurrent.ConcurrentHashMap

/**
 * Saves what the agent typed, as typed. IntelliJ strips trailing spaces on save by default (VS Code doesn't),
 * and stripping an indented line the agent is about to type on would count as the programmer's edit.
 * Registered first, as the stripper takes each option from the first provider that sets it.
 */
class VerbatimSave : TrailingSpacesOptionsProvider {
    override fun getOptions(project: Project, file: VirtualFile): TrailingSpacesOptionsProvider.Options? =
        if (file in saving) Untouched else null

    companion object {
        private val saving = ConcurrentHashMap.newKeySet<VirtualFile>()

        fun save(document: Document) {
            val manager = FileDocumentManager.getInstance()
            val file = manager.getFile(document) ?: return manager.saveDocument(document)
            saving.add(file)
            try {
                manager.saveDocument(document)
            } finally {
                saving.remove(file)
            }
        }
    }
}

private object Untouched : TrailingSpacesOptionsProvider.Options {
    override fun getStripTrailingSpaces() = false
    override fun getEnsureNewLineAtEOF() = false
    override fun getRemoveTrailingBlankLines() = false
    override fun getChangedLinesOnly(): Boolean? = null
    override fun getKeepTrailingSpacesOnCaretLine(): Boolean? = null
}
