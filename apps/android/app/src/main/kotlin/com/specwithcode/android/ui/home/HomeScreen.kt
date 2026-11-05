package com.specwithcode.android.ui.home

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.specwithcode.android.ui.components.Banner
import com.specwithcode.android.ui.components.CountBadge
import com.specwithcode.android.ui.components.EmptyState
import com.specwithcode.android.ui.components.ProjectAvatar
import com.specwithcode.android.ui.components.SectionLabel
import com.specwithcode.android.ui.components.StatusChip
import com.specwithcode.android.ui.components.StatusDot
import com.specwithcode.android.ui.components.Tone
import com.specwithcode.android.ui.components.statusLabel
import com.specwithcode.android.ui.components.statusTone
import com.specwithcode.android.ui.theme.Weave
import com.specwithcode.android.ui.theme.WeaveSize
import com.specwithcode.android.ui.theme.WeaveSpacing
import com.specwithcode.sync.AppState
import com.specwithcode.sync.ChatTarget
import com.specwithcode.sync.ProjectRef
import com.specwithcode.sync.ThreadSummary
import kotlinx.coroutines.launch

/** Home: what needs you and recent threads, with projects and their threads in the drawer. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(
    state: AppState,
    isSample: Boolean,
    onOpenChat: (ChatTarget) -> Unit,
    onNewThread: (ProjectRef?) -> Unit,
    onMachines: () -> Unit,
    onSettings: () -> Unit,
    onExitSample: () -> Unit,
) {
    val overview = remember(state) { OverviewUi.from(state) }
    val drawer = rememberDrawerState(DrawerValue.Closed)
    val scope = rememberCoroutineScope()
    fun open(target: ChatTarget) {
        scope.launch { drawer.close() }
        onOpenChat(target)
    }
    BackHandler(enabled = drawer.isOpen) { scope.launch { drawer.close() } }
    ModalNavigationDrawer(
        drawerState = drawer,
        drawerContent = {
            ModalDrawerSheet(drawerContainerColor = Weave.colors.canvas, modifier = Modifier.width(320.dp)) {
                ProjectDrawer(overview, onOpen = ::open, onNewThread = { scope.launch { drawer.close() }; onNewThread(it) })
            }
        },
    ) {
        Scaffold(
            containerColor = Weave.colors.canvas,
            topBar = {
                TopAppBar(
                    colors = TopAppBarDefaults.topAppBarColors(containerColor = Weave.colors.canvas),
                    navigationIcon = {
                        IconButton(onClick = { scope.launch { drawer.open() } }, modifier = Modifier.testTag("home.drawer")) {
                            Icon(Icons.Filled.Menu, contentDescription = if (overview.totalPending > 0) "Projects, ${overview.totalPending} need you" else "Projects")
                        }
                    },
                    title = { Text("SpecWithCode") },
                    actions = {
                        TextButton(onClick = onMachines, modifier = Modifier.heightIn(min = WeaveSize.minTap).testTag("home.machines")) {
                            val online = state.machines.count { it.status.isOnline }
                            Text("$online/${state.machines.size} online")
                        }
                        IconButton(onClick = onSettings, modifier = Modifier.testTag("home.settings")) {
                            Icon(Icons.Filled.Settings, contentDescription = "Settings")
                        }
                    },
                )
            },
            floatingActionButton = {
                if (state.projects.isNotEmpty()) {
                    ExtendedFloatingActionButton(
                        onClick = { onNewThread(null) },
                        icon = { Icon(Icons.Filled.Add, contentDescription = null) },
                        text = { Text("New thread") },
                        modifier = Modifier.testTag("home.newThread"),
                    )
                }
            },
        ) { padding ->
            LazyColumn(
                Modifier.fillMaxSize().padding(padding).testTag("thread.list"),
                contentPadding = PaddingValues(start = WeaveSpacing.gutter, end = WeaveSpacing.gutter, bottom = 96.dp),
                verticalArrangement = Arrangement.spacedBy(WeaveSpacing.s1),
            ) {
                if (isSample) {
                    item("sample") {
                        Banner(
                            "Nothing here reaches a computer.",
                            Tone.Accent,
                            Modifier.padding(vertical = WeaveSpacing.s2),
                            title = "This is sample data",
                            actionLabel = "Leave sample data",
                            onAction = onExitSample,
                        )
                    }
                }
                val offline = state.machines.filter { !it.status.isOnline && !it.isDisconnected }
                if (offline.isNotEmpty()) {
                    item("offline") {
                        Banner(
                            offline.joinToString { it.displayName } + if (offline.size == 1) " is offline. Its threads show their last known state." else " are offline. Their threads show their last known state.",
                            Tone.Neutral,
                            Modifier.padding(vertical = WeaveSpacing.s2),
                            actionLabel = "Machines",
                            onAction = onMachines,
                        )
                    }
                }
                overview.aide?.let { aide ->
                    item("aide") {
                        ProjectRow(aide, expanded = null, onToggle = {}, onOpen = { open(ChatTarget.Aide(aide.project.ref)) })
                    }
                }
                if (overview.needsYou.isNotEmpty()) {
                    header("Needs you")
                    items(overview.needsYou, key = { "needs/${it.ref.environmentId}/${it.ref.threadId}" }) { thread ->
                        ThreadRow(thread, showProject = true) { open(ChatTarget.Thread(thread.ref)) }
                    }
                }
                if (overview.recent.isNotEmpty()) {
                    header("Recent")
                    items(overview.recent, key = { "recent/${it.ref.environmentId}/${it.ref.threadId}" }) { thread ->
                        ThreadRow(thread, showProject = true) { open(ChatTarget.Thread(thread.ref)) }
                    }
                }
                if (overview.isEmpty && !state.isLoading) {
                    item("empty") {
                        EmptyState(
                            "No projects yet",
                            if (state.machines.isEmpty()) "Pair a computer to see its projects here." else "Projects you create in SpecWithCode on your computer show up here.",
                        )
                    }
                }
            }
        }
    }
}

private fun LazyListScope.header(title: String) {
    item("header/$title") {
        SectionLabel(title, Modifier.padding(top = WeaveSpacing.s4, bottom = WeaveSpacing.s1).semantics { heading() })
    }
}

/** The drawer: Aide, then pinned, other and automated projects, each with its threads. */
@Composable
private fun ProjectDrawer(overview: OverviewUi, onOpen: (ChatTarget) -> Unit, onNewThread: (ProjectRef) -> Unit) {
    val expanded = remember { mutableStateMapOf<ProjectRef, Boolean>() }
    LazyColumn(
        Modifier.fillMaxSize().testTag("drawer.projects"),
        contentPadding = PaddingValues(horizontal = WeaveSpacing.s3, vertical = WeaveSpacing.s4),
    ) {
        item("title") {
            Text(
                "Projects",
                style = MaterialTheme.typography.titleLarge,
                modifier = Modifier.padding(horizontal = WeaveSpacing.s2, vertical = WeaveSpacing.s2).semantics { heading() },
            )
        }
        overview.aide?.let { aide ->
            item("aide") { ProjectRow(aide, expanded = null, onToggle = {}, onOpen = { onOpen(ChatTarget.Aide(aide.project.ref)) }, tagPrefix = "drawer.project") }
        }
        fun group(title: String, sections: List<ProjectSection>) {
            if (sections.isEmpty()) return
            header(title)
            for (section in sections) {
                val ref = section.project.ref
                val isOpen = expanded[ref] ?: (section.pendingCount > 0)
                item("p/${ref.environmentId}/${ref.projectId}") {
                    ProjectRow(section, expanded = isOpen, onToggle = { expanded[ref] = !isOpen }, onOpen = { onOpen(ChatTarget.Project(ref)) }, tagPrefix = "drawer.project")
                }
                if (isOpen) {
                    items(section.threads, key = { "t/${it.ref.environmentId}/${it.ref.threadId}" }) { thread ->
                        ThreadRow(thread, showProject = false, indent = true, tagPrefix = "drawer.thread") { onOpen(ChatTarget.Thread(thread.ref)) }
                    }
                    item("new/${ref.environmentId}/${ref.projectId}") {
                        TextButton(
                            onClick = { onNewThread(ref) },
                            modifier = Modifier.padding(start = 36.dp).heightIn(min = WeaveSize.minTap),
                        ) { Text("New thread") }
                    }
                }
            }
        }
        group("Pinned", overview.pinned)
        group("Projects", overview.others)
        group("Automated", overview.automated)
    }
}

@Composable
private fun ProjectRow(section: ProjectSection, expanded: Boolean?, onToggle: () -> Unit, onOpen: () -> Unit, tagPrefix: String = "project.row") {
    val project = section.project
    val colors = Weave.colors
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .clickable(role = Role.Button, onClickLabel = "Open the coordinator", onClick = onOpen)
            .padding(horizontal = WeaveSpacing.s2)
            .testTag("$tagPrefix.${project.ref.projectId}"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        ProjectAvatar(project.icon, project.title)
        Column(
            Modifier
                .weight(1f)
                .padding(start = WeaveSpacing.s3)
                .semantics(mergeDescendants = true) {
                    contentDescription = buildString {
                        append(project.title)
                        append(", ")
                        append(project.machineLabel)
                        if (!project.machineOnline) append(", offline")
                        if (section.pendingCount > 0) append(", ${section.pendingCount} need you")
                        if (section.workingCount > 0) append(", ${section.workingCount} working")
                    }
                },
        ) {
            Text(project.title, style = MaterialTheme.typography.bodyLarge, fontWeight = if (project.hasUnread) FontWeight.SemiBold else FontWeight.Medium, color = colors.ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Row(verticalAlignment = Alignment.CenterVertically) {
                StatusDot(if (project.machineOnline) Tone.Pass else Tone.Neutral, size = 6.dp)
                Spacer(Modifier.width(6.dp))
                val detail = buildList {
                    add(if (project.members.size > 1) "${project.members.size} computers" else project.machineLabel)
                    if (section.workingCount > 0) add("${section.workingCount} working")
                    if (project.paused) add("Paused")
                }.joinToString(" · ")
                Text(detail, style = MaterialTheme.typography.bodySmall, color = colors.muted, maxLines = 1)
            }
        }
        CountBadge(section.pendingCount, Tone.Warn, "${section.pendingCount} need you", Modifier.testTag("$tagPrefix.pending.${project.ref.projectId}"))
        if (expanded != null) {
            IconButton(
                onClick = onToggle,
                modifier = Modifier.semantics { stateDescription = if (expanded) "Expanded" else "Collapsed" },
            ) {
                Icon(
                    if (expanded) Icons.Filled.KeyboardArrowUp else Icons.Filled.KeyboardArrowDown,
                    contentDescription = if (expanded) "Hide threads of ${project.title}" else "Show threads of ${project.title}",
                )
            }
        }
    }
}

@Composable
private fun ThreadRow(thread: ThreadSummary, showProject: Boolean, indent: Boolean = false, tagPrefix: String = "thread.row", onOpen: () -> Unit) {
    val colors = Weave.colors
    val status = thread.statusLabel()
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .clickable(role = Role.Button, onClick = onOpen)
            .padding(start = if (indent) 36.dp else WeaveSpacing.s2, end = WeaveSpacing.s2, top = WeaveSpacing.s2, bottom = WeaveSpacing.s2)
            .semantics(mergeDescendants = true) {
                contentDescription = listOfNotNull(
                    thread.title,
                    status,
                    if (showProject) thread.projectTitle else null,
                    if (thread.isUnread) "unread" else null,
                    if (thread.isPinned) "pinned" else null,
                ).joinToString(", ")
            }
            .testTag("$tagPrefix.${thread.ref.threadId}"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        StatusDot(thread.statusTone())
        Column(Modifier.weight(1f).padding(start = WeaveSpacing.s3)) {
            Text(
                thread.title,
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = if (thread.isUnread) FontWeight.SemiBold else null,
                color = colors.ink,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            val second = listOfNotNull(if (showProject) thread.projectTitle else null, thread.preview).joinToString(" · ")
            if (second.isNotEmpty()) {
                Text(second, style = MaterialTheme.typography.bodySmall, color = colors.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        if (thread.statusTone() != Tone.Neutral || thread.isUnknown) {
            StatusChip(status, thread.statusTone(), Modifier.padding(start = WeaveSpacing.s2))
        }
        thread.planProgress?.let {
            Text("${it.completed}/${it.total}", style = MaterialTheme.typography.labelSmall, color = colors.muted, modifier = Modifier.padding(start = WeaveSpacing.s2))
        }
    }
}
