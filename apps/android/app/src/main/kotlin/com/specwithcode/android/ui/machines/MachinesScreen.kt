package com.specwithcode.android.ui.machines

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import com.specwithcode.android.ui.components.Banner
import com.specwithcode.android.ui.components.EmptyState
import com.specwithcode.android.ui.components.GroupedCard
import com.specwithcode.android.ui.components.StatusChip
import com.specwithcode.android.ui.components.Tone
import com.specwithcode.android.ui.components.tone
import com.specwithcode.android.ui.chat.readable
import com.specwithcode.android.ui.theme.Weave
import com.specwithcode.android.ui.theme.WeaveRadius
import com.specwithcode.android.ui.theme.WeaveSize
import com.specwithcode.android.ui.theme.WeaveSpacing
import com.specwithcode.sync.AppEngine
import com.specwithcode.sync.MachineStatus
import com.specwithcode.sync.MachineSummary
import kotlinx.coroutines.launch

/** The line under a machine's name: platform, version and how long its pairing lasts. */
internal fun MachineSummary.detailLine(): String = buildList {
    platform?.let(::add)
    serverVersion?.let { add("v$it") }
    when {
        viaConnect -> add("SpecWithCode Connect")
        tokenDaysLeft != null && tokenDaysLeft!! <= 0 -> add("Pairing expired")
        tokenDaysLeft == 1 -> add("Pairing ends tomorrow")
        tokenDaysLeft != null -> add("Pairing ends in $tokenDaysLeft days")
    }
}.joinToString(" · ")

/** The status a person reads for a machine, including a paused connection. */
internal fun MachineSummary.statusText(): String = when {
    isDisconnected -> "Paused"
    needsSignIn -> "Sign in again"
    else -> status.label
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MachinesScreen(
    machines: List<MachineSummary>,
    engine: AppEngine,
    onBack: () -> Unit,
    onPair: (MachineSummary?) -> Unit,
) {
    val scope = rememberCoroutineScope()
    var error by remember { mutableStateOf<String?>(null) }
    var removing by remember { mutableStateOf<MachineSummary?>(null) }
    Scaffold(
        containerColor = Weave.colors.canvas,
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Weave.colors.canvas),
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") } },
                title = { Text("Machines") },
            )
        },
    ) { padding ->
        LazyColumn(
            Modifier.fillMaxSize().padding(padding).testTag("machines.list"),
            contentPadding = PaddingValues(WeaveSpacing.gutter),
            verticalArrangement = Arrangement.spacedBy(WeaveSpacing.s3),
        ) {
            error?.let { message -> item("error") { Banner(message, Tone.Fail, actionLabel = "Dismiss", onAction = { error = null }) } }
            if (machines.isEmpty()) {
                item("empty") { EmptyState("No computers yet", "Pair a computer running SpecWithCode to control it from here.") }
            }
            items(machines, key = { it.id }) { machine ->
                MachineCard(
                    machine,
                    onReconnect = { engine.reconnect(machine.id) },
                    onToggleConnection = {
                        scope.launch {
                            try {
                                engine.setConnectionEnabled(machine.isDisconnected, machine.id)
                            } catch (e: Exception) {
                                error = e.readable()
                            }
                        }
                    },
                    onPairAgain = { onPair(machine) },
                    onRemove = { removing = machine },
                )
            }
            item("pair") {
                Button(
                    onClick = { onPair(null) },
                    modifier = Modifier.fillMaxWidth().heightIn(min = WeaveSize.minTap).testTag("machines.pair"),
                    shape = RoundedCornerShape(WeaveRadius.lg),
                ) { Text("Pair a computer") }
            }
        }
    }
    removing?.let { machine ->
        AlertDialog(
            onDismissRequest = { removing = null },
            title = { Text("Remove ${machine.displayName}?") },
            text = { Text("This phone forgets the computer and its sign-in. Nothing changes on the computer. To use it again, pair it again.") },
            confirmButton = {
                TextButton(onClick = { engine.removeMachine(machine.id); removing = null }, modifier = Modifier.testTag("machine.remove.confirm")) {
                    Text("Remove", color = Weave.colors.fail)
                }
            },
            dismissButton = { TextButton(onClick = { removing = null }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun MachineCard(
    machine: MachineSummary,
    onReconnect: () -> Unit,
    onToggleConnection: () -> Unit,
    onPairAgain: () -> Unit,
    onRemove: () -> Unit,
) {
    var menu by remember { mutableStateOf(false) }
    val colors = Weave.colors
    GroupedCard(Modifier.testTag("machine.row.${machine.id}")) {
        Row(Modifier.fillMaxWidth().padding(WeaveSpacing.s4), verticalAlignment = Alignment.Top) {
            Column(
                Modifier.weight(1f).semantics(mergeDescendants = true) {
                    contentDescription = listOfNotNull("${machine.displayName}, ${machine.statusText()}. ${machine.detailLine()}", machine.lastErrorMessage).joinToString(" ")
                },
                verticalArrangement = Arrangement.spacedBy(WeaveSpacing.s1),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(machine.displayName, style = MaterialTheme.typography.titleMedium, color = colors.ink, modifier = Modifier.weight(1f, fill = false))
                    StatusChip(machine.statusText(), if (machine.isDisconnected) Tone.Neutral else machine.status.tone(), Modifier.padding(start = WeaveSpacing.s2))
                }
                val detail = machine.detailLine()
                if (detail.isNotEmpty()) Text(detail, style = MaterialTheme.typography.bodySmall, color = colors.muted)
                machine.address?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = colors.muted) }
                machine.teamRulesRefusal?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = colors.warn) }
                machine.lastErrorMessage?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = colors.muted) }
            }
            IconButton(onClick = { menu = true }, modifier = Modifier.testTag("machine.menu.${machine.id}")) {
                Icon(Icons.Filled.MoreVert, contentDescription = "Actions for ${machine.displayName}")
            }
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                if (!machine.isDisconnected && machine.status != MachineStatus.Connected) {
                    DropdownMenuItem(text = { Text("Reconnect") }, onClick = { menu = false; onReconnect() })
                }
                DropdownMenuItem(
                    text = { Text(if (machine.isDisconnected) "Connect" else "Pause connection") },
                    onClick = { menu = false; onToggleConnection() },
                )
                if (machine.hasDirectPairing) {
                    DropdownMenuItem(text = { Text("Pair again") }, onClick = { menu = false; onPairAgain() })
                }
                DropdownMenuItem(
                    text = { Text("Remove from this phone", color = colors.fail) },
                    onClick = { menu = false; onRemove() },
                    modifier = Modifier.testTag("machine.remove.${machine.id}"),
                )
            }
        }
        if (machine.status == MachineStatus.NeedsRepair) {
            Banner(
                machine.reapprovalNotice ?: "This computer no longer accepts this phone's sign-in.",
                Tone.Fail,
                Modifier.padding(start = WeaveSpacing.s4, end = WeaveSpacing.s4, bottom = WeaveSpacing.s4),
                actionLabel = "Pair again",
                onAction = onPairAgain,
            )
        }
    }
}
