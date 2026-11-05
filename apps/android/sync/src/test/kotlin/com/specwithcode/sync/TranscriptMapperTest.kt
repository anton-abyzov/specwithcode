package com.specwithcode.sync

import com.specwithcode.wire.DomainEvent
import com.specwithcode.wire.FileChangeDetail
import com.specwithcode.wire.RunStatus
import com.specwithcode.wire.RuntimeRequest
import com.specwithcode.wire.RuntimeRequestStatus
import com.specwithcode.wire.ThreadStreamItem
import com.specwithcode.wire.TurnItem
import com.specwithcode.wire.TurnItemStatus
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class TranscriptMapperTest {
    private fun kind(id: String, requests: Map<String, RuntimeRequest> = emptyMap()): TranscriptRow.Kind? =
        TranscriptMapper.kind(TestData.turnItem(id), requests, "env")

    private fun map(item: TurnItem) = TranscriptMapper.kind(item, environmentId = "env")

    @Test fun queuedMessagesFollowTheTimelineInQueueOrder() {
        var projection = (TestData.threadSnapshot() as ThreadStreamItem.Snapshot).snapshot.projection
        val base = projection.runs[0]
        val message = projection.messages[0]
        fun queue(n: Int, position: Int, held: Boolean = false, text: String) {
            val run = base.copy(id = "run_$n", ordinal = n, status = RunStatus.Queued, userMessageId = "msg_$n", queuePosition = position, queueHeld = held, startedAt = null)
            projection = projection.copy(
                runs = projection.runs + run,
                messages = projection.messages + message.copy(id = "msg_$n", runId = run.id, text = text),
            )
        }
        queue(2, position = 2, text = "Then deploy")
        queue(3, position = 1, held = true, text = "Run the tests first")

        val rows = TranscriptMapper.rows(projection, "env")
        assertEquals(3, rows.size)
        assertEquals(TranscriptRow("queued:run_3", TranscriptRow.Kind.User("Run the tests first", UserMessageState.Held)), rows[1])
        assertEquals(TranscriptRow("queued:run_2", TranscriptRow.Kind.User("Then deploy", UserMessageState.Queued)), rows[2])
        // A sent message is matched while it waits, before it has a turn item.
        assertEquals(setOf("msg_1", "msg_2", "msg_3"), TranscriptMapper.receivedUserMessages(projection).map { it.messageId }.toSet())
        assertEquals(2, TranscriptMapper.queuedCount(projection))
    }

    @Test fun messagesAndReasoning() {
        assertEquals(TranscriptRow.Kind.User("Fix the login bug"), kind("ti_user"))
        assertEquals(TranscriptRow.Kind.Assistant("Looking at **auth.ts** now.", streaming = true), kind("ti_asst"))
        assertEquals(TranscriptRow.Kind.Reasoning("The token check runs before refresh.", streaming = false, seconds = 2), kind("ti_reason"))
    }

    @Test fun settledThoughtCarriesItsDuration() {
        val start = Instant.ofEpochSecond(1_800_000_000)
        var item = TestData.turnItem("ti_reason").copy(startedAt = start, completedAt = start.plusMillis(12_400))
        assertEquals(TranscriptRow.Kind.Reasoning("The token check runs before refresh.", false, 12), map(item))
        // A replayed item settles in the instant it starts: no duration to show.
        item = item.copy(completedAt = start.plusMillis(200))
        assertEquals(TranscriptRow.Kind.Reasoning("The token check runs before refresh.", false), map(item))
    }

    @Test fun plans() {
        assertEquals(TranscriptRow.Kind.ProposedPlan("1. Read\n2. Fix"), kind("ti_plan"))
        assertEquals(
            TranscriptRow.Kind.Plan(
                listOf(
                    TodoStep("s1", "Read code", TodoStep.Status.Completed),
                    TodoStep("s2", "Write fix", TodoStep.Status.Running),
                    TodoStep("s3", "Test", TodoStep.Status.Pending),
                ),
            ),
            kind("ti_todo"),
        )
    }

    @Test fun tools() {
        assertEquals(TranscriptRow.Kind.Tool("Ran npm test", null, "terminal", ToolStatus.Failed), kind("ti_cmd"))
        assertEquals(TranscriptRow.Kind.Tool("Edited auth.ts", "+12 −3", "pencil", ToolStatus.Completed), kind("ti_file"))
        assertEquals(TranscriptRow.Kind.Tool("Searched for refreshToken", "1 result", "magnifyingglass", ToolStatus.Completed), kind("ti_fsearch"))
        assertEquals(TranscriptRow.Kind.Tool("Searched the web for oauth refresh race", "1 result", "globe", ToolStatus.Completed), kind("ti_wsearch"))
        assertEquals(TranscriptRow.Kind.Tool("Start conversation", "Tool: studio_thread_launch", "wrench.and.screwdriver", ToolStatus.Completed), kind("ti_tool"))
    }

    @Test fun technicalToolNamesAndFailures() {
        var item = TestData.turnItem("ti_tool").copy(content = TurnItem.Content.DynamicToolContent(TurnItem.DynamicTool(toolName = "studio-code.studio_thread_read")))
        assertEquals(
            TranscriptRow.Kind.Tool("Read conversation", "Tool: studio-code.studio_thread_read", "wrench.and.screwdriver", ToolStatus.Completed),
            map(item),
        )
        val output = JsonObject(
            mapOf(
                "isError" to JsonPrimitive(true),
                "content" to JsonArray(listOf(JsonObject(mapOf("text" to JsonPrimitive("Permission denied"))))),
            ),
        )
        item = item.copy(content = TurnItem.Content.DynamicToolContent(TurnItem.DynamicTool(toolName = "studio-code.studio_thread_send", output = output)))
        assertEquals(
            TranscriptRow.Kind.Tool("Send to conversation", "Permission denied\nTool: studio-code.studio_thread_send", "wrench.and.screwdriver", ToolStatus.Failed),
            map(item),
        )
        assertEquals("Tool: unknown.protocol", ToolPresentation("unknown.protocol", null).detail)
    }

    @Test fun commandOutputAndExitCode() {
        val original = TestData.turnItem("ti_cmd")
        val command = (original.content as TurnItem.Content.CommandExecutionContent).value
            .copy(input = "npm test\n--watch", output = "\nok\n", outputIndicatesFailure = null, exitCode = 0)
        var item = original.copy(content = TurnItem.Content.CommandExecutionContent(command), status = TurnItemStatus.Completed)
        assertEquals(TranscriptRow.Kind.Tool("Ran npm test", "ok", "terminal", ToolStatus.Completed), map(item))

        item = item.copy(content = TurnItem.Content.CommandExecutionContent(command.copy(exitCode = 2)))
        assertEquals(TranscriptRow.Kind.Tool("Ran npm test", "ok", "terminal", ToolStatus.Failed), map(item))

        item = item.copy(status = TurnItemStatus.Running)
        assertEquals(TranscriptRow.Kind.Tool("Ran npm test", "ok", "terminal", ToolStatus.Running), map(item))
    }

    @Test fun severalFileChanges() {
        val original = TestData.turnItem("ti_file")
        val change = (original.content as TurnItem.Content.FileChangeContent).value.copy(
            changes = listOf(FileChangeDetail("update", "a.ts"), FileChangeDetail("add", "b.ts")),
            additions = null,
            deletions = null,
        )
        assertEquals(
            TranscriptRow.Kind.Tool("Edited 2 files", null, "pencil", ToolStatus.Completed),
            map(original.copy(content = TurnItem.Content.FileChangeContent(change))),
        )
    }

    /** The provider's own choices, carried through for the approval card. */
    private val fixtureOptions = listOf(
        ApprovalChoice(ApprovalDecision.Approve, "Allow"),
        ApprovalChoice(ApprovalDecision.ApproveForSession, "Allow for session"),
        ApprovalChoice(ApprovalDecision.Deny, "Deny"),
    )

    @Test fun requestsFollowTheItemWithoutRuntimeRequests() {
        assertEquals(TranscriptRow.Kind.Approval("req_1", "Run npm install?", false, "command", fixtureOptions), kind("ti_approval"))
        assertEquals(TranscriptRow.Kind.Question("req_2", "Which database?", false), kind("ti_input"))
    }

    @Test fun requestsResolveFromRuntimeRequests() {
        val approval = (TestData.event(7).second.payload as DomainEvent.Payload.RuntimeRequestPayload).request
        val question = (TestData.event(8).second.payload as DomainEvent.Payload.RuntimeRequestPayload).request
        var requests = mapOf("req_1" to approval, "req_2" to question)
        assertEquals(TranscriptRow.Kind.Approval("req_1", "Run npm install?", false, "command", fixtureOptions), kind("ti_approval", requests))
        assertEquals(TranscriptRow.Kind.Question("req_2", "Which database?", true), kind("ti_input", requests))

        requests = requests + ("req_1" to approval.copy(status = RuntimeRequestStatus.Resolved))
        assertEquals(TranscriptRow.Kind.Approval("req_1", "Run npm install?", true, "command", fixtureOptions), kind("ti_approval", requests))
    }

    @Test fun approvalWithoutPromptGetsOne() {
        val original = TestData.turnItem("ti_approval")
        val request = (original.content as TurnItem.Content.ApprovalRequestContent).value.copy(prompt = null)
        assertEquals(
            TranscriptRow.Kind.Approval("req_1", "Allow this command?", false, "command", fixtureOptions),
            map(original.copy(content = TurnItem.Content.ApprovalRequestContent(request))),
        )
    }

    @Test fun aSubagentRunsWhileItsItemIsInFlight() {
        val item = TestData.turnItem("ti_sub")
        fun row(status: TurnItemStatus) = TranscriptRow("a", assertNotNull(map(item.copy(status = status))))
        assertTrue(row(TurnItemStatus.Running).isRunningSubagent)
        assertFalse(row(TurnItemStatus.Completed).isRunningSubagent)
    }

    @Test fun subagentErrorAndNotices() {
        assertEquals(TranscriptRow.Kind.Subagent("Audit the API", ThreadRef("env", "thr_child"), isRunning = true), kind("ti_sub"))
        assertEquals(TranscriptRow.Kind.Error("Usage limit reached"), kind("ti_err"))
        assertEquals(TranscriptRow.Kind.Notice("Context compacted"), kind("ti_notice"))
        assertEquals(TranscriptRow.Kind.Notice("Audit finished"), kind("ti_note"))
    }

    @Test fun unknownItemsAreSkipped() {
        assertTrue(TestData.turnItem("ti_ckpt").isUnknown)
        assertNull(kind("ti_ckpt"))
    }

    @Test fun everyFixtureItemMaps() {
        val items = TestData.turnItems()
        assertEquals(19, items.size)
        val mapped = items.mapNotNull { map(it) }
        assertEquals(items.count { !it.isUnknown }, mapped.size)
    }

    @Test fun rowsFollowVisibleOrder() {
        val state = TestData.threadState()
        TestData.threadEvents().forEach { state.apply(it) }
        val projection = assertNotNull(state.projection)
        val rows = TranscriptMapper.rows(projection, "env")
        assertEquals(listOf("thr_1/ti_1", "thr_1/ti_asst"), rows.map { it.id })
        assertEquals(TranscriptRow.Kind.Tool("Ran ls", "a\nb", "terminal", ToolStatus.Completed), rows.first().kind)
        assertTrue(TranscriptMapper.isRunning(projection))
        assertEquals(0, TranscriptMapper.queuedCount(projection))
    }

    @Test fun composerStateFromTheProjection() {
        val state = TestData.threadState()
        val snapshot = assertNotNull(state.projection)
        assertEquals(PlanProgress(0, 1), TranscriptMapper.planProgress(snapshot))
        assertEquals(0, TranscriptMapper.queuedCount(snapshot))
        val (sequence, event) = TestData.event(2)
        state.apply(ThreadStreamItem.Event(sequence, event))
        assertEquals(1, TranscriptMapper.queuedCount(assertNotNull(state.projection)))
    }
}
