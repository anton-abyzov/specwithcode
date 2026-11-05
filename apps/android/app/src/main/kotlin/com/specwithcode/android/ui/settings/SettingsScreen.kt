package com.specwithcode.android.ui.settings

import android.os.Build
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.specwithcode.android.ui.components.GroupedCard
import com.specwithcode.android.ui.components.StatusDot
import com.specwithcode.android.ui.components.tone
import com.specwithcode.android.ui.theme.Weave
import com.specwithcode.android.ui.theme.WeaveSize
import com.specwithcode.android.ui.theme.WeaveSpacing
import com.specwithcode.sync.AppearancePreference
import com.specwithcode.sync.MachineSummary

const val PRIVACY_POLICY_URL = "https://spec-weave.com/privacy"

data class SettingsUi(
    val appearance: AppearancePreference,
    val dynamicColor: Boolean,
    val isSample: Boolean,
    val signedIn: Boolean,
    val machines: List<MachineSummary>,
    val versionName: String,
    val versionCode: Int,
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    ui: SettingsUi,
    onBack: () -> Unit,
    onAppearance: (AppearancePreference) -> Unit,
    onDynamicColor: (Boolean) -> Unit,
    onSampleData: (Boolean) -> Unit,
    onMachines: () -> Unit,
    onRemoveMachine: (String) -> Unit,
    onLicenses: () -> Unit,
    onSignOut: () -> Unit,
) {
    val uriHandler = LocalUriHandler.current
    var removing by remember { mutableStateOf<MachineSummary?>(null) }
    var signingOut by remember { mutableStateOf(false) }
    Scaffold(
        containerColor = Weave.colors.canvas,
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Weave.colors.canvas),
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") } },
                title = { Text("Settings") },
            )
        },
    ) { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(WeaveSpacing.gutter)
                .testTag("settings.screen"),
            verticalArrangement = Arrangement.spacedBy(WeaveSpacing.s6),
        ) {
            GroupedCard(title = "Appearance") {
                Column(Modifier.selectableGroup()) {
                    AppearancePreference.entries.forEachIndexed { index, option ->
                        if (index > 0) Divider()
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .heightIn(min = WeaveSize.minTap)
                                .selectable(ui.appearance == option, role = Role.RadioButton) { onAppearance(option) }
                                .padding(horizontal = WeaveSpacing.s4)
                                .testTag("settings.appearance.${option.name.lowercase()}"),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(option.label, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
                            RadioButton(selected = ui.appearance == option, onClick = null)
                        }
                    }
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                        Divider()
                        SwitchRow("Use wallpaper colors", "Off keeps the SpecWithCode colors.", ui.dynamicColor, "settings.dynamicColor", onDynamicColor)
                    }
                }
            }
            GroupedCard(title = "Computers") {
                if (ui.machines.isEmpty()) {
                    Text(
                        "No computers paired.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = Weave.colors.muted,
                        modifier = Modifier.padding(WeaveSpacing.s4),
                    )
                }
                for (machine in ui.machines) {
                    Row(
                        Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(start = WeaveSpacing.s4, end = WeaveSpacing.s2),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        StatusDot(machine.status.tone())
                        Column(Modifier.weight(1f).padding(start = WeaveSpacing.s3).semantics(mergeDescendants = true) {}) {
                            Text(machine.displayName, style = MaterialTheme.typography.bodyLarge)
                            Text(machine.status.label, style = MaterialTheme.typography.bodySmall, color = Weave.colors.muted)
                        }
                        TextButton(
                            onClick = { removing = machine },
                            modifier = Modifier.heightIn(min = WeaveSize.minTap).testTag("settings.machine.remove.${machine.id}"),
                        ) { Text("Remove", color = Weave.colors.fail) }
                    }
                    Divider()
                }
                LinkRow("Manage computers", "settings.machines", onMachines)
            }
            GroupedCard(title = "Sample data") {
                SwitchRow(
                    "Show sample data",
                    "Try the app with made-up computers and projects. Nothing reaches a computer.",
                    ui.isSample,
                    "settings.sampleData",
                    onSampleData,
                )
            }
            GroupedCard(title = "About") {
                Row(Modifier.fillMaxWidth().heightIn(min = WeaveSize.minTap).padding(horizontal = WeaveSpacing.s4), verticalAlignment = Alignment.CenterVertically) {
                    Text("Version", style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
                    Text("${ui.versionName} (${ui.versionCode})", style = MaterialTheme.typography.bodyMedium, color = Weave.colors.muted, modifier = Modifier.testTag("settings.version"))
                }
                Divider()
                LinkRow("Privacy policy", "settings.privacy") { uriHandler.openUri(PRIVACY_POLICY_URL) }
                Divider()
                LinkRow("Open-source licenses", "settings.licenses", onLicenses)
            }
            if (ui.signedIn || ui.isSample) {
                GroupedCard {
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .heightIn(min = WeaveSize.minTap)
                            .clickable(role = Role.Button) { signingOut = true }
                            .padding(horizontal = WeaveSpacing.s4)
                            .testTag("settings.signOut"),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(if (ui.signedIn) "Sign out" else "Leave sample data", style = MaterialTheme.typography.bodyLarge, color = Weave.colors.fail)
                    }
                }
            }
        }
    }
    removing?.let { machine ->
        AlertDialog(
            onDismissRequest = { removing = null },
            title = { Text("Remove ${machine.displayName}?") },
            text = { Text("This phone forgets the computer and its sign-in. Nothing changes on the computer.") },
            confirmButton = {
                TextButton(onClick = { onRemoveMachine(machine.id); removing = null }, modifier = Modifier.testTag("settings.machine.remove.confirm")) {
                    Text("Remove", color = Weave.colors.fail)
                }
            },
            dismissButton = { TextButton(onClick = { removing = null }) { Text("Cancel") } },
        )
    }
    if (signingOut) {
        AlertDialog(
            onDismissRequest = { signingOut = false },
            title = { Text(if (ui.signedIn) "Sign out?" else "Leave sample data?") },
            text = {
                Text(
                    if (ui.signedIn) {
                        "Computers reached through SpecWithCode Connect disconnect until you sign in again. Paired computers stay."
                    } else {
                        "You go back to the start, where you can sign in or pair a computer."
                    },
                )
            },
            confirmButton = {
                TextButton(onClick = { signingOut = false; onSignOut() }, modifier = Modifier.testTag("settings.signOut.confirm")) {
                    Text(if (ui.signedIn) "Sign out" else "Leave", color = Weave.colors.fail)
                }
            },
            dismissButton = { TextButton(onClick = { signingOut = false }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun Divider() = HorizontalDivider(color = Weave.colors.line, modifier = Modifier.padding(start = WeaveSpacing.s4))

@Composable
private fun LinkRow(title: String, tag: String, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = WeaveSize.minTap)
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = WeaveSpacing.s4)
            .testTag(tag),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(title, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
        Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, tint = Weave.colors.control)
    }
}

@Composable
private fun SwitchRow(title: String, detail: String, checked: Boolean, tag: String, onChange: (Boolean) -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .toggleable(checked, role = Role.Switch, onValueChange = onChange)
            .padding(horizontal = WeaveSpacing.s4, vertical = WeaveSpacing.s2)
            .testTag(tag),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge)
            Text(detail, style = MaterialTheme.typography.bodySmall, color = Weave.colors.muted)
        }
        Switch(checked = checked, onCheckedChange = null)
    }
}
