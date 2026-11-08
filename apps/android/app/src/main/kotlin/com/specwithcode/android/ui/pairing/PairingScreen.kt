package com.specwithcode.android.ui.pairing

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.specwithcode.android.ui.components.Banner
import com.specwithcode.android.ui.components.Tone
import com.specwithcode.android.ui.theme.Weave
import com.specwithcode.android.ui.theme.WeaveRadius
import com.specwithcode.android.ui.theme.WeaveSize
import com.specwithcode.android.ui.theme.WeaveSpacing
import com.specwithcode.sync.MachineSummary

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PairingScreen(
    viewModel: PairingViewModel,
    pairingAgain: String?,
    isSample: Boolean,
    onExitSample: () -> Unit,
    onBack: () -> Unit,
    onPaired: (MachineSummary) -> Unit,
) {
    val ui by viewModel.ui.collectAsStateWithLifecycle()
    var scanning by rememberSaveable { mutableStateOf(false) }
    LaunchedEffect(ui.paired) { ui.paired?.let(onPaired) }
    Scaffold(
        containerColor = Weave.colors.canvas,
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Weave.colors.canvas),
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") }
                },
                title = { Text(if (pairingAgain == null) "Pair a computer" else "Pair again") },
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
                .testTag("pairing.screen"),
            verticalArrangement = Arrangement.spacedBy(WeaveSpacing.s4),
        ) {
            Text(
                "On ${pairingAgain ?: "your computer"}, open SpecWithCode, go to Settings > Machines and choose Pair a phone. " +
                    "Then scan the code, copy the link, or type the address and code it shows.",
                style = MaterialTheme.typography.bodyMedium,
                color = Weave.colors.muted,
            )
            if (isSample) {
                Banner(
                    "Leave sample data to pair your own computer.",
                    Tone.Accent,
                    title = "This is sample data",
                    actionLabel = "Leave sample data",
                    onAction = onExitSample,
                )
            }
            OutlinedButton(
                onClick = { scanning = true },
                enabled = !ui.connecting,
                modifier = Modifier.fillMaxWidth().heightIn(min = WeaveSize.minTap).testTag("pairing.scan"),
                shape = RoundedCornerShape(WeaveRadius.lg),
            ) { Text("Scan QR code") }

            SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                PairingMode.entries.forEachIndexed { index, mode ->
                    SegmentedButton(
                        selected = ui.mode == mode,
                        onClick = { viewModel.setMode(mode) },
                        shape = SegmentedButtonDefaults.itemShape(index, PairingMode.entries.size),
                        modifier = Modifier.heightIn(min = WeaveSize.minTap).testTag("pairing.mode.${mode.name.lowercase()}"),
                    ) { Text(if (mode == PairingMode.Link) "Paste a link" else "Type a code") }
                }
            }

            when (ui.mode) {
                PairingMode.Link -> OutlinedTextField(
                    value = ui.link,
                    onValueChange = viewModel::setLink,
                    label = { Text("Pairing link") },
                    placeholder = { Text("https://…#token=…") },
                    singleLine = true,
                    enabled = !ui.connecting,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Go, autoCorrectEnabled = false),
                    keyboardActions = KeyboardActions(onGo = { viewModel.connect() }),
                    modifier = Modifier.fillMaxWidth().testTag("pairing.link"),
                )
                PairingMode.Manual -> {
                    OutlinedTextField(
                        value = ui.host,
                        onValueChange = viewModel::setHost,
                        label = { Text("Computer address") },
                        placeholder = { Text("192.168.1.20:3773 or m4.example.ts.net") },
                        singleLine = true,
                        enabled = !ui.connecting,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next, autoCorrectEnabled = false),
                        modifier = Modifier.fillMaxWidth().testTag("pairing.manual.host"),
                    )
                    OutlinedTextField(
                        value = ui.code,
                        onValueChange = viewModel::setCode,
                        label = { Text("Pairing code") },
                        placeholder = { Text("12 characters") },
                        singleLine = true,
                        enabled = !ui.connecting,
                        supportingText = ui.codeHint?.let { hint -> { Text(hint) } },
                        keyboardOptions = KeyboardOptions(
                            capitalization = KeyboardCapitalization.Characters,
                            keyboardType = KeyboardType.Ascii,
                            imeAction = ImeAction.Go,
                            autoCorrectEnabled = false,
                        ),
                        keyboardActions = KeyboardActions(onGo = { viewModel.connect() }),
                        modifier = Modifier.fillMaxWidth().testTag("pairing.manual.code"),
                    )
                }
            }
            if (ui.fromExternalLink) {
                ui.linkHost?.let { host ->
                    Banner(
                        "A link asked to pair with $host. Tap Connect only if that is your computer.",
                        Tone.Warn,
                        Modifier.testTag("pairing.external"),
                        title = "Check the computer",
                    )
                }
            }
            if (ui.isCleartext) {
                Banner(
                    "This address uses plain http, so the sign-in travels unencrypted on your network. Use it only on a network you trust, or pair over https or Tailscale.",
                    Tone.Warn,
                    Modifier.testTag("pairing.cleartext"),
                )
            }
            ui.error?.let { Banner(it, Tone.Fail, Modifier.testTag("pairing.error"), title = "Couldn't pair") }
            Button(
                onClick = viewModel::connect,
                enabled = ui.canConnect && !isSample,
                modifier = Modifier.fillMaxWidth().heightIn(min = WeaveSize.minTap).testTag("pairing.connect"),
                shape = RoundedCornerShape(WeaveRadius.lg),
            ) {
                if (ui.connecting) {
                    CircularProgressIndicator(Modifier.padding(end = WeaveSpacing.s2).heightIn(max = 18.dp), strokeWidth = 2.dp)
                    Text("Connecting")
                } else {
                    Text("Connect")
                }
            }
        }
    }
    if (scanning) {
        QrScannerDialog(
            onCode = {
                scanning = false
                viewModel.onScanned(it)
            },
            onDismiss = { scanning = false },
        )
    }
}
