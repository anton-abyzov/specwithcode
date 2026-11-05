package com.specwithcode.android.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.specwithcode.android.ui.theme.Weave
import com.specwithcode.android.ui.theme.WeaveRadius
import com.specwithcode.android.ui.theme.WeaveSpacing
import com.specwithcode.sync.MachineStatus
import com.specwithcode.sync.ProjectIcon
import com.specwithcode.sync.ThreadActivity
import com.specwithcode.sync.ThreadSummary

/** The tone of a chip, dot or banner. */
enum class Tone { Neutral, Accent, Pass, Warn, Fail }

@Composable
private fun Tone.foreground(): Color = when (this) {
    Tone.Neutral -> Weave.colors.muted
    Tone.Accent -> Weave.colors.irisStrong
    Tone.Pass -> Weave.colors.pass
    Tone.Warn -> Weave.colors.warn
    Tone.Fail -> Weave.colors.fail
}

@Composable
private fun Tone.background(): Color = when (this) {
    Tone.Neutral -> Weave.colors.sunken
    Tone.Accent -> Weave.colors.irisTint
    Tone.Pass -> Weave.colors.passTint
    Tone.Warn -> Weave.colors.warnTint
    Tone.Fail -> Weave.colors.failTint
}

@Composable
fun Tone.dotColor(): Color = when (this) {
    Tone.Neutral -> Weave.colors.control
    Tone.Accent -> Weave.colors.iris
    else -> foreground()
}

/** A small colored dot; decorative, so callers describe the state in text. */
@Composable
fun StatusDot(tone: Tone, modifier: Modifier = Modifier, size: Dp = 8.dp) {
    Box(modifier.size(size).clip(CircleShape).background(tone.dotColor()))
}

/** A short pill: "Online", "Needs you", "Answered". */
@Composable
fun StatusChip(text: String, tone: Tone, modifier: Modifier = Modifier) {
    Text(
        text,
        modifier = modifier
            .clip(RoundedCornerShape(50))
            .background(tone.background())
            .padding(horizontal = 8.dp, vertical = 2.dp),
        color = tone.foreground(),
        style = MaterialTheme.typography.labelMedium,
        maxLines = 1,
    )
}

/** A count badge, e.g. pending approvals on a project. */
@Composable
fun CountBadge(count: Int, tone: Tone, description: String, modifier: Modifier = Modifier) {
    if (count <= 0) return
    Box(
        modifier
            .defaultMinSize(minWidth = 20.dp, minHeight = 20.dp)
            .clip(RoundedCornerShape(50))
            .background(tone.dotColor())
            .padding(horizontal = 6.dp)
            .clearAndSetSemantics { contentDescription = description },
        contentAlignment = Alignment.Center,
    ) {
        Text(
            if (count > 99) "99+" else count.toString(),
            color = Weave.colors.panel,
            fontSize = 12.sp,
            fontWeight = FontWeight.SemiBold,
        )
    }
}

fun MachineStatus.tone(): Tone = when (this) {
    MachineStatus.Connected -> Tone.Pass
    MachineStatus.Connecting, MachineStatus.Reconnecting -> Tone.Warn
    MachineStatus.NeedsRepair, MachineStatus.Unsupported -> Tone.Fail
    MachineStatus.Offline -> Tone.Neutral
}

/** How a thread's state reads in lists. */
fun ThreadSummary.statusLabel(): String = when {
    isUnknown -> "Unknown"
    asksForAccess -> "Asks for access"
    activity == ThreadActivity.NeedsYou || waitsOnUser -> "Needs you"
    waitReason != null -> waitReason!!
    activity == ThreadActivity.Working -> "Working"
    activity == ThreadActivity.Failed -> "Failed"
    isResolved -> "Resolved"
    isDone -> "Done"
    else -> "Idle"
}

fun ThreadSummary.statusTone(): Tone = when {
    isUnknown -> Tone.Neutral
    activity == ThreadActivity.NeedsYou || waitsOnUser || asksForAccess -> Tone.Warn
    activity == ThreadActivity.Working -> Tone.Accent
    activity == ThreadActivity.Failed -> Tone.Fail
    isDone || isResolved -> Tone.Pass
    else -> Tone.Neutral
}

/** A project's icon: a tinted tile with its emoji or initials. */
@Composable
fun ProjectAvatar(icon: ProjectIcon, title: String, modifier: Modifier = Modifier, size: Dp = 28.dp) {
    val colors = Weave.colors
    val (text, tint) = when (icon) {
        is ProjectIcon.Emoji -> icon.emoji to null
        is ProjectIcon.Monogram -> icon.text.take(2) to icon.color
        is ProjectIcon.Symbol -> initials(title) to icon.color
        ProjectIcon.None -> initials(title) to null
    }
    val fg = colors.tint(tint)
    Box(
        modifier
            .size(size)
            .clip(RoundedCornerShape(WeaveRadius.tile))
            .background(if (icon is ProjectIcon.Emoji) colors.sunken else fg.copy(alpha = if (colors.isDark) 0.22f else 0.14f))
            .clearAndSetSemantics { },
        contentAlignment = Alignment.Center,
    ) {
        Text(text, color = fg, fontSize = (size.value * 0.42f).sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
    }
}

internal fun initials(title: String): String {
    val words = title.split(' ', '-', '_').filter { it.isNotBlank() }
    return when {
        words.isEmpty() -> "?"
        words.size == 1 -> words[0].take(1).uppercase()
        else -> (words[0].take(1) + words[1].take(1)).uppercase()
    }
}

/** An inline notice with an optional action. */
@Composable
fun Banner(
    message: String,
    tone: Tone,
    modifier: Modifier = Modifier,
    title: String? = null,
    actionLabel: String? = null,
    onAction: (() -> Unit)? = null,
) {
    val icon = when (tone) {
        Tone.Fail, Tone.Warn -> Icons.Filled.Warning
        Tone.Pass -> Icons.Filled.CheckCircle
        else -> Icons.Filled.Info
    }
    Row(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(WeaveRadius.lg))
            .background(tone.background())
            .padding(WeaveSpacing.s3)
            .semantics(mergeDescendants = true) {},
        verticalAlignment = Alignment.Top,
    ) {
        Icon(icon, contentDescription = null, tint = tone.foreground(), modifier = Modifier.size(20.dp))
        Spacer(Modifier.width(WeaveSpacing.s3))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            if (title != null) Text(title, style = MaterialTheme.typography.labelLarge, color = tone.foreground())
            Text(message, style = MaterialTheme.typography.bodyMedium, color = Weave.colors.ink)
            if (actionLabel != null && onAction != null) {
                TextButton(onClick = onAction, modifier = Modifier.defaultMinSize(minHeight = 48.dp)) { Text(actionLabel) }
            }
        }
    }
}

/** A titled group of rows on a panel, like an iOS grouped list. */
@Composable
fun GroupedCard(modifier: Modifier = Modifier, title: String? = null, content: @Composable () -> Unit) {
    Column(modifier.fillMaxWidth()) {
        if (title != null) SectionLabel(title, Modifier.padding(start = WeaveSpacing.s4, bottom = WeaveSpacing.s2))
        Column(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(WeaveRadius.card))
                .background(Weave.colors.panel)
                .border(0.5.dp, Weave.colors.line, RoundedCornerShape(WeaveRadius.card)),
        ) { content() }
    }
}

@Composable
fun SectionLabel(text: String, modifier: Modifier = Modifier) {
    Text(
        text.uppercase(),
        modifier = modifier,
        style = MaterialTheme.typography.titleSmall,
        color = Weave.colors.muted,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
    )
}

/** Centered empty-state text. */
@Composable
fun EmptyState(title: String, message: String, modifier: Modifier = Modifier) {
    Column(
        modifier.fillMaxWidth().padding(WeaveSpacing.s8),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(WeaveSpacing.s2),
    ) {
        Text(title, style = MaterialTheme.typography.titleMedium, color = Weave.colors.ink, textAlign = TextAlign.Center)
        Text(message, style = MaterialTheme.typography.bodyMedium, color = Weave.colors.muted, textAlign = TextAlign.Center)
    }
}
