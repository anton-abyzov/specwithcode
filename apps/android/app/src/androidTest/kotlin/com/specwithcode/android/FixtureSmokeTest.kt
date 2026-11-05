package com.specwithcode.android

import android.content.Intent
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasAnyDescendant
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.ComposeTestRule
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performTextClearance
import androidx.compose.ui.test.performTextInput
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Smoke checks on sample data. Nothing leaves the device: the fixture engine answers everything,
 * and the pairing check never presses Connect.
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
class FixtureSmokeTest {
    @get:Rule val compose = createEmptyComposeRule()

    private fun launch(fixture: String?): ActivityScenario<MainActivity> {
        val intent = Intent(ApplicationProvider.getApplicationContext(), MainActivity::class.java)
        fixture?.let { intent.putExtra(MainActivity.EXTRA_FIXTURE, it) }
        return ActivityScenario.launch(intent)
    }

    @Test fun threadListOpensAThreadSendsAndApproves() {
        launch("default").use {
            compose.waitUntilExactlyOneExists(hasTestTag("thread.list"), timeoutMillis = 15_000)

            // Sample threads from more than one project are listed.
            for (id in listOf("t-release", "t-handoff", "t-ranking")) {
                compose.onNodeWithTag("thread.list").performScrollToNode(hasTestTag("thread.row.$id"))
                compose.onNodeWithTag("thread.row.$id").assertIsDisplayed()
            }

            compose.onNodeWithTag("thread.list").performScrollToNode(hasTestTag("thread.row.t-release"))
            compose.onNodeWithTag("thread.row.t-release").performClick()
            compose.waitUntilExactlyOneExists(hasTestTag("chat.transcript"), timeoutMillis = 10_000)
            compose.waitUntilExactlyOneExists(hasTestTag("approval.card"), timeoutMillis = 10_000)

            compose.onNodeWithTag("composer.input").performTextInput("Ship it")
            compose.onNodeWithTag("composer.send").assertIsEnabled().performClick()
            // The reply streams in below and can push the sent row out of the lazy list's
            // composition, so scroll the transcript to it rather than expecting it on screen.
            val sentRow = hasTestTag("transcript.row.user") and hasAnyDescendant(hasText("Ship it", substring = true))
            compose.waitUntil(timeoutMillis = 20_000) {
                runCatching { compose.onNodeWithTag("chat.transcript").performScrollToNode(sentRow) }.isSuccess
            }
            compose.onNode(sentRow).assertExists()

            // The approval card stays answerable; approving resolves it.
            compose.onNodeWithTag("chat.transcript").performScrollToNode(hasTestTag("approval.card"))
            compose.onNodeWithTag("approval.card").assertIsDisplayed()
            compose.waitUntil(timeoutMillis = 15_000) { compose.isEnabled("approval.approve") }
            compose.onNodeWithTag("approval.approve").performClick()
            compose.waitUntilDoesNotExist(hasTestTag("approval.approve"), timeoutMillis = 10_000)
            compose.onNodeWithTag("chat.transcript").performScrollToNode(hasTestTag("approval.card"))
            compose.onNodeWithTag("approval.card").assertIsDisplayed()
        }
    }

    @Test fun manualPairingValidatesInput() {
        // No fixture: a fresh install starts on the welcome screen with no machines.
        launch(null).use {
            compose.waitUntil(timeoutMillis = 15_000) {
                compose.exists("welcome.screen") || compose.exists("home.settings")
            }
            val live = compose.exists("welcome.screen")
            if (live) {
                compose.onNodeWithTag("welcome.pair").performClick()
            } else {
                compose.onNodeWithTag("home.machines").performClick()
                compose.onNodeWithTag("machines.pair").performClick()
            }
            compose.waitUntilExactlyOneExists(hasTestTag("pairing.screen"), timeoutMillis = 10_000)
            compose.onNodeWithTag("pairing.mode.manual").performClick()
            compose.onNodeWithTag("pairing.connect").assertIsNotEnabled()

            // A bare IP address is paired over plain http, so the warning shows.
            compose.onNodeWithTag("pairing.manual.host").performTextInput("192.168.1.20:3773")
            compose.waitUntilExactlyOneExists(hasTestTag("pairing.cleartext"), timeoutMillis = 5_000)

            // Too short.
            compose.onNodeWithTag("pairing.manual.code").performTextInput("abc")
            compose.onNodeWithText("9 more characters").assertExists()
            compose.onNodeWithTag("pairing.connect").assertIsNotEnabled()

            // Twelve characters, but 0, 1, I and O are not in the code alphabet.
            compose.onNodeWithTag("pairing.manual.code").performTextClearance()
            compose.onNodeWithTag("pairing.manual.code").performTextInput("ABCD-EFGH-IJK0")
            compose.onNodeWithText("Use the 12-character code shown on your computer.").assertExists()
            compose.onNodeWithTag("pairing.connect").assertIsNotEnabled()

            // A valid code, typed lower case with dashes.
            compose.onNodeWithTag("pairing.manual.code").performTextClearance()
            compose.onNodeWithTag("pairing.manual.code").performTextInput("abcd-efgh-jkmn")
            compose.waitUntilDoesNotExist(hasText("Use the 12-character code shown on your computer."), timeoutMillis = 5_000)
            compose.onNodeWithTag("pairing.connect").performScrollTo()
            if (live) {
                compose.onNodeWithTag("pairing.connect").assertIsEnabled()
            } else {
                // Sample data never pairs.
                compose.onNodeWithTag("pairing.connect").assertIsNotEnabled()
            }

            // An unreadable address disables Connect again.
            compose.onNodeWithTag("pairing.manual.host").performTextClearance()
            compose.onNodeWithTag("pairing.manual.host").performTextInput("not a host")
            compose.onNodeWithTag("pairing.connect").assertIsNotEnabled()
        }
    }
}

private fun ComposeTestRule.exists(tag: String): Boolean =
    onAllNodes(hasTestTag(tag)).fetchSemanticsNodes().isNotEmpty()

private fun ComposeTestRule.isEnabled(tag: String): Boolean {
    val nodes = onAllNodes(hasTestTag(tag)).fetchSemanticsNodes()
    return nodes.isNotEmpty() && nodes.none { SemanticsProperties.Disabled in it.config }
}
