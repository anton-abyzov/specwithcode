package com.specwithcode.android.ui.chat

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import com.specwithcode.android.ui.theme.Weave
import com.specwithcode.android.ui.theme.WeaveSpacing
import com.specwithcode.sync.ReplyStyle
import com.specwithcode.sync.TimelineDetail

/** What the Show button says to a screen reader: the reply style first, then the level. */
internal fun showMenuDescription(ui: ChatUi): String {
    val show = "Show: ${ui.detail.label}" + if (ui.ownDetail) " (this thread)" else ""
    val replies = ui.replyStyle?.let { "Agent replies: ${it.style.label}. " } ?: ""
    return "$replies$show"
}

/**
 * The chat's Show menu: how the project's agents reply, which rows the conversation shows,
 * and whether that level is this thread's own or the default for every thread.
 */
@Composable
internal fun ShowMenu(
    ui: ChatUi,
    onDetail: (TimelineDetail) -> Unit,
    onThisThread: (Boolean) -> Unit,
    onReplyStyle: (ReplyStyle) -> Unit,
) {
    var open by remember { mutableStateOf(false) }
    IconButton(
        onClick = { open = true },
        modifier = Modifier.testTag("chat.show").semantics { contentDescription = showMenuDescription(ui) },
    ) {
        Icon(Icons.AutoMirrored.Filled.List, contentDescription = null, tint = if (ui.ownDetail) Weave.colors.iris else Weave.colors.ink)
    }
    DropdownMenu(expanded = open, onDismissRequest = { open = false }, modifier = Modifier.widthIn(min = 280.dp, max = 340.dp).testTag("chat.show.menu")) {
        ui.replyStyle?.let { replies ->
            GroupLabel("Agent replies in this project")
            Column(Modifier.selectableGroup()) {
                for (style in ReplyStyle.entries) {
                    ChoiceItem(
                        label = style.label,
                        summary = style.summary,
                        selected = replies.style == style,
                        enabled = replies.canChange && !ui.savingReplyStyle,
                        tag = "chat.show.replies.${style.rawValue}",
                    ) {
                        open = false
                        onReplyStyle(style)
                    }
                }
            }
            if (!replies.canChange) Note(replies.readOnlyReason ?: "How agents reply can't be changed from this phone.", "chat.show.replies.note")
            HorizontalDivider(color = Weave.colors.line)
        }
        GroupLabel("Show")
        Column(Modifier.selectableGroup()) {
            for (level in TimelineDetail.entries) {
                ChoiceItem(level.label, level.summary, selected = ui.detail == level, enabled = true, tag = "chat.show.level.${level.rawValue}") {
                    open = false
                    onDetail(level)
                }
            }
        }
        HorizontalDivider(color = Weave.colors.line)
        GroupLabel("Applies to")
        Column(Modifier.selectableGroup()) {
            // The menu stays open so the level can be picked next.
            ChoiceItem("This thread", null, selected = ui.ownDetail, enabled = true, tag = "chat.show.scope.thread") { onThisThread(true) }
            ChoiceItem("Every thread", null, selected = !ui.ownDetail, enabled = true, tag = "chat.show.scope.every") { onThisThread(false) }
        }
        if (ui.ownDetail) Note("Other threads show ${ui.defaultDetail.label}.", "chat.show.scope.note")
    }
}

@Composable
private fun GroupLabel(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.labelMedium,
        color = Weave.colors.muted,
        modifier = Modifier.padding(horizontal = WeaveSpacing.s4, vertical = WeaveSpacing.s2).semantics { heading() },
    )
}

@Composable
private fun Note(text: String, tag: String) {
    Text(
        text,
        style = MaterialTheme.typography.bodySmall,
        color = Weave.colors.muted,
        modifier = Modifier.padding(horizontal = WeaveSpacing.s4, vertical = WeaveSpacing.s1).testTag(tag),
    )
}

@Composable
private fun ChoiceItem(label: String, summary: String?, selected: Boolean, enabled: Boolean, tag: String, onClick: () -> Unit) {
    DropdownMenuItem(
        text = {
            Row(verticalAlignment = Alignment.CenterVertically) {
                RadioButton(selected = selected, onClick = null, enabled = enabled)
                Column(Modifier.padding(start = WeaveSpacing.s2)) {
                    Text(label, style = MaterialTheme.typography.bodyLarge)
                    if (summary != null) Text(summary, style = MaterialTheme.typography.bodySmall, color = Weave.colors.muted)
                }
            }
        },
        onClick = onClick,
        enabled = enabled,
        modifier = Modifier
            .testTag(tag)
            .semantics(mergeDescendants = true) {
                role = Role.RadioButton
                this.selected = selected
                stateDescription = if (selected) "Selected" else "Not selected"
            },
    )
}
