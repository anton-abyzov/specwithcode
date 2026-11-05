package com.specwithcode.android.ui.components

/**
 * A small Markdown reader for replies: headings, paragraphs, lists, quotes, rules and fenced
 * code blocks, with inline code, bold, italic and links. Pure Kotlin, so it is unit tested on
 * the JVM. An unclosed fence (a reply still streaming) runs to the end as code.
 */
object MarkdownParser {
    sealed interface Block {
        data class Heading(val level: Int, val text: String) : Block
        data class Paragraph(val text: String) : Block
        data class ListBlock(val ordered: Boolean, val items: List<String>, val start: Int = 1) : Block
        data class Quote(val text: String) : Block
        data class Code(val language: String?, val code: String) : Block
        data object Rule : Block
    }

    data class Span(
        val text: String,
        val bold: Boolean = false,
        val italic: Boolean = false,
        val code: Boolean = false,
        val url: String? = null,
    )

    private val heading = Regex("^(#{1,6})\\s+(.*)$")
    private val bullet = Regex("^\\s*[-*+]\\s+(.*)$")
    private val ordered = Regex("^\\s*(\\d+)[.)]\\s+(.*)$")
    private val rule = Regex("^\\s*([-*_])(\\s*\\1){2,}\\s*$")

    fun parse(markdown: String): List<Block> {
        val lines = markdown.replace("\r\n", "\n").split('\n')
        val blocks = mutableListOf<Block>()
        val paragraph = mutableListOf<String>()
        fun flush() {
            if (paragraph.isNotEmpty()) blocks += Block.Paragraph(paragraph.joinToString("\n").trim())
            paragraph.clear()
        }
        var i = 0
        while (i < lines.size) {
            val line = lines[i]
            val trimmed = line.trim()
            when {
                trimmed.startsWith("```") || trimmed.startsWith("~~~") -> {
                    flush()
                    val fence = trimmed.take(3)
                    val language = trimmed.drop(3).trim().takeIf { it.isNotEmpty() }
                    val code = mutableListOf<String>()
                    i++
                    while (i < lines.size && !lines[i].trim().startsWith(fence)) {
                        code += lines[i]
                        i++
                    }
                    blocks += Block.Code(language, code.joinToString("\n"))
                }
                trimmed.isEmpty() -> flush()
                heading.matches(trimmed) -> {
                    flush()
                    val m = heading.find(trimmed)!!
                    blocks += Block.Heading(m.groupValues[1].length, m.groupValues[2].trim().trimEnd('#').trim())
                }
                rule.matches(trimmed) -> {
                    flush()
                    blocks += Block.Rule
                }
                trimmed.startsWith(">") -> {
                    flush()
                    val quote = mutableListOf<String>()
                    while (i < lines.size && lines[i].trim().startsWith(">")) {
                        quote += lines[i].trim().removePrefix(">").trim()
                        i++
                    }
                    blocks += Block.Quote(quote.joinToString("\n"))
                    continue
                }
                bullet.matches(line) || ordered.matches(line) -> {
                    flush()
                    val isOrdered = !bullet.matches(line)
                    val start = if (isOrdered) ordered.find(line)!!.groupValues[1].toIntOrNull() ?: 1 else 1
                    val items = mutableListOf<String>()
                    while (i < lines.size) {
                        val current = lines[i]
                        val match = if (isOrdered) ordered.find(current)?.groupValues?.get(2) else bullet.find(current)?.groupValues?.get(1)
                        when {
                            match != null && (if (isOrdered) ordered.matches(current) else bullet.matches(current)) -> items += match
                            current.isNotBlank() && current.startsWith("  ") && items.isNotEmpty() ->
                                items[items.lastIndex] = items.last() + " " + current.trim()
                            else -> break
                        }
                        i++
                    }
                    blocks += Block.ListBlock(isOrdered, items, start)
                    continue
                }
                else -> paragraph += line
            }
            i++
        }
        flush()
        return blocks
    }

    /** Splits inline Markdown into styled spans. Unmatched markers stay as text. */
    fun inline(text: String): List<Span> {
        val out = mutableListOf<Span>()
        val plain = StringBuilder()
        fun emit(span: Span) {
            if (plain.isNotEmpty()) {
                out += Span(plain.toString())
                plain.clear()
            }
            out += span
        }
        var i = 0
        while (i < text.length) {
            val c = text[i]
            when {
                c == '`' -> {
                    val end = text.indexOf('`', i + 1)
                    if (end > i) {
                        emit(Span(text.substring(i + 1, end), code = true))
                        i = end + 1
                        continue
                    }
                }
                c == '[' -> {
                    val close = text.indexOf("](", i + 1)
                    val end = if (close > i) text.indexOf(')', close + 2) else -1
                    if (close > i && end > close) {
                        val label = text.substring(i + 1, close)
                        val url = text.substring(close + 2, end).trim()
                        for (span in inline(label)) emit(span.copy(url = url))
                        i = end + 1
                        continue
                    }
                }
                text.startsWith("**", i) || text.startsWith("__", i) -> {
                    val marker = text.substring(i, i + 2)
                    val end = text.indexOf(marker, i + 2)
                    if (end > i + 2) {
                        for (span in inline(text.substring(i + 2, end))) emit(span.copy(bold = true))
                        i = end + 2
                        continue
                    }
                }
                c == '*' || (c == '_' && (i == 0 || !text[i - 1].isLetterOrDigit())) -> {
                    val end = text.indexOf(c, i + 1)
                    val valid = end > i + 1 && !text[i + 1].isWhitespace() &&
                        (c == '*' || end + 1 >= text.length || !text[end + 1].isLetterOrDigit())
                    if (valid) {
                        for (span in inline(text.substring(i + 1, end))) emit(span.copy(italic = true))
                        i = end + 1
                        continue
                    }
                }
            }
            plain.append(c)
            i++
        }
        if (plain.isNotEmpty()) out += Span(plain.toString())
        return out
    }
}
