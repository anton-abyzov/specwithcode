package com.specwithcode.android.ui.chat

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.specwithcode.android.ui.components.Banner
import com.specwithcode.android.ui.components.COLLAPSE_THRESHOLD
import com.specwithcode.android.ui.components.MarkdownText
import com.specwithcode.android.ui.components.StatusChip
import com.specwithcode.android.ui.components.Tone
import com.specwithcode.android.ui.components.inlineString
import com.specwithcode.android.ui.theme.Weave
import com.specwithcode.android.ui.theme.WeaveCodeStyle
import com.specwithcode.android.ui.theme.WeaveRadius
import com.specwithcode.android.ui.theme.WeaveSize
import com.specwithcode.android.ui.theme.WeaveSpacing
import com.specwithcode.sync.AccessAnswer
import com.specwithcode.sync.AccessRequestRow
import com.specwithcode.sync.AccessScope
import com.specwithcode.sync.ApprovalChoice
import com.specwithcode.sync.ApprovalDecision
import com.specwithcode.sync.ThreadRef
import com.specwithcode.sync.TodoStep
import com.specwithcode.sync.ToolStatus
import com.specwithcode.sync.TranscriptRow
import com.specwithcode.sync.TranscriptRow.Kind
import com.specwithcode.sync.UserMessageState

/** Actions a transcript row can take. */
class RowActions(
    val onDecision: (requestId: String, decision: ApprovalDecision) -> Unit = { _, _ -> },
    val onAccess: (AccessRequestRow, AccessAnswer) -> Unit = { _, _ -> },
    val onOpenThread: (ThreadRef) -> Unit = {},
)

/** One transcript row drawn with the matching Weave component. */
@Composable
fun TranscriptRowView(row: TranscriptRow, busyRequests: Set<String>, actions: RowActions, modifier: Modifier = Modifier) {
    val inset = Modifier.padding(start = WeaveSpacing.s2, end = WeaveSpacing.s2)
    Box(modifier.fillMaxWidth().testTag("transcript.row.${row.kind.tagName()}")) {
        when (val kind = row.kind) {
            is Kind.User -> UserBubble(kind)
            is Kind.Assistant -> if (kind.markdown.isNotEmpty() || !kind.streaming) {
                MarkdownText(kind.markdown, inset, collapsible = !kind.streaming && kind.markdown.length > COLLAPSE_THRESHOLD)
            } else {
                Text("…", style = MaterialTheme.typography.bodyLarge, color = Weave.colors.muted, modifier = inset)
            }
            is Kind.Reasoning -> ReasoningRow(kind, inset)
            is Kind.Tool -> ToolRow(kind, inset)
            is Kind.Plan -> PlanCard(kind.steps)
            is Kind.ProposedPlan -> Card {
                CardTitle("Proposed plan")
                MarkdownText(kind.markdown, collapsible = kind.markdown.length > COLLAPSE_THRESHOLD)
            }
            is Kind.Approval -> ApprovalCard(kind, kind.requestId in busyRequests) { actions.onDecision(kind.requestId, it) }
            is Kind.Question -> QuestionCard(kind)
            is Kind.Access -> AccessCard(kind.request, kind.request.itemId in busyRequests) { actions.onAccess(kind.request, it) }
            is Kind.Subagent -> SubagentRow(kind, actions.onOpenThread, inset)
            is Kind.Error -> Banner(kind.message, Tone.Fail)
            is Kind.Notice -> Text(
                kind.text,
                style = MaterialTheme.typography.bodySmall,
                color = Weave.colors.muted,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth().padding(vertical = WeaveSpacing.s1),
            )
            is Kind.Fold -> FoldRow(kind, inset)
        }
    }
}

internal fun Kind.tagName(): String = when (this) {
    is Kind.User -> "user"
    is Kind.Assistant -> "assistant"
    is Kind.Reasoning -> "reasoning"
    is Kind.Tool -> "tool"
    is Kind.Plan -> "plan"
    is Kind.ProposedPlan -> "proposedPlan"
    is Kind.Approval -> "approval"
    is Kind.Question -> "question"
    is Kind.Access -> "access"
    is Kind.Subagent -> "subagent"
    is Kind.Error -> "error"
    is Kind.Notice -> "notice"
    is Kind.Fold -> "fold"
}

/** The note under a message that has not simply been sent. */
internal fun UserMessageState.footnote(): String? = when (this) {
    UserMessageState.Sent -> null
    UserMessageState.Sending -> "Sending…"
    UserMessageState.Queued -> "Queued"
    UserMessageState.Held -> "On hold"
}

@Composable
private fun UserBubble(kind: Kind.User) {
    val colors = Weave.colors
    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.End) {
        if (kind.attachments.isNotEmpty()) {
            val count = kind.attachments.size
            StatusChip(if (count == 1) "1 attachment" else "$count attachments", Tone.Neutral, Modifier.padding(bottom = WeaveSpacing.s1))
        }
        if (kind.text.isNotEmpty()) {
            SelectionContainer {
                Text(
                    inlineString(kind.text, colors),
                    style = MaterialTheme.typography.bodyLarge,
                    color = colors.ink,
                    modifier = Modifier
                        .widthIn(max = 320.dp)
                        .clip(RoundedCornerShape(WeaveRadius.bubble))
                        .background(colors.bubble)
                        .padding(horizontal = 14.dp, vertical = 10.dp),
                )
            }
        }
        kind.state.footnote()?.let {
            Text(it, style = MaterialTheme.typography.bodySmall, color = colors.muted, modifier = Modifier.padding(top = 2.dp, end = 4.dp))
        }
    }
}

/** "Thought for 12s", "Thought for 1m 5s", or "Thought" when unmeasured. */
internal fun thoughtLabel(seconds: Int?): String {
    if (seconds == null) return "Thought"
    if (seconds < 60) return "Thought for ${seconds}s"
    val h = seconds / 3600
    val m = (seconds % 3600) / 60
    val s = seconds % 60
    return "Thought for " + listOfNotNull(h.takeIf { it > 0 }?.let { "${it}h" }, m.takeIf { it > 0 }?.let { "${it}m" }, s.takeIf { it > 0 }?.let { "${it}s" }).joinToString(" ")
}

@Composable
private fun ReasoningRow(kind: Kind.Reasoning, modifier: Modifier) {
    var expanded by rememberSaveable { mutableStateOf(false) }
    val label = if (kind.streaming) "Thinking…" else thoughtLabel(kind.seconds)
    Column(modifier.animateContentSize()) {
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = WeaveSize.minTap)
                .clickable(role = Role.Button, onClickLabel = if (expanded) "Hide reasoning" else "Show reasoning") { expanded = !expanded }
                .semantics { stateDescription = if (expanded) "Expanded" else "Collapsed" },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(label, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium, color = Weave.colors.muted)
            Icon(
                if (expanded) Icons.Filled.KeyboardArrowUp else Icons.Filled.KeyboardArrowDown,
                contentDescription = null,
                tint = Weave.colors.muted,
                modifier = Modifier.size(18.dp),
            )
        }
        if (expanded) {
            SelectionContainer {
                Text(kind.text, style = MaterialTheme.typography.bodyMedium, color = Weave.colors.muted, modifier = Modifier.padding(start = WeaveSpacing.s3))
            }
        }
    }
}

/** What kind of step a tool symbol names, read aloud and shown as a small glyph. */
internal fun toolGlyph(symbol: String): Pair<String, String> = when {
    symbol.contains("terminal") -> ">_" to "Command"
    symbol.contains("pencil") || symbol.contains("square.and.pencil") -> "±" to "File change"
    symbol.contains("doc") -> "¶" to "File"
    symbol.contains("magnifyingglass") -> "⌕" to "Search"
    symbol.contains("globe") || symbol.contains("network") -> "◎" to "Web"
    else -> "•" to "Step"
}

@Composable
private fun ToolRow(kind: Kind.Tool, modifier: Modifier) {
    val colors = Weave.colors
    val (glyph, category) = toolGlyph(kind.symbol)
    var expanded by rememberSaveable { mutableStateOf(false) }
    val statusText = when (kind.status) {
        ToolStatus.Running -> "running"
        ToolStatus.Completed -> "done"
        ToolStatus.Failed -> "failed"
    }
    Column(
        modifier
            .fillMaxWidth()
            .heightIn(min = WeaveSize.minTap)
            .then(if (kind.detail != null) Modifier.clickable(role = Role.Button) { expanded = !expanded } else Modifier)
            .semantics(mergeDescendants = true) { contentDescription = "$category: ${kind.title}, $statusText" }
            .padding(vertical = WeaveSpacing.s2),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(glyph, style = WeaveCodeStyle, color = colors.muted, modifier = Modifier.widthIn(min = 24.dp))
            Text(
                kind.title,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.Medium,
                color = if (kind.status == ToolStatus.Failed) colors.fail else colors.ink,
                modifier = Modifier.weight(1f),
                maxLines = if (expanded) Int.MAX_VALUE else 2,
            )
            Spacer(Modifier.size(WeaveSpacing.s2))
            ProgressMark(kind.status)
        }
        if (kind.detail != null) {
            Text(
                kind.detail!!,
                style = WeaveCodeStyle,
                color = colors.muted,
                maxLines = if (expanded) Int.MAX_VALUE else 1,
                modifier = Modifier.padding(start = 24.dp, top = 2.dp),
            )
        }
    }
}

@Composable
private fun ProgressMark(status: ToolStatus) {
    val colors = Weave.colors
    when (status) {
        ToolStatus.Running -> CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp, color = colors.iris)
        ToolStatus.Completed -> Icon(Icons.Filled.Check, contentDescription = null, tint = colors.pass, modifier = Modifier.size(16.dp))
        ToolStatus.Failed -> Icon(Icons.Filled.Close, contentDescription = null, tint = colors.fail, modifier = Modifier.size(16.dp))
    }
}

@Composable
private fun Card(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    val colors = Weave.colors
    Column(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(WeaveRadius.card))
            .background(colors.panel)
            .border(0.5.dp, colors.line, RoundedCornerShape(WeaveRadius.card))
            .padding(WeaveSpacing.s4),
        verticalArrangement = Arrangement.spacedBy(WeaveSpacing.s3),
    ) { content() }
}

@Composable
private fun CardTitle(text: String, chip: String? = null, tone: Tone = Tone.Neutral) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(text, style = MaterialTheme.typography.labelLarge, color = Weave.colors.ink, modifier = Modifier.weight(1f))
        if (chip != null) StatusChip(chip, tone)
    }
}

@Composable
private fun PlanCard(steps: List<TodoStep>) {
    val done = steps.count { it.status == TodoStep.Status.Completed }
    Card(Modifier.testTag("plan.card")) {
        CardTitle("Plan", "$done of ${steps.size}", if (done == steps.size) Tone.Pass else Tone.Accent)
        for (step in steps) {
            val colors = Weave.colors
            val state = when (step.status) {
                TodoStep.Status.Pending -> "to do"
                TodoStep.Status.Running -> "in progress"
                TodoStep.Status.Completed -> "done"
            }
            Row(Modifier.semantics(mergeDescendants = true) { contentDescription = "${step.text}, $state" }, verticalAlignment = Alignment.CenterVertically) {
                Box(
                    Modifier
                        .size(16.dp)
                        .clip(CircleShape)
                        .then(
                            when (step.status) {
                                TodoStep.Status.Completed -> Modifier.background(colors.pass)
                                TodoStep.Status.Running -> Modifier.border(2.dp, colors.iris, CircleShape)
                                TodoStep.Status.Pending -> Modifier.border(1.5.dp, colors.control, CircleShape)
                            },
                        ),
                    contentAlignment = Alignment.Center,
                ) {
                    if (step.status == TodoStep.Status.Completed) Icon(Icons.Filled.Check, null, tint = colors.panel, modifier = Modifier.size(12.dp))
                }
                Text(
                    step.text,
                    style = MaterialTheme.typography.bodyMedium,
                    color = if (step.status == TodoStep.Status.Completed) colors.muted else colors.ink,
                    fontWeight = if (step.status == TodoStep.Status.Running) FontWeight.SemiBold else null,
                    modifier = Modifier.padding(start = WeaveSpacing.s3),
                )
            }
        }
    }
}

/** What an approval card is for, from the wire request kind. */
internal fun approvalTitle(kind: String?): String = when (kind) {
    "command" -> "Command approval"
    "file-read" -> "File read approval"
    "file-change" -> "File change approval"
    "mcp-elicitation" -> "App access approval"
    "permission" -> "App permission approval"
    else -> "Approval needed"
}

/** The provider's choices in a fixed order, or Approve, For session and Deny when it lists none. */
internal fun approvalChoices(options: List<ApprovalChoice>): List<ApprovalChoice> {
    if (options.isEmpty()) {
        return listOf(
            ApprovalChoice(ApprovalDecision.Approve, "Approve"),
            ApprovalChoice(ApprovalDecision.ApproveForSession, "For session"),
            ApprovalChoice(ApprovalDecision.Deny, "Deny"),
        )
    }
    return options.sortedBy { it.decision.ordinal }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ApprovalCard(kind: Kind.Approval, busy: Boolean, onDecision: (ApprovalDecision) -> Unit) {
    val colors = Weave.colors
    Card(Modifier.testTag("approval.card")) {
        CardTitle(approvalTitle(kind.kind), if (kind.resolved) "Answered" else "Needs you", if (kind.resolved) Tone.Neutral else Tone.Warn)
        Box(
            Modifier
                .fillMaxWidth()
                .heightIn(max = 160.dp)
                .clip(RoundedCornerShape(WeaveRadius.md))
                .background(colors.sunken)
                .verticalScroll(rememberScrollState())
                .padding(WeaveSpacing.s3),
        ) {
            SelectionContainer { Text(kind.prompt, style = WeaveCodeStyle, color = colors.ink) }
        }
        if (!kind.resolved) {
            val choices = approvalChoices(kind.options)
            choices.firstOrNull { it.warning != null }?.warning?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, color = colors.warn)
            }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(WeaveSpacing.s2), verticalArrangement = Arrangement.spacedBy(WeaveSpacing.s2)) {
                for (choice in choices) {
                    val tag = "approval.${choice.decision.name.lowercase()}"
                    when (choice.decision) {
                        ApprovalDecision.Approve -> Button(
                            onClick = { onDecision(choice.decision) },
                            enabled = !busy,
                            modifier = Modifier.defaultMinSize(minHeight = WeaveSize.minTap).testTag(tag),
                        ) { Text(choice.label) }
                        ApprovalDecision.Cancel -> TextButton(
                            onClick = { onDecision(choice.decision) },
                            enabled = !busy,
                            modifier = Modifier.defaultMinSize(minHeight = WeaveSize.minTap).testTag(tag),
                        ) { Text(choice.label) }
                        else -> OutlinedButton(
                            onClick = { onDecision(choice.decision) },
                            enabled = !busy,
                            modifier = Modifier.defaultMinSize(minHeight = WeaveSize.minTap).testTag(tag),
                        ) { Text(choice.label) }
                    }
                }
            }
            if (busy) Text("Sending your answer…", style = MaterialTheme.typography.bodySmall, color = colors.muted)
        }
    }
}

@Composable
private fun QuestionCard(kind: Kind.Question) {
    val colors = Weave.colors
    Card(Modifier.testTag("question.card")) {
        CardTitle("Question", if (kind.resolved) "Answered" else null)
        SelectionContainer {
            Text(kind.prompt, style = MaterialTheme.typography.bodyLarge, color = if (kind.resolved) colors.muted else colors.ink)
        }
        if (!kind.resolved) Text("Reply in the message box below.", style = MaterialTheme.typography.bodySmall, color = colors.muted)
    }
}

internal fun AccessRequestRow.State.label(): String = when (this) {
    AccessRequestRow.State.Pending -> "Waiting"
    AccessRequestRow.State.AllowedInThread -> "Allowed in this thread"
    AccessRequestRow.State.AllowedOnMachine -> "Allowed on this computer"
    AccessRequestRow.State.Denied -> "Denied"
    AccessRequestRow.State.Ended -> "No longer needed"
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun AccessCard(request: AccessRequestRow, busy: Boolean, onAnswer: (AccessAnswer) -> Unit) {
    val colors = Weave.colors
    Card(Modifier.testTag("access.card")) {
        CardTitle(
            request.headline(null),
            request.state.label(),
            when (request.state) {
                AccessRequestRow.State.Pending -> Tone.Warn
                AccessRequestRow.State.Denied, AccessRequestRow.State.Ended -> Tone.Neutral
                else -> Tone.Pass
            },
        )
        if (request.reason.isNotBlank()) Text(request.reason, style = MaterialTheme.typography.bodyMedium, color = colors.ink)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(WeaveSpacing.s2), verticalArrangement = Arrangement.spacedBy(WeaveSpacing.s2)) {
            for (subject in request.subjects) {
                Column(
                    Modifier
                        .clip(RoundedCornerShape(WeaveRadius.md))
                        .background(colors.sunken)
                        .padding(horizontal = WeaveSpacing.s3, vertical = WeaveSpacing.s2),
                ) {
                    Text(subject.label, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium, color = colors.ink)
                    Text(request.tag(subject), style = MaterialTheme.typography.bodySmall, color = colors.muted)
                }
            }
        }
        if (request.awaitsAnswerHere) {
            Text(request.note, style = MaterialTheme.typography.bodySmall, color = colors.muted)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(WeaveSpacing.s2), verticalArrangement = Arrangement.spacedBy(WeaveSpacing.s2)) {
                Button(
                    onClick = { onAnswer(AccessAnswer.Allow(AccessScope.Thread)) },
                    enabled = !busy,
                    modifier = Modifier.defaultMinSize(minHeight = WeaveSize.minTap).testTag("access.allow.thread"),
                ) { Text("Allow in this thread") }
                OutlinedButton(
                    onClick = { onAnswer(AccessAnswer.Allow(AccessScope.Machine)) },
                    enabled = !busy,
                    modifier = Modifier.defaultMinSize(minHeight = WeaveSize.minTap).testTag("access.allow.machine"),
                ) { Text("Allow on this computer") }
                TextButton(
                    onClick = { onAnswer(AccessAnswer.Deny) },
                    enabled = !busy,
                    modifier = Modifier.defaultMinSize(minHeight = WeaveSize.minTap).testTag("access.deny"),
                ) { Text("Deny") }
            }
        } else if (request.isInherited && request.isPending) {
            Text("Answer this in the thread it came from.", style = MaterialTheme.typography.bodySmall, color = colors.muted)
        }
    }
}

@Composable
private fun SubagentRow(kind: Kind.Subagent, onOpen: (ThreadRef) -> Unit, modifier: Modifier) {
    val colors = Weave.colors
    val child = kind.child
    Row(
        modifier
            .fillMaxWidth()
            .heightIn(min = WeaveSize.minTap)
            .then(if (child != null) Modifier.clickable(role = Role.Button, onClickLabel = "Open the thread") { onOpen(child) } else Modifier)
            .semantics(mergeDescendants = true) { contentDescription = "Sub-thread: ${kind.title}" },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("⑂", style = WeaveCodeStyle, color = colors.muted, modifier = Modifier.widthIn(min = 24.dp))
        Column(Modifier.weight(1f)) {
            Text(kind.title, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium, color = colors.ink, maxLines = 2)
            Text(
                when {
                    kind.isRunning -> "Sub-thread · Working"
                    child != null -> "Sub-thread · Open"
                    else -> "Sub-thread"
                },
                style = MaterialTheme.typography.bodySmall,
                color = if (child != null) colors.iris else colors.muted,
            )
        }
        if (child != null) Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null, tint = colors.control)
    }
}

@Composable
private fun FoldRow(kind: Kind.Fold, modifier: Modifier) {
    val colors = Weave.colors
    Row(modifier.fillMaxWidth().heightIn(min = WeaveSize.minTap), verticalAlignment = Alignment.CenterVertically) {
        if (kind.running) CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp, color = colors.iris)
        Text(
            listOfNotNull(kind.label, kind.summary).joinToString(" · "),
            style = MaterialTheme.typography.bodyMedium,
            color = colors.muted,
            modifier = Modifier.padding(start = if (kind.running) WeaveSpacing.s2 else 0.dp).weight(1f),
        )
        if (kind.failures > 0) StatusChip(if (kind.failures == 1) "1 failed" else "${kind.failures} failed", Tone.Fail)
    }
}
