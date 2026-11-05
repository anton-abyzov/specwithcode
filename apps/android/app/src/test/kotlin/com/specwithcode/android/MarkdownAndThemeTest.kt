package com.specwithcode.android

import com.specwithcode.android.ui.chat.approvalChoices
import com.specwithcode.android.ui.chat.approvalTitle
import com.specwithcode.android.ui.chat.thoughtLabel
import com.specwithcode.android.ui.chat.toolGlyph
import com.specwithcode.android.ui.components.MarkdownParser
import com.specwithcode.android.ui.components.MarkdownParser.Block
import com.specwithcode.android.ui.components.MarkdownParser.Span
import com.specwithcode.android.ui.components.isSafeLink
import com.specwithcode.android.ui.theme.WeaveContrast
import com.specwithcode.android.ui.theme.WeaveTint
import com.specwithcode.android.ui.theme.WeaveToken
import com.specwithcode.sync.ApprovalChoice
import com.specwithcode.sync.ApprovalDecision
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class MarkdownAndThemeTest {
    @Test fun blocksParse() {
        val md = "# Release\n\nShipped **3.1.0**.\n\n- one\n- two\n\n1. first\n2. second\n\n```bash\nnpm test\n```\n\n> note\n\n---"
        assertEquals(
            listOf(
                Block.Heading(1, "Release"),
                Block.Paragraph("Shipped **3.1.0**."),
                Block.ListBlock(false, listOf("one", "two")),
                Block.ListBlock(true, listOf("first", "second"), 1),
                Block.Code("bash", "npm test"),
                Block.Quote("note"),
                Block.Rule,
            ),
            MarkdownParser.parse(md),
        )
    }

    @Test fun unclosedFenceRunsToTheEndWhileStreaming() {
        assertEquals(listOf(Block.Paragraph("Run:"), Block.Code(null, "git push\ngit tag")), MarkdownParser.parse("Run:\n```\ngit push\ngit tag"))
    }

    @Test fun inlineSpans() {
        assertEquals(
            listOf(Span("Use "), Span("npm test", code = true), Span(" and "), Span("read", bold = true), Span(" "), Span("this", italic = true), Span(" "), Span("docs", url = "https://spec-weave.com")),
            MarkdownParser.inline("Use `npm test` and **read** *this* [docs](https://spec-weave.com)"),
        )
        assertEquals(listOf(Span("snake_case_name stays")), MarkdownParser.inline("snake_case_name stays"))
        assertEquals(listOf(Span("2 * 3")), MarkdownParser.inline("2 * 3"))
        assertTrue(isSafeLink("https://a.b"))
        assertFalse(isSafeLink("javascript:alert(1)"))
        assertFalse(isSafeLink("intent://x"))
    }

    @Test fun weaveColorsMeetContrast() {
        assertEquals(emptyList(), WeaveContrast.failures())
        assertEquals(0xFF7C3AED, WeaveTint.resolve("violet", dark = false))
        assertEquals(0xFFA78BFA, WeaveTint.resolve("Violet", dark = true))
        assertEquals(0xFF112233, WeaveTint.resolve("#123", dark = false))
        assertEquals(null, WeaveTint.resolve("nope", dark = false))
        assertEquals(0xFF5B6CFF, WeaveToken.BRAND)
    }

    @Test fun transcriptLabels() {
        assertEquals("Thought", thoughtLabel(null))
        assertEquals("Thought for 12s", thoughtLabel(12))
        assertEquals("Thought for 1m 5s", thoughtLabel(65))
        assertEquals("Thought for 1h 1m", thoughtLabel(3660))
        assertEquals("Command approval", approvalTitle("command"))
        assertEquals("Approval needed", approvalTitle(null))
        assertEquals(listOf(ApprovalDecision.Approve, ApprovalDecision.ApproveForSession, ApprovalDecision.Deny), approvalChoices(emptyList()).map { it.decision })
        val provider = listOf(ApprovalChoice(ApprovalDecision.Deny, "No"), ApprovalChoice(ApprovalDecision.Approve, "Yes"))
        assertEquals(listOf("Yes", "No"), approvalChoices(provider).map { it.label })
        assertEquals("Command", toolGlyph("terminal").second)
        assertEquals("File change", toolGlyph("pencil").second)
    }
}
