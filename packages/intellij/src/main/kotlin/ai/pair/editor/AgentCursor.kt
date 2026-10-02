package ai.pair.editor

import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.markup.EffectType
import com.intellij.openapi.editor.colors.EditorFontType
import com.intellij.openapi.editor.markup.CustomHighlighterRenderer
import com.intellij.openapi.editor.markup.HighlighterLayer
import com.intellij.openapi.editor.markup.HighlighterTargetArea
import com.intellij.openapi.editor.markup.RangeHighlighter
import com.intellij.openapi.editor.markup.TextAttributes
import com.intellij.ui.JBColor
import java.awt.AlphaComposite
import java.awt.Color
import java.awt.Graphics
import java.awt.Graphics2D
import java.awt.RenderingHints
import javax.swing.Timer

/** The agent's caret: a colored bar with the agent's name above it, drawn over the editor's text. */
class AgentCursor {
    private val highlighters = mutableListOf<RangeHighlighter>()
    private val pointHighlighters = mutableListOf<RangeHighlighter>()
    private var shown: Editor? = null
    private var pulseOn = true
    private val pulse = Timer(450) {
        pulseOn = !pulseOn
        shown?.contentComponent?.repaint()
    }

    fun render(editor: Editor?, offset: Int, selection: IntRange?, state: String) {
        clear()
        if (editor == null) return
        shown = editor
        if (state != "read") pulse.stop()
        else if (!pulse.isRunning) {
            pulseOn = true
            pulse.start()
        }
        val markup = editor.markupModel
        val at = offset.coerceIn(0, editor.document.textLength)
        if (selection != null) {
            val attributes = TextAttributes().apply { backgroundColor = SELECTION }
            highlighters += markup.addRangeHighlighter(
                selection.first, selection.last + 1, HighlighterLayer.SELECTION - 1, attributes, HighlighterTargetArea.EXACT_RANGE,
            )
        }
        highlighters += markup.addRangeHighlighter(at, at, HighlighterLayer.LAST, null, HighlighterTargetArea.EXACT_RANGE).apply {
            customRenderer = CustomHighlighterRenderer { e, h, g -> paint(e, h.startOffset, state, g) }
        }
    }

    private fun clear() {
        for (h in highlighters) h.dispose()
        highlighters.clear()
    }

    fun renderPoint(editor: Editor?, start: Int, end: Int) {
        for (h in pointHighlighters) h.dispose()
        pointHighlighters.clear()
        if (editor == null) return
        val length = editor.document.textLength
        val attributes = TextAttributes().apply {
            backgroundColor = POINT
            effectColor = POINT_BORDER
            effectType = EffectType.ROUNDED_BOX
        }
        pointHighlighters += editor.markupModel.addRangeHighlighter(
            start.coerceIn(0, length), end.coerceIn(0, length), HighlighterLayer.SELECTION - 2, attributes, HighlighterTargetArea.EXACT_RANGE,
        )
    }

    fun dispose() {
        pulse.stop()
        clear()
        renderPoint(null, 0, 0)
    }

    private fun paint(editor: Editor, offset: Int, state: String, g: Graphics) {
        val p = editor.offsetToXY(offset)
        val g2 = g.create() as Graphics2D
        try {
            g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
            val dim = state == "read" && !pulseOn
            g2.composite = AlphaComposite.getInstance(AlphaComposite.SRC_OVER, if (dim) 0.6f else OPACITY[state] ?: 1f)
            g2.color = if (state == "read" && !dim) READ else CURSOR
            g2.fillRect(p.x - 1, p.y, 2, editor.lineHeight)

            val label = LABEL[state]?.let { "$NAME · $it" } ?: NAME
            val font = editor.colorsScheme.getFont(EditorFontType.PLAIN)
            g2.font = font.deriveFont(font.size2D * 0.75f)
            val metrics = g2.fontMetrics
            val height = metrics.height
            val y = if (p.y >= height) p.y - height else p.y + editor.lineHeight
            g2.fillRoundRect(p.x - 1, y, metrics.stringWidth(label) + 8, height, 6, 6)
            g2.color = Color(0x1b1b1b)
            g2.drawString(label, p.x + 3, y + metrics.ascent)
        } finally {
            g2.dispose()
        }
    }

    companion object {
        const val NAME = "Agent"
        val CURSOR = JBColor(0xC2410C, 0xE8875B)
        val READ = JBColor(0xB45309, 0xFACC15)
        val SELECTION = JBColor(Color(0xC2, 0x41, 0x0C, 0x2E), Color(0xE8, 0x87, 0x5B, 0x40))
        val POINT = JBColor(Color(0xB4, 0x53, 0x09, 0x20), Color(0xFA, 0xCC, 0x15, 0x26))
        val POINT_BORDER = JBColor(Color(0xB4, 0x53, 0x09, 0x99), Color(0xFA, 0xCC, 0x15, 0x99))
        val OPACITY = mapOf("thinking" to 0.45f, "running" to 0.6f, "paused" to 0.6f, "listening" to 0.8f, "navigator" to 0.8f)
        val LABEL = mapOf("running" to "running", "paused" to "paused", "listening" to "listening", "navigator" to "your turn")
    }
}
