package com.specwithcode.wire

import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class FixtureDecodeTest {
    @Test fun projectShell() {
        val project = Fixture.decode<ProjectShell>("projectShell.json")
        assertEquals("proj_1", project.id)
        assertEquals(WorkspaceKind.Code, project.kind)
        assertEquals(3, project.workspaceSettings?.revision)
        assertEquals("project-coordinator:proj_1", project.coordinatorThreadId)
        assertNull(project.defaultModelSelection)
        assertEquals(WireDates.parse("2026-10-01T00:00:00.000Z"), project.createdDate)
    }

    @Test fun serverSettingsDefault() {
        val settings = Fixture.decode<ServerSettings>("serverSettings.default.json")
        assertEquals(RuntimeMode.ApprovalRequired, settings.defaultRuntimeMode)
        assertNull(settings.defaultModelSelection)
        assertEquals("codex", settings.textGenerationModelSelection?.instanceId)
        assertEquals(ModelOption.Value.Text("low"), settings.textGenerationModelSelection?.option("reasoningEffort"))
        assertEquals(SidebarProjectOrder(pinned = emptyList(), unpinned = emptyList()), settings.sidebarProjectOrder)
        assertTrue(settings.providerInstances.isEmpty())
    }

    @Test fun aideEnabledDecodesAndDefaultsToOff() {
        assertFalse(Fixture.decode<ServerSettings>("serverSettings.default.json").aideEnabled)
        assertTrue(decodeJSON<ServerSettings>("""{"aideEnabled":true}""").aideEnabled)
        assertFalse(decodeJSON<ServerSettings>("""{"aideEnabled":false}""").aideEnabled)
        // A malformed value hides Percy rather than failing the whole snapshot.
        assertFalse(decodeJSON<ServerSettings>("""{"aideEnabled":"yes"}""").aideEnabled)
    }

    @Test fun shellStreamSnapshot() {
        val item = Fixture.decode<ShellStreamItem>("shellStreamItem.snapshot.json")
        val snapshot = assertIs<ShellStreamItem.Snapshot>(item)
        assertNull(snapshot.resolvedRepositoryIdentityRoots)
        assertEquals(42, item.sequence)
        assertEquals(1, snapshot.snapshot.threads.size)
        assertEquals("SpecWeave", snapshot.snapshot.projects.first().title)
        val thread = snapshot.snapshot.threads.first()
        assertEquals(ThreadStatus.Idle, thread.status)
        assertFalse(thread.isWorking)
        assertNull(thread.lastVisitedAt)
        assertFalse(thread.isUnread)
    }

    @Test fun threadShellMin() {
        val thread = Fixture.decode<ThreadShell>("threadShell.min.json")
        assertEquals("thr_1", thread.id)
        assertEquals(ActorKind.User, thread.createdBy)
        assertEquals(CreationSource.Mobile, thread.creationSource)
        assertEquals(RuntimeMode.FullAccess, thread.runtimeMode)
        assertEquals(InteractionMode.Default, thread.interactionMode)
        assertEquals("thr_1", thread.lineage.rootThreadId)
        assertTrue(thread.pendingBackgroundTasks.isEmpty())
        assertEquals(WireDates.parse("2026-10-18T04:00:01.500Z"), thread.updatedAt)
        assertEquals("2026-10-18T04:00:01.500Z", WireDates.format(thread.updatedAt))
        assertTrue(!thread.isPinned && !thread.isSettled && !thread.isArchived)
    }

    @Test fun threadProjection() {
        val projection = Fixture.decode<ThreadProjection>("threadProjection.json")
        assertEquals("thr_1", projection.thread.id)
        assertNull(projection.thread.lastVisitedAt)
        assertEquals(1, projection.runs.size)
        assertEquals("run_1", projection.activeRun?.id)
        assertEquals(RunStatus.Running, projection.latestRun?.status)
        assertEquals(MessageRole.User, projection.messages.first().role)
        val todo = assertIs<PlanArtifact.Content.TodoList>(projection.plans.first().content)
        assertEquals(PlanStepStatus.Running, todo.steps.first().status)
        assertEquals(1, projection.turnItems.size)
        val row = projection.visibleTurnItems.first()
        assertEquals(TurnItemVisibility.Local, row.visibility)
        val command = assertIs<TurnItem.Content.CommandExecutionContent>(row.item.content).value
        assertEquals("ls", command.input)
        assertEquals("a\nb", command.output)
        assertEquals(0, command.exitCode)
    }

    @Test fun threadStreamSnapshot() {
        val item = Fixture.decode<ThreadStreamItem>("threadStreamItem.snapshot.json")
        val snapshot = assertIs<ThreadStreamItem.Snapshot>(item)
        assertEquals(99, item.sequence)
        assertEquals("thr_1", snapshot.snapshot.projection.thread.id)
    }

    @Test fun turnItems() {
        val raw = assertNotNull(Fixture.json("turnItems.json").arrayValue)
        val items = Fixture.decodeList(TurnItem.serializer(), "turnItems.json")
        assertEquals(raw.size, items.size)
        val typed = items.filter { !it.isUnknown }
        assertEquals(TurnItem.knownTypes, typed.map { it.type }.toSet())
        assertEquals(listOf("checkpoint", "run_interrupt_request"), items.filter { it.isUnknown }.map { it.type })

        for ((item, json) in items.zip(raw)) {
            assertEquals(json["id"].stringValue, item.id)
            assertEquals(json["type"].stringValue, item.type)
            // Typed items keep every member the server sent; unknown ones re-encode verbatim.
            val encoded = encodeToJSON(item)
            if (item.isUnknown) {
                assertEquals(json, encoded)
            } else {
                assertEquals(stripNulls(json), stripNulls(encoded), "Round trip of ${item.type}")
            }
        }
    }

    @Test fun turnItemPayloads() {
        val items = Fixture.decodeList(TurnItem.serializer(), "turnItems.json").associateBy { it.type }

        val user = assertIs<TurnItem.Content.UserMessageContent>(items["user_message"]?.content).value
        assertEquals(UserMessageInputIntent.TurnStart, user.inputIntent)
        assertEquals(CreationSource.Mobile, user.creationSource)
        assertEquals("Fix the login bug", user.text)

        val assistant = assertIs<TurnItem.Content.AssistantMessageContent>(items["assistant_message"]?.content).value
        assertTrue(assistant.streaming)
        assertNull(items["assistant_message"]?.completedAt)
        assertEquals(true, items["assistant_message"]?.isInFlight)

        val todo = assertIs<TurnItem.Content.TodoListContent>(items["todo_list"]?.content).value
        assertEquals(listOf(PlanStepStatus.Completed, PlanStepStatus.Running, PlanStepStatus.Pending), todo.steps.map { it.status })
        assertEquals(1200, todo.steps.first().durationMs)
        assertEquals("2026-10-18T06:00:04Z", todo.steps[1].durationAnchorAt)
        assertEquals(1, todo.completedCount)

        val command = assertIs<TurnItem.Content.CommandExecutionContent>(items["command_execution"]?.content).value
        assertEquals(true, command.outputOmitted)
        assertEquals(1, command.exitCode)
        assertEquals(TurnItemStatus.Failed, items["command_execution"]?.status)

        val file = assertIs<TurnItem.Content.FileChangeContent>(items["file_change"]?.content).value
        assertTrue(file.additions == 12 && file.deletions == 3)
        assertEquals("update", file.changes?.first()?.operation)

        val approval = assertIs<TurnItem.Content.ApprovalRequestContent>(items["approval_request"]?.content).value
        assertEquals(RuntimeRequestKind.Command, approval.requestKind)
        assertEquals(
            listOf(ProviderApprovalDecision.Accept, ProviderApprovalDecision.AcceptForSession, ProviderApprovalDecision.Decline),
            approval.options?.map { it.decision },
        )
        assertNull(approval.grantRoot)

        val input = assertIs<TurnItem.Content.UserInputRequestContent>(items["user_input_request"]?.content).value
        val question = input.questions.first()
        assertEquals(true, question.options.first().recommended)
        assertEquals("Postgres", question.options.first().answerValue)
        assertFalse(input.isAnswered)

        val tool = assertIs<TurnItem.Content.DynamicToolContent>(items["dynamic_tool"]?.content).value
        assertEquals("studio_thread_launch", tool.toolName)
        assertEquals("Run tests", tool.input["prompt"].stringValue)
        assertEquals("browser", items["dynamic_tool"]?.toolSource?.kind)
        assertEquals("browser", items["dynamic_tool"]?.toolSurface)

        val subagent = assertIs<TurnItem.Content.SubagentContent>(items["subagent"]?.content).value
        assertEquals("thr_child", subagent.childThreadId)
        assertNull(subagent.result)

        val error = assertIs<TurnItem.Content.ErrorContent>(items["error"]?.content).value
        assertEquals(ProviderFailureClass.UsageLimit, error.failure.failureClass)
        assertEquals("2026-10-18T09:00:00Z", error.failure.resetAt)
        assertEquals(true, error.failure.retryable)

        val note = assertIs<TurnItem.Content.NotificationContent>(items["notification"]?.content).value
        assertTrue(note.source.isSubagent)
        assertEquals("subagent", note.source.normalizedKind)
        assertEquals("thr_child", note.source.childThreadId)
        assertEquals(NotificationOutcome.Completed, note.outcome)
    }

    @Test fun threadEvents() {
        val raw = assertNotNull(Fixture.json("threadEvents.json").arrayValue)
        val items = Fixture.decodeList(ThreadStreamItem.serializer(), "threadEvents.json")
        assertEquals(raw.size, items.size)

        val types = mutableListOf<String>()
        for (item in items) {
            val event = (item as? ThreadStreamItem.Event)?.event ?: continue
            types += event.type
            val payload = event.payload
            when {
                event.type == "thread.pinned" && payload is DomainEvent.Payload.Thread -> {
                    assertTrue(payload.thread.isPinned)
                    assertEquals("a0", payload.thread.pinOrderKey)
                }
                event.type == "thread.metadata-updated" && payload is DomainEvent.Payload.Thread ->
                    assertEquals("Fix login flow", payload.thread.title)
                event.type == "run.created" && payload is DomainEvent.Payload.RunPayload -> {
                    assertEquals(RunStatus.Queued, payload.run.status)
                    assertEquals(1, payload.run.queuePosition)
                    assertEquals(ModelOption.Value.Flag(true), payload.run.modelSelection.option("fastMode"))
                }
                event.type == "run.updated" && payload is DomainEvent.Payload.RunPayload -> {
                    assertEquals(RunStatus.Running, payload.run.status)
                    assertEquals("claudeAgent", event.driver)
                }
                event.type == "message.updated" && payload is DomainEvent.Payload.Message -> {
                    assertEquals("thr_coord", payload.message.senderThreadId)
                    assertEquals(true, payload.message.attachments.firstOrNull()?.isImage)
                }
                event.type == "turn-item.updated" && payload is DomainEvent.Payload.TurnItemPayload ->
                    assertEquals("assistant_message", payload.item.type)
                event.type == "plan.updated" && payload is DomainEvent.Payload.Plan ->
                    assertEquals("proposed_plan", payload.plan.kind)
                event.type == "runtime-request.updated" && payload is DomainEvent.Payload.RuntimeRequestPayload -> {
                    val request = payload.request
                    if (request.id == "req_1") {
                        assertEquals(ResponseCapability.Live("ps_1"), request.responseCapability)
                        assertTrue(request.isPending)
                    } else {
                        assertEquals(ResponseCapability.NotResumable("Session ended"), request.responseCapability)
                        assertEquals("Postgres", request.answers?.get("q1").stringValue)
                    }
                }
                event.type == "run-attempt.created" && payload is DomainEvent.Payload.Unknown ->
                    assertEquals(1, payload.raw["attemptOrdinal"].intValue)
                else -> error("Unexpected payload for ${event.type}")
            }
        }
        assertEquals(10, types.size)
        assertEquals(ThreadStreamItem.Synchronized, items.last())
        assertEquals((200..209).toList(), items.mapNotNull { it.sequence })
    }

    @Test fun shellItems() {
        val items = Fixture.decodeList(ShellStreamItem.serializer(), "shellItems.json")
        assertEquals(
            listOf("thread.updated", "thread.removed", "project.removed", "project.updated", "project.updated", "project.updated"),
            items.map { it.kind },
        )
        assertEquals(listOf(50, 51, 52, 53, 54, 55), items.mapNotNull { it.sequence })

        val updated = assertIs<ShellStreamItem.ThreadUpdated>(items[0])
        val thread = updated.thread
        assertEquals(ThreadLocation.Active, updated.location)
        assertEquals(ThreadStatus.Running, thread.status)
        assertTrue(thread.isWorking)
        assertEquals(RunStatus.Running, thread.activityRunStatus)
        assertEquals("npm test", thread.activeWork?.label)
        assertEquals(RuntimeRequestKind.Command, thread.pendingRuntimeRequest?.kind)
        assertEquals(MessageRole.Assistant, thread.latestVisibleMessage?.role)
        assertEquals(ThreadPlanProgress(completed = 1, total = 3, current = "Write fix", next = "Test"), thread.planProgress)
        assertEquals(listOf(BackgroundTaskKind.Command, BackgroundTaskKind.Subagent), thread.pendingBackgroundTasks.map { it.kind })
        assertEquals("thr_child", thread.pendingBackgroundTasks.last().childThreadId)
        assertEquals(listOf("codex", "claudeAgent"), thread.providerInstanceHistory)
        assertEquals("Ship login fix", thread.goal?.objective)
        assertEquals(2, thread.heldQueuedCount)
        assertEquals("cmd_t", thread.titleRegeneration?.requestId)
        assertTrue(thread.isPinned)
        // latestRunCompletedAt (06:04) is before lastVisitedAt (06:05).
        assertFalse(thread.isUnread)

        val removed = assertIs<ShellStreamItem.ThreadRemoved>(items[1])
        assertEquals(ThreadLocation.Archive, removed.location)
        assertEquals("thr_old", removed.threadId)

        val aide = assertIs<ShellStreamItem.ProjectUpdated>(items[3]).project
        assertTrue(aide.isPersonal)
        assertEquals(ProjectIconOverride.PersonalAssistant, aide.projectIcon)
        assertEquals("project-coordinator:proj_aide", aide.coordinatorThreadId)
        assertEquals(true, aide.workspaceSettings?.autoResume)
        assertEquals("m1", aide.workspaceSettings?.workerMachine?.machineId)
        assertEquals("web", aide.workspaceSettings?.environment?.repositories?.first()?.id)
        assertEquals("acme/web", aide.repositoryIdentity?.displayName)
        assertEquals("npm run dev", aide.scripts.first().command)

        val mono = assertIs<ShellStreamItem.ProjectUpdated>(items[4]).project
        val emoji = assertIs<ShellStreamItem.ProjectUpdated>(items[5]).project
        assertEquals(ProjectIconOverride.Monogram("MO", "teal"), mono.projectIcon)
        assertEquals(ProjectIconOverride.Emoji("🚀"), emoji.projectIcon)
    }

    /** Inbound models re-encode to JSON that decodes to the same value, so they can be cached. */
    @Test fun cacheRoundTrip() {
        fun <T> check(serializer: kotlinx.serialization.KSerializer<T>, name: String) {
            val value = Fixture.decode(serializer, name)
            val again = WireJson.decodeFromString(serializer, WireJson.encodeToString(serializer, value))
            assertEquals(value, again, name)
        }
        check(ShellStreamItem.serializer(), "shellStreamItem.snapshot.json")
        check(ListSerializer(ShellStreamItem.serializer()), "shellItems.json")
        check(ThreadProjection.serializer(), "threadProjection.json")
        check(ListSerializer(ThreadStreamItem.serializer()), "threadEvents.json")
        check(ThreadStreamItem.serializer(), "threadStreamItem.snapshot.json")
        check(ListSerializer(TurnItem.serializer()), "turnItems.json")
        check(ServerSettings.serializer(), "serverSettings.default.json")
        check(ProjectShell.serializer(), "projectShell.json")
    }

    @Test fun rpcPayloadResults() {
        val payloads = assertNotNull(Fixture.json("rpcPayloads.json").objectValue)
        fun value(key: String) = assertNotNull(payloads[key], key)

        assertEquals(CoordinatorResult(threadId = "project-coordinator:proj_1", created = true), value("coordinatorResult").decode<CoordinatorResult>())

        val read = value("workspaceReadResult").decode<WorkspaceReadResult>()
        assertEquals("Ship v2", read.settings.goal)
        assertNull(read.settings.coordinatorThreadId)
        assertEquals(ModelSelection(instanceId = "codex", model = "gpt-6"), read.settings.coordinatorModelSelection)
        assertEquals("MEMORY.md", read.memory.files.first().name)
        assertEquals(10, read.memory.totalBytes)

        val project = value("project").decode<ProjectShell>()
        assertEquals("SpecWeave 2", project.title)
        assertNull(project.deletedAt)
        assertNull(project.workspaceSettings)
        assertEquals(WorkspaceKind.Code, project.kind)
        assertEquals("project-coordinator:proj_1", project.coordinatorThreadId)

        val created = value("createNewResult").decode<CreateNewProjectResult>()
        assertEquals(true, created.existing)
        assertNull(created.commitError)

        assertEquals(DispatchResult(sequence = 7), value("dispatchResult").decode<DispatchResult>())
        assertEquals(JsonPrimitive(7), value("dispatchResult")["sequence"])
    }
}
