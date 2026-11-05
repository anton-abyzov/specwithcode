package com.specwithcode.android.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.specwithcode.android.ui.components.Banner
import com.specwithcode.android.ui.components.StatusChip
import com.specwithcode.android.ui.components.Tone
import com.specwithcode.android.ui.theme.Weave
import com.specwithcode.android.ui.theme.WeaveRadius
import com.specwithcode.android.ui.theme.WeaveSize
import com.specwithcode.android.ui.theme.WeaveSpacing
import com.specwithcode.sync.ChatTarget
import com.specwithcode.sync.RuntimeModeChoice
import com.specwithcode.sync.ThreadAction
import com.specwithcode.sync.ThreadRef
import com.specwithcode.sync.ThreadSummary

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatScreen(
    viewModel: ChatViewModel,
    thread: ThreadSummary?,
    onBack: () -> Unit,
    onOpenThread: (ThreadRef) -> Unit,
) {
    val ui by viewModel.ui.collectAsStateWithLifecycle()
    val chat = ui.chat
    val listState = rememberLazyListState()
    val actions = remember(viewModel) {
        RowActions(
            onDecision = viewModel::respond,
            onAccess = viewModel::answerAccess,
            onOpenThread = onOpenThread,
        )
    }
    // Follow the newest row, as the reply streams in.
    val lastRow = chat.rows.lastOrNull()
    LaunchedEffect(chat.rows.size, (lastRow?.kind as? com.specwithcode.sync.TranscriptRow.Kind.Assistant)?.markdown?.length) {
        if (chat.rows.isNotEmpty()) listState.animateScrollToItem(chat.rows.lastIndex)
    }
    Scaffold(
        containerColor = Weave.colors.canvas,
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Weave.colors.canvas),
                navigationIcon = {
                    IconButton(onClick = onBack, modifier = Modifier.testTag("chat.back")) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                title = {
                    Column(Modifier.semantics(mergeDescendants = true) {}) {
                        Text(chat.title, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.testTag("chat.title"))
                        Text(chat.subtitle, style = MaterialTheme.typography.bodySmall, color = Weave.colors.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                },
                actions = {
                    if (viewModel.target is ChatTarget.Thread && thread != null) ThreadMenu(thread, viewModel::perform)
                },
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).imePadding()) {
            Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.TopCenter) {
                when {
                    chat.loadError != null -> Column(Modifier.padding(WeaveSpacing.gutter)) {
                        Banner(chat.loadError!!, Tone.Fail, title = "Couldn't load this chat", actionLabel = "Try again", onAction = viewModel::reload)
                    }
                    !chat.isLoaded -> Text("Loading…", color = Weave.colors.muted, modifier = Modifier.padding(WeaveSpacing.s8))
                    else -> LazyColumn(
                        state = listState,
                        modifier = Modifier.fillMaxSize().widthIn(max = WeaveSize.readableColumn).testTag("chat.transcript"),
                        contentPadding = PaddingValues(horizontal = WeaveSpacing.gutter, vertical = WeaveSpacing.s4),
                        verticalArrangement = Arrangement.spacedBy(WeaveSpacing.s3),
                    ) {
                        items(chat.rows, key = { it.id }) { row -> TranscriptRowView(row, ui.busyRequests, actions) }
                    }
                }
            }
            Composer(
                ui = ui,
                onDraft = viewModel::setDraft,
                onSend = viewModel::send,
                onStop = viewModel::stop,
                onDismissError = viewModel::dismissError,
            )
        }
    }
}

@Composable
private fun ThreadMenu(thread: ThreadSummary, onAction: (ThreadAction) -> Unit) {
    var open by remember { mutableStateOf(false) }
    var renaming by rememberSaveable { mutableStateOf(false) }
    var archiving by remember { mutableStateOf(false) }
    var modes by remember { mutableStateOf(false) }
    IconButton(onClick = { open = true }, modifier = Modifier.testTag("chat.menu")) {
        Icon(Icons.Filled.MoreVert, contentDescription = "Thread actions")
    }
    DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
        MenuItem(if (thread.isPinned) "Unpin" else "Pin", "chat.menu.pin") {
            open = false
            onAction(if (thread.isPinned) ThreadAction.Unpin else ThreadAction.Pin)
        }
        MenuItem(if (thread.isResolved) "Mark unresolved" else "Mark resolved", "chat.menu.resolve") {
            open = false
            onAction(if (thread.isResolved) ThreadAction.Unresolve else ThreadAction.Resolve)
        }
        MenuItem("Rename", "chat.menu.rename") { open = false; renaming = true }
        MenuItem("Change runtime mode", "chat.menu.mode") { open = false; modes = true }
        MenuItem("Mark unread", "chat.menu.unread") { open = false; onAction(ThreadAction.MarkUnread) }
        HorizontalDivider()
        MenuItem("Archive", "chat.menu.archive") { open = false; archiving = true }
    }
    if (renaming) {
        var title by rememberSaveable { mutableStateOf(thread.title) }
        AlertDialog(
            onDismissRequest = { renaming = false },
            title = { Text("Rename thread") },
            text = { OutlinedTextField(title, { title = it }, singleLine = true, label = { Text("Name") }, modifier = Modifier.testTag("rename.input")) },
            confirmButton = {
                TextButton(onClick = { renaming = false; onAction(ThreadAction.Rename(title)) }, enabled = title.isNotBlank()) { Text("Save") }
            },
            dismissButton = { TextButton(onClick = { renaming = false }) { Text("Cancel") } },
        )
    }
    if (modes) {
        AlertDialog(
            onDismissRequest = { modes = false },
            title = { Text("Runtime mode") },
            text = {
                Column {
                    Text("Takes effect on the next turn.", style = MaterialTheme.typography.bodySmall, color = Weave.colors.muted)
                    for (mode in RuntimeModeChoice.entries) {
                        TextButton(onClick = { modes = false; onAction(ThreadAction.SetRuntimeMode(mode)) }, modifier = Modifier.fillMaxWidth()) {
                            Text(mode.label, modifier = Modifier.fillMaxWidth())
                        }
                    }
                }
            },
            confirmButton = { TextButton(onClick = { modes = false }) { Text("Cancel") } },
        )
    }
    if (archiving) {
        AlertDialog(
            onDismissRequest = { archiving = false },
            title = { Text("Archive this thread?") },
            text = { Text("It leaves your lists. You can find it again on your computer.") },
            confirmButton = { TextButton(onClick = { archiving = false; onAction(ThreadAction.Archive) }) { Text("Archive") } },
            dismissButton = { TextButton(onClick = { archiving = false }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun MenuItem(label: String, tag: String, onClick: () -> Unit) {
    DropdownMenuItem(text = { Text(label) }, onClick = onClick, modifier = Modifier.testTag(tag))
}

/** The message box with send and stop. */
@Composable
fun Composer(ui: ChatUi, onDraft: (String) -> Unit, onSend: () -> Unit, onStop: () -> Unit, onDismissError: () -> Unit) {
    val colors = Weave.colors
    val chat = ui.chat
    Column(
        Modifier
            .fillMaxWidth()
            .background(colors.canvas)
            .navigationBarsPadding()
            .padding(horizontal = WeaveSpacing.gutter, vertical = WeaveSpacing.s2),
        verticalArrangement = Arrangement.spacedBy(WeaveSpacing.s2),
    ) {
        ui.notice?.let { notice ->
            Banner(
                notice,
                if (ui.error != null || chat.lastError != null) Tone.Fail else Tone.Warn,
                Modifier.testTag("composer.notice"),
                actionLabel = if (ui.error != null) "Dismiss" else null,
                onAction = if (ui.error != null) onDismissError else null,
            )
        }
        chat.plan?.let { plan ->
            StatusChip("Plan ${plan.completed} of ${plan.total}", if (plan.completed == plan.total) Tone.Pass else Tone.Accent)
        }
        Row(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(26.dp))
                .background(colors.panel)
                .border(0.5.dp, colors.line, RoundedCornerShape(26.dp))
                .padding(start = WeaveSpacing.s1, end = WeaveSpacing.s1),
            verticalAlignment = Alignment.Bottom,
        ) {
            TextField(
                value = ui.draft,
                onValueChange = onDraft,
                modifier = Modifier.weight(1f).heightIn(min = 52.dp).testTag("composer.input"),
                placeholder = { Text(chat.sendBlockedReason?.let { "Sending is paused" } ?: ui.composerHint) },
                enabled = chat.sendBlockedReason == null && chat.loadError == null,
                maxLines = 6,
                colors = TextFieldDefaults.colors(
                    focusedContainerColor = colors.panel,
                    unfocusedContainerColor = colors.panel,
                    disabledContainerColor = colors.panel,
                    focusedIndicatorColor = androidx.compose.ui.graphics.Color.Transparent,
                    unfocusedIndicatorColor = androidx.compose.ui.graphics.Color.Transparent,
                    disabledIndicatorColor = androidx.compose.ui.graphics.Color.Transparent,
                ),
            )
            if (ui.showsStop) {
                FilledIconButton(
                    onClick = onStop,
                    enabled = ui.canStop,
                    modifier = Modifier.padding(bottom = 4.dp).size(WeaveSize.minTap).testTag("composer.stop"),
                    colors = IconButtonDefaults.filledIconButtonColors(containerColor = colors.ink, contentColor = colors.panel),
                ) {
                    Box(Modifier.size(14.dp).clip(RoundedCornerShape(3.dp)).background(colors.panel).semantics { contentDescription = "Stop" })
                }
            }
            FilledIconButton(
                onClick = onSend,
                enabled = ui.canSend,
                modifier = Modifier.padding(bottom = 4.dp).size(WeaveSize.minTap).testTag("composer.send"),
            ) {
                Icon(Icons.AutoMirrored.Filled.Send, contentDescription = if (chat.isRunning) "Queue message" else "Send")
            }
        }
    }
}

@Composable
internal fun PrimaryWideButton(label: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true) {
    Button(onClick = onClick, enabled = enabled, modifier = modifier.fillMaxWidth().heightIn(min = WeaveSize.minTap), shape = RoundedCornerShape(WeaveRadius.lg)) {
        Text(label)
    }
}
