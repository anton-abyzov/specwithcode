package com.specwithcode.android

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.specwithcode.android.app.AppSessionHolder
import com.specwithcode.android.app.AppViewModel
import com.specwithcode.android.app.ConnectSignInUnavailable
import com.specwithcode.android.app.EngineMode
import com.specwithcode.android.app.InMemorySettingsStore
import com.specwithcode.android.app.PendingLiveEngine
import com.specwithcode.android.ui.chat.ChatViewModel
import com.specwithcode.android.ui.home.OverviewUi
import com.specwithcode.android.ui.newthread.NewThreadViewModel
import com.specwithcode.android.ui.pairing.PairingMode
import com.specwithcode.android.ui.pairing.PairingViewModel
import com.specwithcode.sync.AppModel
import com.specwithcode.sync.AppearancePreference
import com.specwithcode.sync.ApprovalDecision
import com.specwithcode.sync.ChatTarget
import com.specwithcode.sync.FixtureEngine
import com.specwithcode.sync.FixtureScenario
import com.specwithcode.sync.MachineStatus
import com.specwithcode.sync.MachineSummary
import com.specwithcode.sync.ProjectRef
import com.specwithcode.sync.RuntimeModeChoice
import com.specwithcode.sync.ThreadActivity
import com.specwithcode.sync.ThreadRef
import com.specwithcode.sync.TranscriptRow.Kind
import com.specwithcode.sync.UserMessageState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Before
import org.junit.Test
import kotlin.reflect.KClass
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

@OptIn(ExperimentalCoroutinesApi::class)
class ViewModelTest {
    private val dispatcher = StandardTestDispatcher()
    private val studio = "env-studio-mac"
    private val specweave = ProjectRef(studio, "specweave")
    private val release = ThreadRef(studio, "t-release")
    private val store = ViewModelStore()

    @Before fun setUp() = Dispatchers.setMain(dispatcher)

    @After fun tearDown() {
        store.clear()
        Dispatchers.resetMain()
    }

    private fun TestScope.fixtureModel(scenario: FixtureScenario = FixtureScenario.Default): AppModel {
        val engine = FixtureEngine(scenario, aideEnabled = true, scope = this)
        engine.latencyMs = 0
        engine.streamDelayMs = 0
        return AppModel(engine)
    }

    private inline fun <reified T : ViewModel> make(type: KClass<T>, noinline create: () -> T): T =
        ViewModelProvider.create(store, viewModelFactory { initializer { create() } })[type]

    @Test fun chatSendsAndStreamsAReply() = runTest(dispatcher) {
        val model = fixtureModel()
        val vm = make(ChatViewModel::class) { ChatViewModel(model, ChatTarget.Thread(release)) }
        advanceUntilIdle()
        assertTrue(vm.ui.value.chat.isLoaded)
        assertFalse(vm.ui.value.canSend, "Nothing typed yet")
        vm.setDraft("  Ship it  ")
        advanceUntilIdle()
        assertTrue(vm.ui.value.canSend)
        vm.send()
        dispatcher.scheduler.runCurrent()
        assertEquals("", vm.ui.value.draft, "The box clears at once")
        advanceUntilIdle()
        val rows = vm.ui.value.chat.rows
        assertTrue(rows.any { (it.kind as? Kind.User)?.text == "Ship it" })
        assertIs<Kind.Assistant>(rows.last().kind)
        assertFalse(vm.ui.value.chat.isRunning)
        assertNull(vm.ui.value.error)
    }

    @Test fun approvingResolvesTheCard() = runTest(dispatcher) {
        val model = fixtureModel()
        val vm = make(ChatViewModel::class) { ChatViewModel(model, ChatTarget.Thread(release)) }
        advanceUntilIdle()
        vm.respond("req-publish", ApprovalDecision.Approve)
        advanceUntilIdle()
        assertTrue(vm.ui.value.busyRequests.isEmpty())
        val card = vm.ui.value.chat.rows.firstNotNullOf { (it.kind as? Kind.Approval)?.takeIf { a -> a.requestId == "req-publish" } }
        assertTrue(card.resolved)
        vm.respond("req-missing", ApprovalDecision.Deny)
        advanceUntilIdle()
        assertEquals("That request is no longer waiting for an answer.", vm.ui.value.error)
    }

    @Test fun runningChatQueuesAndStops() = runTest(dispatcher) {
        val model = fixtureModel(FixtureScenario.Running)
        val vm = make(ChatViewModel::class) { ChatViewModel(model, ChatTarget.Thread(release)) }
        advanceUntilIdle()
        assertTrue(vm.ui.value.showsStop)
        assertTrue(vm.ui.value.canStop)
        vm.setDraft("Also update the changelog")
        vm.send()
        advanceUntilIdle()
        val queued = vm.ui.value.chat.rows.last { it.kind is Kind.User }.kind as Kind.User
        assertEquals(UserMessageState.Queued, queued.state)
        vm.stop()
        advanceUntilIdle()
        assertFalse(vm.ui.value.chat.isRunning)
        assertFalse(vm.ui.value.showsStop)
    }

    @Test fun offlineChatBlocksSending() = runTest(dispatcher) {
        val model = fixtureModel()
        val docs = model.threads(ProjectRef("env-travel-laptop", "docs-site")).first()
        val vm = make(ChatViewModel::class) { ChatViewModel(model, ChatTarget.Thread(docs.ref)) }
        advanceUntilIdle()
        vm.setDraft("hello")
        advanceUntilIdle()
        assertNotNull(vm.ui.value.chat.sendBlockedReason)
        assertFalse(vm.ui.value.canSend)
        assertEquals(vm.ui.value.chat.sendBlockedReason, vm.ui.value.notice)
    }

    @Test fun pairingBuildsTheManualLink() = runTest(dispatcher) {
        val calls = mutableListOf<Pair<String, String?>>()
        val vm = make(PairingViewModel::class) {
            PairingViewModel({ link: String, expected: String? ->
                calls += link to expected
                MachineSummary("env-new", "Office Mac", MachineStatus.Connected)
            })
        }
        vm.setMode(PairingMode.Manual)
        vm.setHost("192.168.1.20:3773")
        vm.setCode("abcd2345")
        assertFalse(vm.ui.value.canConnect)
        assertEquals("4 more characters", vm.ui.value.codeHint)
        vm.setCode("abcd-2345-efgh")
        assertTrue(vm.ui.value.canConnect)
        assertTrue(vm.ui.value.isCleartext)
        vm.connect()
        advanceUntilIdle()
        assertEquals(listOf<Pair<String, String?>>("http://192.168.1.20:3773/pair#token=ABCD2345EFGH" to null), calls)
        assertEquals("env-new", vm.ui.value.paired?.id)
    }

    @Test fun aLinkFromAnotherAppWaitsForConnect() = runTest(dispatcher) {
        val calls = mutableListOf<String>()
        val pair: suspend (String, String?) -> MachineSummary = { link, _ ->
            calls += link
            MachineSummary("env-new", "Office Mac", MachineStatus.Connected)
        }
        val hostile = PairingViewModel(pair, initialLink = "http://attacker.example/pair#token=ABCD2345EFGH")
        advanceUntilIdle()
        assertTrue(calls.isEmpty())
        assertTrue(hostile.ui.value.fromExternalLink)
        assertEquals("attacker.example", hostile.ui.value.linkHost)
        hostile.connect()
        advanceUntilIdle()
        // Plain http to an internet host is refused for links from other apps.
        assertTrue(calls.isEmpty())
        assertTrue(hostile.ui.value.error!!.contains("unencrypted"))

        val lan = PairingViewModel(pair, initialLink = "http://192.168.1.20:3773/pair#token=ABCD2345EFGH")
        advanceUntilIdle()
        assertTrue(calls.isEmpty())
        lan.connect()
        advanceUntilIdle()
        assertEquals(listOf("http://192.168.1.20:3773/pair#token=ABCD2345EFGH"), calls)
    }

    @Test fun pairingShowsTheEngineError() = runTest(dispatcher) {
        val model = fixtureModel()
        val vm = make(PairingViewModel::class) { PairingViewModel({ l: String, e: String? -> model.engine.pair(l, e) }) }
        vm.connect()
        advanceUntilIdle()
        assertEquals("Paste the pairing link from your computer.", vm.ui.value.error)
        vm.onScanned("https://bad.example/pair#token=ABCD2345EFGH")
        advanceUntilIdle()
        assertTrue(vm.ui.value.error!!.startsWith("This pairing link didn't work"))
        assertNull(vm.ui.value.paired)
        vm.onScanned("studio://pair?pairingUrl=" + java.net.URLEncoder.encode("https://new-box.local:3773/pair#token=ABCD2345EFGH", "UTF-8"))
        advanceUntilIdle()
        assertEquals("https://new-box.local:3773", vm.ui.value.paired?.address)
        assertTrue(model.machines.any { it.address == "https://new-box.local:3773" })
    }

    @Test fun newThreadStartsInTheChosenProject() = runTest(dispatcher) {
        val model = fixtureModel()
        val vm = make(NewThreadViewModel::class) { NewThreadViewModel(model, specweave) }
        advanceUntilIdle()
        val ui = vm.ui.value
        assertEquals("SpecWeave", ui.project?.title)
        assertTrue(ui.models.isNotEmpty())
        assertFalse(ui.canStart, "No message yet")
        vm.selectModel(ui.models.first())
        vm.selectRuntimeMode(RuntimeModeChoice.AutoAcceptEdits)
        vm.setText("Add a dark theme")
        advanceUntilIdle()
        assertTrue(vm.ui.value.canStart)
        vm.start()
        advanceUntilIdle()
        val created = assertNotNull(vm.ui.value.created)
        assertEquals("Add a dark theme", model.thread(created)?.title)
        // An offline project can't start one.
        vm.selectProject(ProjectRef("env-travel-laptop", "docs-site"))
        advanceUntilIdle()
        assertFalse(vm.ui.value.canStart)
        assertNotNull(vm.ui.value.blockedReason)
    }

    @Test fun overviewCountsWhatNeedsYou() = runTest(dispatcher) {
        val model = fixtureModel()
        val overview = OverviewUi.from(model.value)
        assertNotNull(overview.aide)
        assertEquals(listOf("SpecWeave", "Verified Skill"), overview.pinned.map { it.project.title })
        val needs = model.threadsByProject.values.flatten().distinctBy { it.ref }
            .count { it.activity == ThreadActivity.NeedsYou && !it.isResolved && !it.isUnknown }
        assertTrue(needs > 0)
        assertEquals(needs, overview.totalPending)
        assertEquals(overview.totalPending, overview.needsYou.size)
        assertTrue(overview.recent.none { it in overview.needsYou })
        val specweave = overview.pinned.first()
        assertEquals(model.threads(specweave.project.ref).count { it.activity == ThreadActivity.NeedsYou && !it.isResolved }, specweave.pendingCount)
        assertTrue(OverviewUi.from(fixtureModel(FixtureScenario.Empty).value).isEmpty)
    }

    @Test fun sessionHolderSwitchesBetweenSampleAndLive() = runTest(dispatcher) {
        val settings = InMemorySettingsStore(appearance = AppearancePreference.Dark)
        val holder = AppSessionHolder(settings, scopeFactory = { kotlinx.coroutines.CoroutineScope(dispatcher) }, fixtureDelays = false)
        assertEquals(EngineMode.Live, holder.current.mode)
        assertIs<PendingLiveEngine>(holder.current.model.engine)
        assertEquals(AppearancePreference.Dark, holder.current.model.value.appearance)
        val app = make(AppViewModel::class) { AppViewModel(holder, settings, ConnectSignInUnavailable(), io = dispatcher) }
        assertFalse(AppViewModel.startsAtHome(holder.current.model.value, holder.current.isSample, signedIn = false))
        app.useSampleData(FixtureScenario.Default)
        assertTrue(holder.current.isSample)
        assertEquals("default", settings.sampleScenario)
        assertTrue(AppViewModel.startsAtHome(holder.current.model.value, true, signedIn = false))
        app.setAppearance(AppearancePreference.Light)
        assertEquals(AppearancePreference.Light, settings.appearance)
        assertEquals(AppearancePreference.Light, holder.current.model.value.appearance)
        app.exitSampleData()
        assertEquals(EngineMode.Live, holder.current.mode)
        assertNull(settings.sampleScenario)
        // A launch with the fixture extra does not change the saved choice.
        holder.switchTo(EngineMode.Sample(FixtureScenario.Running), persist = false)
        assertTrue(holder.current.isSample)
        assertNull(settings.sampleScenario)
    }

    /** Records what the holder tells the live engine about the foreground. */
    private class RecordingEngine(private val inner: PendingLiveEngine = PendingLiveEngine()) : com.specwithcode.sync.AppEngine by inner {
        val active = mutableListOf<Boolean>()

        override fun setActive(active: Boolean) {
            this.active += active
        }
    }

    @Test fun switchingEnginesMovesTheForegroundToTheNewOne() = runTest(dispatcher) {
        val live = RecordingEngine()
        val holder = AppSessionHolder(
            InMemorySettingsStore(),
            liveEngine = { live },
            scopeFactory = { kotlinx.coroutines.CoroutineScope(dispatcher) },
            fixtureDelays = false,
        )
        holder.setActive(true)
        assertEquals(listOf(true), live.active)
        // Live to sample data: the live engine lets go of its sockets.
        holder.switchTo(EngineMode.Sample(FixtureScenario.Default), persist = false)
        assertEquals(listOf(true, false), live.active)
        // Back to live while in the foreground: the engine connects again.
        holder.switchTo(EngineMode.Live, persist = false)
        assertEquals(listOf(true, false, true), live.active)
        // In the background a switch leaves the new engine inactive.
        holder.setActive(false)
        holder.switchTo(EngineMode.Sample(FixtureScenario.Running), persist = false)
        holder.switchTo(EngineMode.Live, persist = false)
        assertEquals(listOf(true, false, true, false, false), live.active)
    }

    @Test fun signInReportsWhyItIsUnavailable() = runTest(dispatcher) {
        val settings = InMemorySettingsStore()
        val holder = AppSessionHolder(settings, scopeFactory = { kotlinx.coroutines.CoroutineScope(dispatcher) }, fixtureDelays = false)
        val app = make(AppViewModel::class) { AppViewModel(holder, settings, ConnectSignInUnavailable(), io = dispatcher) }
        // The saved sign-in is read off the main thread, so it starts unknown.
        assertFalse(app.signIn.value.known)
        advanceUntilIdle()
        assertTrue(app.signIn.value.known)
        app.signIn()
        assertTrue(app.signIn.value.busy)
        advanceUntilIdle()
        assertFalse(app.signIn.value.busy)
        assertFalse(app.signIn.value.signedIn)
        assertNotNull(app.signIn.value.error)
        app.handleDeepLink("specwithcode://thread/$studio/t-release")
        assertEquals(com.specwithcode.android.app.DeepLink.Thread(studio, "t-release"), app.pendingDeepLink.value)
        app.consumeDeepLink()
        assertNull(app.pendingDeepLink.value)
    }
}
