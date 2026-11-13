package com.specwithcode.sync

import com.specwithcode.sync.TranscriptRow.Kind
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class FixtureEngineTest {
    private val studio = "env-studio-mac"
    private val release = ThreadRef(studio, "t-release")

    private fun TestScope.make(scenario: FixtureScenario = FixtureScenario.Default, aideEnabled: Boolean = true): Pair<AppModel, FixtureEngine> {
        val engine = FixtureEngine(scenario, aideEnabled, scope = this)
        engine.latencyMs = 0
        engine.streamDelayMs = 0
        return AppModel(engine) to engine
    }

    @Test fun defaultScenarioHasSampleData() = runTest {
        val (model, _) = make()
        assertFalse(model.isLoading)
        assertEquals(listOf("Office Mac", "Build box", "Travel laptop"), model.machines.map { it.label })
        assertEquals(listOf(MachineStatus.Connected, MachineStatus.Connected, MachineStatus.Offline), model.machines.map { it.status })
        val aide = assertNotNull(model.aide)
        assertEquals(ProjectKind.Personal, aide.kind)
        assertEquals(studio, aide.ref.environmentId)
        assertEquals(listOf("SpecWeave", "Verified Skill", "Docs site", "Recipe app"), model.projects.map { it.title })
        assertEquals(2, model.pinnedProjects.size)
        val specweave = model.projects.first()
        assertEquals(2, specweave.workingCount)
        assertTrue(specweave.hasUnread)
        assertEquals(false, model.projects.firstOrNull { it.title == "Docs site" }?.machineOnline)
        assertEquals(14, model.threadsByProject.values.sumOf { it.size })
        assertEquals(10, model.recentThreads.size)
        assertEquals(true, model.recentThreads.firstOrNull()?.isPinned)
        assertEquals(ThreadActivity.entries.toSet(), model.threadsByProject.values.flatten().map { it.activity }.toSet())
        // Threads on the offline laptop show an unknown state, not idle.
        assertTrue(model.threads(FixtureSample.docs).all { it.isUnknown })
    }

    @Test fun aideTurnedOffIsHiddenAndNeverSetUp() = runTest {
        val (model, engine) = make(aideEnabled = false)
        assertFalse(model.aideEnabled)
        assertNull(model.aide)
        assertEquals(listOf("SpecWeave", "Verified Skill", "Docs site", "Recipe app"), model.projects.map { it.title })
        assertFailsWith<SyncError.AideDisabled> { engine.setupAide() }
        assertNull(model.aide)
        assertTrue(make().first.aideEnabled)
    }

    @Test fun emptyScenarioHasNoMachines() = runTest {
        val (model, _) = make(FixtureScenario.Empty)
        assertFalse(model.isLoading)
        assertTrue(model.machines.isEmpty())
        assertNull(model.aide)
        assertTrue(model.projects.isEmpty())
    }

    @Test fun longScenarioGivesAideALongHistoryWithLinks() = runTest {
        val (model, engine) = make(FixtureScenario.Long)
        val aide = assertNotNull(model.aide)
        val session = model.session(ChatTarget.Aide(aide.ref))
        engine.open(session)
        assertEquals(124, session.rows.size, "60 check-ins, the opening pair and one long report")
        assertEquals("Start of history", assertIs<Kind.User>(session.rows.first().kind).text)
        val links = session.rows.count { (it.kind as? Kind.Assistant)?.markdown?.contains("](https://") == true }
        assertEquals(6, links)
        assertEquals(4, model.projects.size, "The rest of the sample data stays as in default")
    }

    @Test fun openFillsTheRichThread() = runTest {
        val (model, engine) = make()
        val session = model.session(ChatTarget.Thread(release))
        engine.open(session)
        assertTrue(session.isLoaded)
        assertFalse(session.isStale)
        assertTrue(session.machineOnline)
        assertEquals("Release 3.1 checklist", session.title)
        assertEquals("SpecWeave", session.subtitle)
        assertEquals(PlanProgress(3, 5), session.plan)
        assertTrue(session.rows.any { (it.kind as? Kind.Approval)?.resolved == false })
        assertTrue(session.rows.any { (it.kind as? Kind.Assistant)?.let { a -> !a.streaming && a.markdown.length > 1200 && "```bash" in a.markdown } == true })
        assertTrue(session.rows.any { it.kind is Kind.Tool })
        assertTrue(session.rows.any { (it.kind as? Kind.Subagent)?.child != null })
        assertEquals(false, model.thread(release)?.isUnread)
    }

    @Test fun offlineThreadIsStaleAndBlocked() = runTest {
        val (model, engine) = make()
        val session = model.session(ChatTarget.Thread(ThreadRef("env-travel-laptop", "t-links")))
        engine.open(session)
        assertTrue(session.isStale)
        assertFalse(session.machineOnline)
        assertEquals(true, session.sendBlockedReason?.contains("Travel laptop"))
    }

    @Test fun sendEchoesAndStreamsAReply() = runTest {
        val (model, engine) = make()
        val aide = assertNotNull(model.aide)
        val target = ChatTarget.Aide(aide.ref)
        val session = model.session(target)
        engine.open(session)
        val before = session.rows.size
        engine.send("Plan my day", target = target)
        assertEquals(before + 2, session.rows.size)
        assertEquals(Kind.User("Plan my day"), session.rows[before].kind)
        assertTrue(session.isRunning)
        advanceUntilIdle()
        assertFalse(session.isRunning)
        val reply = assertIs<Kind.Assistant>(session.rows.last().kind)
        assertFalse(reply.streaming)
        assertTrue(reply.markdown.isNotEmpty())
    }

    @Test fun sendWhileRunningQueuesAndStopHoldsTheQueue() = runTest {
        val (model, engine) = make()
        engine.streamDelayMs = 5
        val thread = ThreadRef(studio, "t-verify-gate")
        val target = ChatTarget.Thread(thread)
        val session = model.session(target)
        engine.open(session)
        engine.send("First", target = target)
        engine.send("Second", target = target)
        assertEquals(1, session.queuedCount)
        assertEquals(ThreadActivity.Working, model.thread(thread)?.activity)
        engine.stop(target)
        assertFalse(session.isRunning)
        assertEquals(1, session.queuedCount)
        assertEquals(Kind.Notice("Stopped. 1 queued message is on hold."), session.rows.last().kind)
        assertTrue(session.rows.any { it.kind == Kind.User("Second", UserMessageState.Held) })
        assertEquals(ThreadActivity.Idle, model.thread(thread)?.activity)
    }

    @Test fun queuedMessagesShowTheirStateUntilTheyRun() = runTest {
        val (model, engine) = make()
        val target = ChatTarget.Thread(ThreadRef(studio, "t-verify-gate"))
        val session = model.session(target)
        engine.open(session)
        engine.send("First", target = target)
        engine.send("Second", target = target)
        assertTrue(session.rows.any { it.kind == Kind.User("First", UserMessageState.Sent) })
        assertTrue(session.rows.any { it.kind == Kind.User("Second", UserMessageState.Queued) })
        advanceUntilIdle()
        assertTrue(session.rows.any { it.kind == Kind.User("Second", UserMessageState.Sent) })
        assertFalse(session.isRunning)
    }

    @Test fun pairAgainRefusesAnotherMachinesLink() = runTest {
        val (model, engine) = make()
        assertFailsWith<FixtureFailure> { engine.pair("http://192.168.1.77:3773#token=x", "env-travel-laptop") }
        assertEquals(MachineStatus.Offline, model.machine("env-travel-laptop")?.status)
        val again = engine.pair("http://192.168.1.24:3773#token=y", "env-travel-laptop")
        assertEquals("env-travel-laptop", again.id)
        assertEquals(MachineStatus.Connected, again.status)
    }

    @Test fun sendToOfflineMachineFails() = runTest {
        val (model, engine) = make()
        val target = ChatTarget.Project(ProjectRef("env-travel-laptop", "docs-site"))
        engine.open(model.session(target))
        assertFailsWith<FixtureFailure> { engine.send("Hello", target = target) }
    }

    @Test fun stopEndsAWorkingThread() = runTest {
        val (model, engine) = make()
        val target = ChatTarget.Thread(ThreadRef(studio, "t-handoff"))
        val session = model.session(target)
        engine.open(session)
        assertTrue(session.isRunning)
        assertEquals(PlanProgress(2, 5), session.plan)
        engine.stop(target)
        assertFalse(session.isRunning)
        assertFalse(session.rows.any { (it.kind as? Kind.Tool)?.status == ToolStatus.Running })
    }

    @Test fun runningScenarioShowsARunWithAQueue() = runTest {
        val (model, engine) = make(FixtureScenario.Running)
        val aide = assertNotNull(model.aide)
        val session = model.session(ChatTarget.Aide(aide.ref))
        engine.open(session)
        assertTrue(session.isRunning)
        assertEquals(1, session.queuedCount)
        assertEquals(ToolStatus.Running, assertIs<Kind.Tool>(session.rows.last().kind).status)
    }

    @Test fun approvalResolvesAndContinues() = runTest {
        val (model, engine) = make()
        val target = ChatTarget.Thread(release)
        val session = model.session(target)
        engine.open(session)
        engine.respond("req-publish", target, ApprovalDecision.Approve)
        assertTrue(session.rows.any { it.kind == Kind.Approval("req-publish", "npm publish --tag next", resolved = true) })
        assertEquals(PlanProgress(4, 5), session.plan)
        assertEquals(ThreadActivity.Working, model.thread(release)?.activity)
        advanceUntilIdle()
        assertEquals(ThreadActivity.Idle, model.thread(release)?.activity)
        assertFailsWith<FixtureFailure> { engine.respond("req-missing", target, ApprovalDecision.Deny) }
    }

    @Test fun threadActionsUpdateSummaries() = runTest {
        val (model, engine) = make()
        val thread = ThreadRef(studio, "t-dedupe")
        engine.perform(ThreadAction.Pin, thread)
        assertEquals(true, model.thread(thread)?.isPinned)
        assertTrue(model.recentThreads.take(2).any { it.ref == thread })
        engine.perform(ThreadAction.Rename("Deduplicate imports"), thread)
        assertEquals("Deduplicate imports", model.thread(thread)?.title)
        engine.perform(ThreadAction.Resolve, thread)
        assertEquals(true, model.thread(thread)?.isResolved)
        engine.perform(ThreadAction.Unresolve, thread)
        assertEquals(false, model.thread(thread)?.isResolved)
        engine.perform(ThreadAction.MarkUnread, thread)
        assertEquals(true, model.thread(thread)?.isUnread)
        engine.perform(ThreadAction.Delete, thread)
        assertNull(model.thread(thread))
        assertFailsWith<FixtureFailure> { engine.perform(ThreadAction.Pin, thread) }
        assertFailsWith<FixtureFailure> { engine.perform(ThreadAction.Resolve, ThreadRef("env-travel-laptop", "t-links")) }
    }

    @Test fun projectSettingsRoundTripWithRevisions() = runTest {
        val (model, engine) = make()
        val project = ProjectRef(studio, "verified-skill")
        val draft = engine.loadProjectSettings(project)
        assertEquals("Verified Skill", draft.title)
        assertTrue(draft.goal.isNotEmpty())
        val edited = draft.copy(title = "Verified Skills", paused = true)
        engine.saveProjectSettings(edited, project)
        assertEquals("Verified Skills", model.project(project)?.title)
        assertEquals(true, model.project(project)?.paused)
        assertEquals(draft.revision + 1, engine.loadProjectSettings(project).revision)
        assertFailsWith<FixtureFailure> { engine.saveProjectSettings(draft, project) }
        assertFailsWith<FixtureFailure> { engine.loadProjectSettings(ProjectRef("env-travel-laptop", "docs-site")) }
    }

    @Test fun archivingHidesTheProject() = runTest {
        val (model, engine) = make()
        val project = ProjectRef("env-build-box", "recipe-app")
        engine.saveProjectSettings(engine.loadProjectSettings(project).copy(archived = true), project)
        assertFalse(model.otherProjects.any { it.ref == project })
        assertTrue(model.value.archivedProjects.any { it.ref == project })
    }

    @Test fun machineSettingsRoundTrip() = runTest {
        val (_, engine) = make()
        val settings = engine.loadMachineSettings(studio)
        assertEquals(RuntimeModeChoice.AutoAcceptEdits, settings.defaultRuntimeMode)
        engine.saveMachineSettings(settings.copy(defaultRuntimeMode = RuntimeModeChoice.FullAccess), studio)
        assertEquals(RuntimeModeChoice.FullAccess, engine.loadMachineSettings(studio).defaultRuntimeMode)
        assertFailsWith<FixtureFailure> { engine.loadMachineSettings("env-travel-laptop") }
    }

    @Test fun pairingRejectsBadLinksAndAddsMachines() = runTest {
        val (model, engine) = make(FixtureScenario.Empty)
        val error = assertFailsWith<FixtureFailure> { engine.pair("https://bad.example/pair#token=1") }
        assertTrue(error.message!!.contains("pairing link"))
        assertFailsWith<FixtureFailure> { engine.pair("   ") }
        val machine = engine.pair("https://m4-mini.local:3773/pair#token=ABC")
        assertEquals("M4 mini", machine.label)
        assertEquals("https://m4-mini.local:3773", machine.address)
        assertEquals(MachineStatus.Connected, machine.status)
        assertEquals(1, model.machines.size)
        assertEquals(machine.id, engine.pair("https://m4-mini.local:3773/pair#token=DEF").id)
        assertEquals(1, model.machines.size)
    }

    @Test fun setupAideOnFirstOnlineMachine() = runTest {
        val (model, engine) = make(FixtureScenario.Empty)
        assertFailsWith<FixtureFailure> { engine.setupAide() }
        engine.pair("http://192.168.1.9:3773#token=x")
        assertEquals("Machine at 192.168.1.9", model.machines.first().label)
        val ref = engine.setupAide()
        assertEquals(ref, model.aide?.ref)
        assertEquals(ref, engine.setupAide())
        val session = model.session(ChatTarget.Aide(ref))
        engine.open(session)
        assertEquals(1, session.rows.size)
    }

    @Test fun removeAndReconnectMachines() = runTest {
        val (model, engine) = make()
        engine.removeMachine("env-build-box")
        assertEquals(2, model.machines.size)
        assertFalse(model.projects.any { it.ref.environmentId == "env-build-box" })
        assertFalse(model.recentThreads.any { it.ref.environmentId == "env-build-box" })
        engine.reconnect(studio)
        assertEquals(MachineStatus.Reconnecting, model.machine(studio)?.status)
        advanceUntilIdle()
        assertEquals(MachineStatus.Connected, model.machine(studio)?.status)
        engine.reconnect("env-travel-laptop")
        advanceUntilIdle()
        assertEquals(MachineStatus.Offline, model.machine("env-travel-laptop")?.status)
    }

    @Test fun sessionsAreSharedAndViewersCounted() = runTest {
        val (model, _) = make()
        val target = ChatTarget.Thread(release)
        val first = model.session(target)
        assertTrue(first === model.session(target))
        model.openSession(first)
        model.openSession(first, startingCoordinator = false)
        assertTrue(first.startsCoordinator, "A second, unasked viewer keeps the first viewer's choice")
        model.closeSession(first)
        model.closeSession(first)
        assertEquals("Release 3.1 checklist", first.title)
    }

    @Test fun startThreadAddsAWorkingThreadWithItsMessage() = runTest {
        val (model, engine) = make()
        val choices = assertNotNull(model.value.modelChoices[studio])
        assertTrue(choices.isNotEmpty())
        val ref = engine.startThread(NewThreadRequest(FixtureSample.specweave, "  Add a dark theme\nwith tokens ", choices.first(), RuntimeModeChoice.Auto))
        val thread = assertNotNull(model.thread(ref))
        assertEquals("Add a dark theme", thread.title)
        assertEquals(ThreadActivity.Working, thread.activity)
        assertTrue(model.threads(FixtureSample.specweave).any { it.ref == ref })
        val session = model.session(ChatTarget.Thread(ref))
        engine.open(session)
        assertEquals("Add a dark theme\nwith tokens", assertIs<Kind.User>(session.rows.first().kind).text)
        advanceUntilIdle()
        assertIs<Kind.Assistant>(session.rows.last().kind)
        assertFalse(session.isRunning)
        assertFailsWith<SyncError.EmptyMessage> { engine.startThread(NewThreadRequest(FixtureSample.specweave, "   ")) }
        assertFailsWith<FixtureFailure> { engine.startThread(NewThreadRequest(FixtureSample.docs, "Hi")) }
    }
}

class ContractTest {
    @Test fun machineNamesDropTheOwner() {
        assertEquals("MacBook M4MAX", MachineNickname.shortName("Sam's MacBook M4MAX"))
        assertEquals("MacBook", MachineNickname.shortName("  Ann’s MacBook "))
        assertEquals("Office Mac", MachineNickname.shortName("Office Mac"))
        assertEquals("M4", MachineSummary(id = "e", label = "Sam's M4", status = MachineStatus.Connected).displayName)
    }

    @Test fun placementLabelShowsWhereItRuns() {
        assertEquals("M4", ThreadPlacement("M4").label)
        assertEquals("M4 → Minis", ThreadPlacement("M4", runsOn = "Minis").label)
    }

    @Test fun identityNamesKnownProvidersAndModels() {
        val identity = ThreadIdentity.from(com.specwithcode.wire.ModelSelection("claudeAgent", "claude-opus-5-5"), emptyList())
        assertEquals("Claude Code", identity.provider)
        assertEquals("Opus 5.5", identity.model)
        assertEquals("claude", identity.providerBrand)
        assertEquals("Claude", identity.agentName)
        assertNull(ThreadIdentity.Unknown.agentName)
        assertEquals("copilot", ThreadIdentity.registryBrand("https://cdn.agentclientprotocol.com/registry/v1/latest/github-copilot.svg"))
        assertNull(ThreadIdentity.registryBrand("http://cdn.agentclientprotocol.com/registry/v1/latest/claude.svg"))
        assertEquals("GPT-6", ThreadIdentity.modelName("gpt-6"))
        assertEquals("my-model", ThreadIdentity.modelName("my-model"))
    }

    @Test fun streamingChunksKeepTheText() {
        val text = "Got it. I'll fold that into the current work.\n\nNext I'll run the checks."
        assertEquals(text, FixtureEngine.chunks(text).joinToString(""))
        assertEquals("Machine at 10.0.0.2", FixtureEngine.labelForHost("10.0.0.2"))
        assertEquals("New machine", FixtureEngine.labelForHost(null))
    }

    @Test fun errorsReadAsSentences() {
        assertEquals("Travel laptop is offline. Try again when it reconnects.", SyncError.MachineOffline("Travel laptop").message)
        assertEquals("That computer is offline. Try again when it reconnects.", SyncError.MachineOffline("").message)
        assertEquals(SyncError.UnreadableAnswer, SyncError.wrap(kotlinx.serialization.SerializationException("bad")))
        assertEquals("ok", ChatSession.threadSubtitle("ok", "M4", isPersonal = false))
        assertEquals("Percy · M4", ChatSession.threadSubtitle("Percy", "M4", isPersonal = true))
    }

}
