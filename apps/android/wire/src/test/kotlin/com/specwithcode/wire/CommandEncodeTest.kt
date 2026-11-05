package com.specwithcode.wire

import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * Each command and input is built from Kotlin values and must encode to exactly the JSON the
 * server's codec produced: same keys, no nulls for omitted keys.
 */
class CommandEncodeTest {
    private val model = ModelSelection(instanceId = "claudeAgent", model = "claude-opus-5-5")

    /** The commands of `commands.json`, in file order. */
    private val commands: List<OrchestrationCommand> = listOf(
        OrchestrationCommand.MessageDispatch(MessageDispatchCommand("c1", "thr_1", "m1", "hello", DispatchMode.StartImmediately)),
        OrchestrationCommand.MessageDispatch(
            MessageDispatchCommand("c1b", "thr_1", "m1b", "hello", DispatchMode.StartImmediately, deliveryIntent = DeliveryIntent.Auto),
        ),
        OrchestrationCommand.MessageDispatch(MessageDispatchCommand("c1c", "thr_1", "m1c", "later", DispatchMode.QueueAfterActive)),
        OrchestrationCommand.RunInterrupt(RunInterruptCommand("c2", "thr_1", "run_1")),
        OrchestrationCommand.ThreadMetadataUpdate(ThreadMetadataUpdateCommand("c3", "thr_1", title = "New title")),
        OrchestrationCommand.ThreadPin("c4", "thr_1"),
        OrchestrationCommand.ThreadUnpin("c5", "thr_1"),
        OrchestrationCommand.ThreadSettle("c6", "thr_1", note = "Merged in #12"),
        OrchestrationCommand.ThreadUnsettle("c7", "thr_1"),
        OrchestrationCommand.ThreadArchive("c8", "thr_1"),
        OrchestrationCommand.ThreadUnarchive("c9", "thr_1"),
        OrchestrationCommand.ThreadDelete("c10", "thr_1"),
        OrchestrationCommand.ThreadVisit("c11", "thr_1", "2026-10-18T06:00:05.000Z"),
        OrchestrationCommand.ThreadMarkUnread("c12", "thr_1"),
        OrchestrationCommand.ThreadSettle("c13", "thr_1", settledAt = WireDates.parse("2026-10-18T06:00:05.000Z")),
    )

    @Test fun commandsFixture() {
        val expected = assertNotNull(Fixture.json("commands.json").arrayValue)
        assertEquals(commands.size, expected.size)
        for ((command, json) in commands.zip(expected)) {
            assertEquals(json, encodeToJSON(command), "${command.type} ${command.commandId}")
            assertEquals(json["type"].stringValue, command.type)
            assertEquals(json["commandId"].stringValue, command.commandId)
            assertEquals(json["threadId"].stringValue, command.threadId)
            // Decoding the server's JSON gives the same value back.
            assertEquals(command, json.decode<OrchestrationCommand>())
        }
    }

    @Test fun visitWithDate() {
        val date = assertNotNull(WireDates.parse("2026-10-18T06:00:05.000Z"))
        assertEquals(
            OrchestrationCommand.ThreadVisit("c11", "thr_1", "2026-10-18T06:00:05.000Z"),
            OrchestrationCommand.visit("c11", "thr_1", date),
        )
    }

    /** Values for the `rpcPayloads.json` inputs, keyed like the fixture. */
    private fun payloads(): List<Pair<String, JsonElement>> = listOf(
        "command.steer" to encodeToJSON<OrchestrationCommand>(
            OrchestrationCommand.MessageDispatch(
                MessageDispatchCommand("c30", "thr_1", "m30", "Also check logout", DispatchMode.SteerActive("run_2")),
            ),
        ),
        "command.respondApproval" to encodeToJSON<OrchestrationCommand>(
            OrchestrationCommand.RuntimeRequestRespond(
                RuntimeRequestRespondCommand("c31", "thr_1", "req_1", decision = ProviderApprovalDecision.AcceptForSession),
            ),
        ),
        "command.respondAnswers" to encodeToJSON<OrchestrationCommand>(
            OrchestrationCommand.RuntimeRequestRespond(
                RuntimeRequestRespondCommand(
                    "c32", "thr_1", "req_2",
                    answers = mapOf("q1" to UserInputAnswer.Text("Postgres"), "q2" to UserInputAnswer.Choices(listOf("a", "b"))),
                ),
            ),
        ),
        "command.renameRegenerate" to encodeToJSON<OrchestrationCommand>(
            OrchestrationCommand.ThreadMetadataUpdate(ThreadMetadataUpdateCommand("c33", "thr_1", regenerateTitle = true)),
        ),
        "command.pinOrdered" to encodeToJSON<OrchestrationCommand>(OrchestrationCommand.ThreadPin("c34", "thr_1", orderKey = "a1")),
        "command.interruptReason" to encodeToJSON<OrchestrationCommand>(
            OrchestrationCommand.RunInterrupt(RunInterruptCommand("c35", "thr_1", "run_2", reason = "Stopped from phone")),
        ),
        "launchThread.root" to encodeToJSON(
            ThreadLaunchInput(
                commandId = "c40", projectId = "proj_1", title = "Investigate flaky test", modelSelection = model,
                runtimeMode = RuntimeMode.Auto,
                initialMessage = InitialMessage(messageId = "m40", text = "Why does the auth test flake?"), generateTitle = true,
            ),
        ),
        "launchThread.worktree" to encodeToJSON(
            ThreadLaunchInput(
                commandId = "c41", projectId = "proj_1", title = "New branch", modelSelection = model,
                runtimeMode = RuntimeMode.ApprovalRequired, interactionMode = InteractionMode.Plan,
                workspaceStrategy = WorkspaceStrategy.Worktree(baseRef = "main", branch = "feat/x", startFromOrigin = true),
                threadId = "thr_new", creationSource = null,
            ),
        ),
        "coordinatorSend" to encodeToJSON(CoordinatorSendInput(projectId = "proj_1", commandId = "c50", prompt = "Plan the release")),
        "coordinatorStart" to encodeToJSON(CoordinatorStartInput(projectId = "proj_1", commandId = "c51")),
        "workspaceRead" to encodeToJSON(WorkspaceReadInput(projectId = "proj_1")),
        "projectUpdate.rename" to encodeToJSON(ProjectUpdateCommand(commandId = "c60", projectId = "proj_1", title = "SpecWeave 2")),
        "projectUpdate.workspace" to encodeToJSON(
            ProjectUpdateCommand(
                commandId = "c61", projectId = "proj_1",
                workspaceSettings = WorkspacePatch(
                    expectedRevision = 3, goal = "Ship", instructions = "Small PRs",
                    coordinatorModelSelection = Nullable.Null, paused = true, archived = false,
                ),
            ),
        ),
        "projectUpdate.icon" to encodeToJSON(
            ProjectUpdateCommand(commandId = "c62", projectId = "proj_1", projectIcon = Nullable.Value(ProjectIconOverride.Emoji("🧪"))),
        ),
        "projectUpdate.clearIcon" to encodeToJSON(ProjectUpdateCommand(commandId = "c63", projectId = "proj_1", projectIcon = Nullable.Null)),
        "createNew" to encodeToJSON(CreateNewProjectInput(name = "Aide", kind = WorkspaceKind.Personal)),
        "updateSettings.mode" to encodeToJSON(
            UpdateServerSettingsInput(ServerSettingsPatch(defaultRuntimeMode = RuntimeMode.Auto, defaultModelSelection = Nullable.Value(model))),
        ),
        "updateSettings.clearModel" to encodeToJSON(UpdateServerSettingsInput(ServerSettingsPatch(defaultModelSelection = Nullable.Null))),
        "subscribeShell.resume" to encodeToJSON(SubscribeShellInput(afterSequence = 42, requestCompletionMarker = true)),
        "subscribeThread" to encodeToJSON(SubscribeThreadInput(threadId = "thr_1", requestCompletionMarker = true, acceptBoundedSnapshot = true)),
        "dispatchResult" to encodeToJSON(DispatchResult(sequence = 7)),
        "accessAnswer.allowThread" to encodeToJSON(
            AccessAnswerRequestInput("thr_1", "ti_access", AccessRequestAnswer.Allow(AccessRequestScope.Thread)),
        ),
        "accessAnswer.allowMachine" to encodeToJSON(
            AccessAnswerRequestInput("thr_1", "ti_access", AccessRequestAnswer.Allow(AccessRequestScope.Machine)),
        ),
        "accessAnswer.deny" to encodeToJSON(AccessAnswerRequestInput("thr_1", "ti_access", AccessRequestAnswer.Deny)),
    )

    @Test fun rpcPayloadsFixture() {
        val expected = assertNotNull(Fixture.json("rpcPayloads.json").objectValue)
        val built = payloads()
        for ((key, encoded) in built) {
            val json = assertNotNull(expected[key], "Fixture has no $key")
            assertEquals(json, encoded, key)
        }
        // Every input in the fixture has a counterpart; the rest are results.
        val results = setOf("coordinatorResult", "workspaceReadResult", "project", "createNewResult")
        assertEquals(expected.keys, built.map { it.first }.toSet() + results)
    }

    @Test fun payloadsDecodeBack() {
        val expected = assertNotNull(Fixture.json("rpcPayloads.json").objectValue)
        fun <T> round(serializer: KSerializer<T>, key: String) {
            val json = assertNotNull(expected[key])
            val value = WireJson.decodeFromJsonElement(serializer, json)
            assertEquals(json, WireJson.encodeToJsonElement(serializer, value), key)
        }
        round(OrchestrationCommand.serializer(), "command.steer")
        round(OrchestrationCommand.serializer(), "command.respondAnswers")
        round(ThreadLaunchInput.serializer(), "launchThread.root")
        round(ThreadLaunchInput.serializer(), "launchThread.worktree")
        round(ProjectUpdateCommand.serializer(), "projectUpdate.workspace")
        round(ProjectUpdateCommand.serializer(), "projectUpdate.clearIcon")
        round(UpdateServerSettingsInput.serializer(), "updateSettings.clearModel")
        round(SubscribeThreadInput.serializer(), "subscribeThread")
        round(AccessAnswerRequestInput.serializer(), "accessAnswer.allowMachine")
        round(AccessAnswerRequestInput.serializer(), "accessAnswer.deny")
    }

    @Test fun requestFrames() {
        val frame = RpcClientMessage.request(7, RpcMethod.SubscribeShell, SubscribeShellInput(requestCompletionMarker = true))
        val expected = obj(
            "_tag" to JsonPrimitive("Request"), "id" to JsonPrimitive(7), "tag" to JsonPrimitive("orchestration.subscribeShell"),
            "payload" to obj("requestCompletionMarker" to JsonPrimitive(true)), "headers" to JsonArray(emptyList()),
        )
        assertEquals(expected, encodeToJSON(frame))
        // Without the server flag the marker is left out.
        assertEquals(JsonObject(emptyMap()), encodeToJSON(RpcClientMessage.request(8, RpcMethod.SubscribeShell, SubscribeShellInput()))["payload"])

        val empty = RpcClientMessage.request(1, RpcMethod.ServerProbe)
        assertEquals(JsonObject(emptyMap()), encodeToJSON(empty)["payload"])
        assertEquals(JsonObject(emptyMap()), encodeToJSON(EmptyInput()))

        val dispatch = RpcClientMessage.request(3, RpcMethod.DispatchCommand, commands[0])
        assertEquals(JsonPrimitive("start_immediately"), encodeToJSON(dispatch)["payload"]["dispatchMode"]["type"])
    }

    @Test fun methodNames() {
        assertEquals(22, RpcMethod.entries.size)
        assertTrue(RpcMethod.SubscribeDeviceState.tag == "subscribeDeviceState" && RpcMethod.SubscribeDeviceState.isStream)
        assertEquals("orchestration.subscribeShell", RpcMethod.SubscribeShell.tag)
        assertEquals("projects.mutate", RpcMethod.ProjectsMutate.tag)
        assertEquals("projects.createNew", RpcMethod.CreateNewProject.tag)
        assertTrue(RpcMethod.SubscribeThread.isStream && !RpcMethod.DispatchCommand.isStream)
    }

    @Test fun dispatchModes() {
        val modes = listOf(
            DispatchMode.StartImmediately to """{"type":"start_immediately"}""",
            DispatchMode.QueueAfterActive to """{"type":"queue_after_active"}""",
            DispatchMode.SteerActive("r") to """{"targetRunId":"r","type":"steer_active"}""",
            DispatchMode.RestartActive("r") to """{"targetRunId":"r","type":"restart_active"}""",
            DispatchMode.DeferStart() to """{"type":"defer_start"}""",
        )
        for ((mode, json) in modes) {
            assertEquals(parse(json), encodeToJSON<DispatchMode>(mode))
            assertEquals(mode, decodeJSON<DispatchMode>(json))
        }
    }

    @Test fun patchesOmitNullKeys() {
        assertEquals(JsonObject(emptyMap()), encodeToJSON(ServerSettingsPatch()))
        assertTrue(ServerSettingsPatch().isEmpty)
        assertEquals(obj("expectedRevision" to JsonPrimitive(1)), encodeToJSON(WorkspacePatch(expectedRevision = 1)))
        assertEquals(
            parse("""{"type":"thread.metadata.update","commandId":"c","threadId":"t","branch":null}"""),
            encodeToJSON(ThreadMetadataUpdateCommand("c", "t", branch = Nullable.Null)),
        )
        assertFalse(ServerSettingsPatch(defaultModelSelection = Nullable.Null).isEmpty)
    }
}
