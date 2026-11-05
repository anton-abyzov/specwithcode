package com.specwithcode.android.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import com.specwithcode.android.ui.theme.Weave
import com.specwithcode.android.ui.theme.WeaveCodeStyle
import com.specwithcode.android.ui.theme.WeaveColors
import com.specwithcode.android.ui.theme.WeaveMono
import com.specwithcode.android.ui.theme.WeaveRadius
import com.specwithcode.android.ui.theme.WeaveSpacing

/** Replies longer than this collapse behind "Show more". */
const val COLLAPSE_THRESHOLD = 1_200

/** Renders Markdown with selectable text, tappable links and scrollable code blocks. */
@Composable
fun MarkdownText(markdown: String, modifier: Modifier = Modifier, collapsible: Boolean = false) {
    val blocks = remember(markdown) { MarkdownParser.parse(markdown) }
    var expanded by rememberSaveable(markdown.length > COLLAPSE_THRESHOLD) { mutableStateOf(false) }
    val collapsed = collapsible && !expanded
    val colors = Weave.colors
    Column(modifier, verticalArrangement = Arrangement.spacedBy(WeaveSpacing.s3)) {
        SelectionContainer {
            Column(
                Modifier.then(if (collapsed) Modifier.heightIn(max = 280.dp).clip(RoundedCornerShape(0.dp)) else Modifier),
                verticalArrangement = Arrangement.spacedBy(WeaveSpacing.s3),
            ) {
                for (block in blocks) MarkdownBlock(block, colors)
            }
        }
        if (collapsible) {
            TextButton(onClick = { expanded = !expanded }) { Text(if (expanded) "Show less" else "Show more") }
        }
    }
}

@Composable
private fun MarkdownBlock(block: MarkdownParser.Block, colors: WeaveColors) {
    val type = MaterialTheme.typography
    when (block) {
        is MarkdownParser.Block.Heading -> Text(
            inlineString(block.text, colors),
            style = when (block.level) {
                1 -> type.titleLarge
                2 -> type.titleMedium
                else -> type.labelLarge
            },
            color = colors.ink,
        )
        is MarkdownParser.Block.Paragraph -> Text(inlineString(block.text, colors), style = type.bodyLarge, color = colors.ink)
        is MarkdownParser.Block.ListBlock -> Column(verticalArrangement = Arrangement.spacedBy(WeaveSpacing.s1)) {
            block.items.forEachIndexed { index, item ->
                Row {
                    Text(
                        if (block.ordered) "${block.start + index}." else "•",
                        style = type.bodyLarge,
                        color = colors.muted,
                        modifier = Modifier.width(24.dp),
                    )
                    Text(inlineString(item, colors), style = type.bodyLarge, color = colors.ink)
                }
            }
        }
        is MarkdownParser.Block.Quote -> Row {
            Box(Modifier.width(3.dp).heightIn(min = 20.dp).background(colors.line))
            Text(
                inlineString(block.text, colors),
                style = type.bodyLarge,
                color = colors.muted,
                modifier = Modifier.padding(start = WeaveSpacing.s3),
            )
        }
        is MarkdownParser.Block.Code -> CodeBlock(block.code, language = block.language)
        MarkdownParser.Block.Rule -> HorizontalDivider(color = colors.line)
    }
}

/** A fenced code block: monospace, scrolls sideways instead of wrapping. */
@Composable
fun CodeBlock(code: String, modifier: Modifier = Modifier, language: String? = null) {
    val colors = Weave.colors
    Column(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(WeaveRadius.lg))
            .background(colors.sunken)
            .padding(WeaveSpacing.s3),
    ) {
        if (!language.isNullOrBlank()) {
            Text(language, style = MaterialTheme.typography.labelSmall, color = colors.muted)
        }
        Text(
            code,
            style = WeaveCodeStyle,
            color = colors.ink,
            softWrap = false,
            modifier = Modifier.horizontalScroll(rememberScrollState()),
        )
    }
}

fun inlineString(text: String, colors: WeaveColors): AnnotatedString = buildAnnotatedString {
    for (span in MarkdownParser.inline(text)) {
        val style = SpanStyle(
            fontWeight = if (span.bold) FontWeight.SemiBold else null,
            fontStyle = if (span.italic) FontStyle.Italic else null,
            fontFamily = if (span.code) WeaveMono else null,
            background = if (span.code) colors.sunken else androidx.compose.ui.graphics.Color.Unspecified,
        )
        if (span.url != null && isSafeLink(span.url)) {
            withLink(
                LinkAnnotation.Url(
                    span.url,
                    TextLinkStyles(SpanStyle(color = colors.iris, textDecoration = TextDecoration.Underline)),
                ),
            ) { withStyle(style) { append(span.text) } }
        } else {
            withStyle(style) { append(span.text) }
        }
    }
}

/** Only web and mail links open; anything else stays plain text. */
internal fun isSafeLink(url: String): Boolean {
    val lower = url.lowercase()
    return lower.startsWith("https://") || lower.startsWith("http://") || lower.startsWith("mailto:")
}
