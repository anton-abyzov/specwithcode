package com.specwithcode.android

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.specwithcode.android.app.InMemorySettingsStore
import com.specwithcode.android.app.TimelineDetailPrefs
import com.specwithcode.android.ui.chat.ChatViewModel
import com.specwithcode.android.ui.chat.showMenuDescription
import com.specwithcode.sync.AppModel
import com.specwithcode.sync.ChatTarget
import com.specwithcode.sync.FixtureEngine
import com.specwithcode.sync.FixtureScenario
import com.specwithcode.sync.ProjectRef
import com.specwithcode.sync.ReplyStyle
import com.specwithcode.sync.ThreadRef
import com.specwithcode.sync.TimelineDetail
import com.specwithcode.sync.TranscriptRow.Kind
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
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** The chat's Show levels, fold taps and the project's reply style. */
@OptIn(ExperimentalCoroutinesApi::class)
class ChatDisplayTest {
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

    @Test fun foldedStepsIsTheDefaultAndEverythingShowsEveryRow() = runTest(dispatcher) {
        val prefs = TimelineDetailPrefs(InMemorySettingsStore())
        val vm = make(ChatViewModel::class) { ChatViewModel(fixtureModel(), ChatTarget.Thread(release), prefs) }
        advanceUntilIdle()
        val ui = vm.ui.value
        assertEquals(TimelineDetail.Normal, ui.detail)
        assertFalse(ui.ownDetail)
        assertTrue(ui.rows.any { it.kind is Kind.Fold }, "Steps fold by default")
        assertTrue(ui.rows.size < ui.chat.rows.size)
        vm.setDetail(TimelineDetail.Verbose)
        advanceUntilIdle()
        assertEquals(vm.ui.value.chat.rows, vm.ui.value.rows)
        assertEquals(TimelineDetail.Verbose, prefs.value.default, "With Every thread a level becomes the default")
    }

    @Test fun tappingAFoldOpensAndClosesIt() = runTest(dispatcher) {
        val vm = make(ChatViewModel::class) { ChatViewModel(fixtureModel(), ChatTarget.Thread(release)) }
        advanceUntilIdle()
        val closed = vm.ui.value.rows
        val fold = closed.first { it.kind is Kind.Fold }
        vm.toggleFold(fold.id)
        advanceUntilIdle()
        val opened = vm.ui.value.rows
        assertTrue((opened.first { it.id == fold.id }.kind as Kind.Fold).expanded)
        assertTrue(opened.size > closed.size)
        vm.toggleFold(fold.id)
        advanceUntilIdle()
        assertEquals(closed, vm.ui.value.rows)
    }

    @Test fun thisThreadPinsTheLevelAndEveryThreadDropsIt() = runTest(dispatcher) {
        val prefs = TimelineDetailPrefs(InMemorySettingsStore())
        val vm = make(ChatViewModel::class) { ChatViewModel(fixtureModel(), ChatTarget.Thread(release), prefs) }
        advanceUntilIdle()
        vm.setDetailForThisThread(true)
        advanceUntilIdle()
        assertTrue(vm.ui.value.ownDetail)
        assertEquals(TimelineDetail.Normal, prefs.value.threads[vm.detailKey], "Pins the level shown now")
        vm.setDetail(TimelineDetail.Concise)
        advanceUntilIdle()
        assertEquals(TimelineDetail.Concise, vm.ui.value.detail)
        assertEquals(TimelineDetail.Normal, prefs.value.default, "The thread's own level leaves the default alone")
        assertEquals("Show: Results only (this thread)", showMenuDescription(vm.ui.value).substringAfter(". "))
        vm.setDetailForThisThread(false)
        advanceUntilIdle()
        assertFalse(vm.ui.value.ownDetail)
        assertEquals(TimelineDetail.Normal, vm.ui.value.detail, "Back to following the default")
        assertNull(prefs.value.threads[vm.detailKey])
    }

    @Test fun theDeviceDefaultReachesAnOpenChat() = runTest(dispatcher) {
        val prefs = TimelineDetailPrefs(InMemorySettingsStore())
        val vm = make(ChatViewModel::class) { ChatViewModel(fixtureModel(), ChatTarget.Project(specweave), prefs) }
        advanceUntilIdle()
        prefs.setDefault(TimelineDetail.Concise)
        advanceUntilIdle()
        assertEquals(TimelineDetail.Concise, vm.ui.value.detail)
    }

    @Test fun ownLevelsAreCappedOldestFirstAndSurviveARestart() {
        val settings = InMemorySettingsStore()
        val prefs = TimelineDetailPrefs(settings)
        repeat(TimelineDetailPrefs.MAX_THREADS + 5) { prefs.setThread("env:t-$it", TimelineDetail.Verbose) }
        assertEquals(TimelineDetailPrefs.MAX_THREADS, prefs.value.threads.size)
        assertNull(prefs.value.threads["env:t-4"])
        assertNotNull(prefs.value.threads["env:t-5"])
        // Choosing again makes a chat the newest.
        prefs.setThread("env:t-5", TimelineDetail.Concise)
        prefs.setThread("env:t-new", TimelineDetail.Concise)
        assertNotNull(prefs.value.threads["env:t-5"])
        assertNull(prefs.value.threads["env:t-6"])
        val reopened = TimelineDetailPrefs(settings)
        assertEquals(prefs.value, reopened.value)
        val raw = TimelineDetailPrefs.encode(listOf("a:b" to TimelineDetail.Concise, "c:d" to TimelineDetail.Verbose))
        assertEquals(listOf("a:b" to TimelineDetail.Concise, "c:d" to TimelineDetail.Verbose), TimelineDetailPrefs.decode(raw))
        assertEquals(listOf("a:b" to TimelineDetail.Concise), TimelineDetailPrefs.decode("a:b\tconcise\nbroken\nx\thuge"))
        assertEquals("env-1:t-9", TimelineDetailPrefs.key(ChatTarget.Thread(ThreadRef("env-1", "t-9"))))
    }

    @Test fun staleContentIsNotRunning() = runTest(dispatcher) {
        val model = fixtureModel(FixtureScenario.Running)
        val vm = make(ChatViewModel::class) { ChatViewModel(model, ChatTarget.Thread(release)) }
        advanceUntilIdle()
        assertTrue(vm.ui.value.rows.any { (it.kind as? Kind.Fold)?.running == true }, "A live fold while the run is current")
        model.session(ChatTarget.Thread(release)).update { it.copy(isStale = true) }
        advanceUntilIdle()
        assertTrue(vm.ui.value.chat.isRunning)
        assertFalse(vm.ui.value.rows.any { (it.kind as? Kind.Fold)?.running == true }, "No spinner on cached content")
    }

    @Test fun replyStyleShowsAndChangesForTheProject() = runTest(dispatcher) {
        val model = fixtureModel()
        val vm = make(ChatViewModel::class) { ChatViewModel(model, ChatTarget.Thread(release)) }
        advanceUntilIdle()
        val style = assertNotNull(vm.ui.value.replyStyle)
        assertEquals(ReplyStyle.Concise, style.style)
        assertFalse(style.isProjectOwn)
        assertTrue(style.canChange)
        assertTrue(showMenuDescription(vm.ui.value).startsWith("Agent replies: Concise. Show: Folded steps"))
        vm.setReplyStyle(ReplyStyle.Detailed)
        advanceUntilIdle()
        assertEquals(ReplyStyle.Detailed, vm.ui.value.replyStyle?.style)
        assertTrue(vm.ui.value.replyStyle?.isProjectOwn == true)
        assertFalse(vm.ui.value.savingReplyStyle)
        assertNull(vm.ui.value.error)
        // Another project on the same machine keeps the machine's style.
        assertEquals(ReplyStyle.Concise, model.value.replyStyle(ProjectRef(studio, "other"))?.style)
    }

    @Test fun replyStyleIsReadOnlyWhenTheMachineCannotChangeIt() = runTest(dispatcher) {
        val model = fixtureModel()
        val docs = model.threads(ProjectRef("env-travel-laptop", "docs-site")).first()
        val vm = make(ChatViewModel::class) { ChatViewModel(model, ChatTarget.Thread(docs.ref)) }
        advanceUntilIdle()
        val style = assertNotNull(vm.ui.value.replyStyle)
        assertFalse(style.canChange)
        assertEquals("Travel laptop is offline.", style.readOnlyReason)
        vm.setReplyStyle(ReplyStyle.Detailed)
        advanceUntilIdle()
        assertEquals(ReplyStyle.Concise, vm.ui.value.replyStyle?.style, "Nothing changes")
        assertEquals("Travel laptop is offline.", vm.ui.value.error, "and the phone says why")
    }

    @Test fun noReplyStyleWithoutTheMachinesSettings() = runTest(dispatcher) {
        val model = fixtureModel(FixtureScenario.Empty)
        val vm = make(ChatViewModel::class) { ChatViewModel(model, ChatTarget.Project(specweave)) }
        advanceUntilIdle()
        assertNull(vm.ui.value.replyStyle)
        assertTrue(showMenuDescription(vm.ui.value).startsWith("Show: "))
    }
}
