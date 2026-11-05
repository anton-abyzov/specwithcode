package com.specwithcode.android.ui.welcome

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.res.painterResource
import com.specwithcode.android.R
import com.specwithcode.android.app.SignInState
import com.specwithcode.android.ui.components.Banner
import com.specwithcode.android.ui.components.Tone
import com.specwithcode.android.ui.theme.Weave
import com.specwithcode.android.ui.theme.WeaveRadius
import com.specwithcode.android.ui.theme.WeaveSize
import com.specwithcode.android.ui.theme.WeaveSpacing
import com.specwithcode.android.ui.theme.WeaveToken

/** First launch: sign in with Connect, pair with a code, or look around with sample data. */
@Composable
fun WelcomeScreen(signIn: SignInState, onSignIn: () -> Unit, onPair: () -> Unit, onSampleData: () -> Unit) {
    val colors = Weave.colors
    Box(Modifier.fillMaxSize().background(colors.canvas).statusBarsPadding().navigationBarsPadding(), contentAlignment = Alignment.Center) {
        Column(
            Modifier
                .widthIn(max = 480.dp)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = WeaveSpacing.s6, vertical = WeaveSpacing.s8)
                .testTag("welcome.screen"),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(WeaveSpacing.s4),
        ) {
            Box(
                Modifier.size(72.dp).clip(RoundedCornerShape(20.dp)).background(Color(WeaveToken.BRAND)).clearAndSetSemantics {},
                contentAlignment = Alignment.Center,
            ) { Image(painterResource(R.drawable.ic_launcher_foreground), contentDescription = null, modifier = Modifier.size(72.dp)) }
            Text(
                "SpecWithCode",
                style = MaterialTheme.typography.headlineMedium,
                color = colors.ink,
                modifier = Modifier.semantics { heading() },
            )
            Text(
                "Follow your projects, answer approvals and keep work moving on your computers, from your phone.",
                style = MaterialTheme.typography.bodyLarge,
                color = colors.muted,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.heightIn(min = WeaveSpacing.s4))
            Button(
                onClick = onSignIn,
                enabled = !signIn.busy,
                modifier = Modifier.fillMaxWidth().heightIn(min = WeaveSize.minTap).testTag("welcome.signIn"),
                shape = RoundedCornerShape(WeaveRadius.lg),
            ) {
                if (signIn.busy) CircularProgressIndicator(Modifier.size(18.dp).padding(end = 4.dp), strokeWidth = 2.dp, color = colors.onIris)
                Text(if (signIn.busy) "Signing in…" else "Sign in with SpecWithCode Connect")
            }
            Text(
                "Use the same account as on your computer. Works from anywhere.",
                style = MaterialTheme.typography.bodySmall,
                color = colors.muted,
                textAlign = TextAlign.Center,
            )
            signIn.error?.let { Banner(it, Tone.Fail, Modifier.testTag("welcome.error")) }
            OutlinedButton(
                onClick = onPair,
                modifier = Modifier.fillMaxWidth().heightIn(min = WeaveSize.minTap).testTag("welcome.pair"),
                shape = RoundedCornerShape(WeaveRadius.lg),
            ) { Text("Pair with a QR code or link") }
            TextButton(
                onClick = onSampleData,
                modifier = Modifier.heightIn(min = WeaveSize.minTap).testTag("welcome.sampleData"),
            ) { Text("Explore with sample data") }
        }
    }
}
