package ai.pair.editor

import ai.pair.host.PairHost
import com.intellij.openapi.components.serviceIfCreated
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.TrailingSpacesOptionsProvider
import com.intellij.openapi.editor.Document
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.io.FileUtil
import com.intellij.openapi.vfs.VirtualFile
import java.util.concurrent.ConcurrentHashMap

/**
 * Saves what the agent typed, as typed. IntelliJ strips trailing spaces on save by default (VS Code doesn't),
 * and stripping an indented line the agent is about to type on would count as the programmer's edit. That goes for
 * the agent's own saves, and during a session for any save of the file it's typing in, such as the IDE's autosave
 * when its window loses focus or sits idle: as IntelliJ keeps the spaces on the programmer's caret line.
 * Registered first, as the stripper takes each option from the first provider that sets it.
 */
class VerbatimSave : TrailingSpacesOptionsProvider {
    override fun getOptions(project: Project, file: VirtualFile): TrailingSpacesOptionsProvider.Options? =
        if (file in saving || isAgentFile(project, file)) Untouched else null

    private fun isAgentFile(project: Project, file: VirtualFile): Boolean {
        val agentFile = project.serviceIfCreated<PairHost>()?.editor?.agentFile() ?: return false
        return FileUtil.pathsEqual(FileUtil.toSystemDependentName(file.path), agentFile)
    }

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
