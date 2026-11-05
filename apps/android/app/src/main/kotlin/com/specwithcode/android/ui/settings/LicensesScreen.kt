package com.specwithcode.android.ui.settings

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import com.specwithcode.android.ui.components.GroupedCard
import com.specwithcode.android.ui.theme.Weave
import com.specwithcode.android.ui.theme.WeaveSize
import com.specwithcode.android.ui.theme.WeaveSpacing

/** A third-party library the app ships, with its license. */
data class OpenSourceLibrary(val name: String, val owner: String, val license: String, val url: String)

private const val APACHE = "Apache License 2.0"
private const val APACHE_URL = "https://www.apache.org/licenses/LICENSE-2.0"

/** Libraries bundled in the app. Keep in step with app/build.gradle.kts and the modules it uses. */
val OpenSourceLibraries: List<OpenSourceLibrary> = listOf(
    OpenSourceLibrary("AndroidX (Activity, Core, Lifecycle, Navigation)", "The Android Open Source Project", APACHE, APACHE_URL),
    OpenSourceLibrary("Jetpack Compose and Material 3", "The Android Open Source Project", APACHE, APACHE_URL),
    OpenSourceLibrary("CameraX", "The Android Open Source Project", APACHE, APACHE_URL),
    OpenSourceLibrary("ML Kit Barcode Scanning", "Google LLC", "ML Kit Terms of Service", "https://developers.google.com/ml-kit/terms"),
    OpenSourceLibrary("Kotlin standard library", "JetBrains s.r.o.", APACHE, APACHE_URL),
    OpenSourceLibrary("kotlinx.coroutines", "JetBrains s.r.o.", APACHE, APACHE_URL),
    OpenSourceLibrary("kotlinx.serialization", "JetBrains s.r.o.", APACHE, APACHE_URL),
    OpenSourceLibrary("OkHttp and Okio", "Square, Inc.", APACHE, APACHE_URL),
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LicensesScreen(onBack: () -> Unit) {
    val uriHandler = LocalUriHandler.current
    Scaffold(
        containerColor = Weave.colors.canvas,
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Weave.colors.canvas),
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") } },
                title = { Text("Open-source licenses") },
            )
        },
    ) { padding ->
        LazyColumn(
            Modifier.fillMaxSize().padding(padding).testTag("licenses.list"),
            contentPadding = PaddingValues(WeaveSpacing.gutter),
            verticalArrangement = Arrangement.spacedBy(WeaveSpacing.s3),
        ) {
            item {
                Text(
                    "SpecWithCode for Android is built with these libraries. Tap one to read its license.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = Weave.colors.muted,
                )
            }
            items(OpenSourceLibraries, key = { it.name }) { library ->
                GroupedCard {
                    Column(
                        Modifier
                            .fillMaxWidth()
                            .heightIn(min = WeaveSize.minTap)
                            .clickable(role = Role.Button, onClickLabel = "Read the license") { uriHandler.openUri(library.url) }
                            .padding(WeaveSpacing.s4),
                    ) {
                        Text(library.name, style = MaterialTheme.typography.bodyLarge)
                        Text("${library.owner} · ${library.license}", style = MaterialTheme.typography.bodySmall, color = Weave.colors.muted)
                    }
                }
            }
        }
    }
}
