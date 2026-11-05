package com.specwithcode.android.ui.newthread

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuAnchorType
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.foundation.layout.Row
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.specwithcode.android.ui.components.Banner
import com.specwithcode.android.ui.components.SectionLabel
import com.specwithcode.android.ui.components.Tone
import com.specwithcode.android.ui.theme.Weave
import com.specwithcode.android.ui.theme.WeaveRadius
import com.specwithcode.android.ui.theme.WeaveSize
import com.specwithcode.android.ui.theme.WeaveSpacing
import com.specwithcode.sync.RuntimeModeChoice
import com.specwithcode.sync.ThreadRef

/** What each runtime mode lets the thread do. */
internal fun RuntimeModeChoice.explanation(): String = when (this) {
    RuntimeModeChoice.ApprovalRequired -> "Asks you before running commands or changing files."
    RuntimeModeChoice.AutoAcceptEdits -> "Changes files on its own; asks before running commands."
    RuntimeModeChoice.Auto -> "Decides on its own and asks only for risky steps."
    RuntimeModeChoice.FullAccess -> "Runs anything without asking. Use only in projects you trust it with."
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NewThreadScreen(viewModel: NewThreadViewModel, onBack: () -> Unit, onCreated: (ThreadRef) -> Unit) {
    val ui by viewModel.ui.collectAsStateWithLifecycle()
    LaunchedEffect(ui.created) { ui.created?.let(onCreated) }
    Scaffold(
        containerColor = Weave.colors.canvas,
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Weave.colors.canvas),
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") } },
                title = { Text("New thread") },
            )
        },
    ) { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .imePadding()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = WeaveSpacing.gutter, vertical = WeaveSpacing.s4)
                .testTag("newThread.screen"),
            verticalArrangement = Arrangement.spacedBy(WeaveSpacing.s4),
        ) {
            Picker(
                label = "Project",
                value = ui.project?.let { "${it.title} · ${it.machineLabel}" } ?: "No projects",
                tag = "newThread.project",
                options = ui.projects.map { "${it.title} · ${it.machineLabel}${if (it.machineOnline) "" else " (offline)"}" to it.ref },
                onSelect = viewModel::selectProject,
            )
            Picker(
                label = "Model",
                value = ui.model?.label ?: "Computer's default",
                tag = "newThread.model",
                options = listOf("Computer's default" to null) + ui.models.map { it.label to it },
                onSelect = viewModel::selectModel,
            )
            Column(Modifier.selectableGroup().testTag("newThread.mode")) {
                SectionLabel("Runtime mode", Modifier.padding(bottom = WeaveSpacing.s2))
                for (mode in RuntimeModeChoice.entries) {
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .heightIn(min = WeaveSize.minTap)
                            .selectable(selected = ui.runtimeMode == mode, onClick = { viewModel.selectRuntimeMode(mode) }, role = Role.RadioButton)
                            .testTag("newThread.mode.${mode.rawValue}"),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RadioButton(selected = ui.runtimeMode == mode, onClick = null)
                        Column(Modifier.padding(start = WeaveSpacing.s3, top = WeaveSpacing.s1, bottom = WeaveSpacing.s1)) {
                            Text(mode.label, style = MaterialTheme.typography.bodyLarge, color = Weave.colors.ink)
                            Text(mode.explanation(), style = MaterialTheme.typography.bodySmall, color = Weave.colors.muted)
                        }
                    }
                }
            }
            OutlinedTextField(
                value = ui.text,
                onValueChange = viewModel::setText,
                label = { Text("What should it do?") },
                minLines = 4,
                modifier = Modifier.fillMaxWidth().testTag("newThread.input"),
            )
            ui.blockedReason?.let { Banner(it, Tone.Warn) }
            ui.error?.let { Banner(it, Tone.Fail, Modifier.testTag("newThread.error"), title = "Couldn't start the thread") }
            Button(
                onClick = viewModel::start,
                enabled = ui.canStart,
                modifier = Modifier.fillMaxWidth().heightIn(min = WeaveSize.minTap).testTag("newThread.start"),
                shape = RoundedCornerShape(WeaveRadius.lg),
            ) { Text(if (ui.starting) "Starting…" else "Start thread") }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun <T> Picker(label: String, value: String, tag: String, options: List<Pair<String, T>>, onSelect: (T) -> Unit) {
    var open by remember { mutableStateOf(false) }
    ExposedDropdownMenuBox(expanded = open, onExpandedChange = { open = it && options.isNotEmpty() }) {
        OutlinedTextField(
            value = value,
            onValueChange = {},
            readOnly = true,
            label = { Text(label) },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = open) },
            modifier = Modifier
                .fillMaxWidth()
                .menuAnchor(ExposedDropdownMenuAnchorType.PrimaryNotEditable)
                .testTag(tag),
        )
        ExposedDropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            for ((text, option) in options) {
                DropdownMenuItem(
                    text = { Text(text) },
                    onClick = {
                        open = false
                        onSelect(option)
                    },
                    modifier = Modifier.heightIn(min = 48.dp),
                )
            }
        }
    }
}
