package com.specwithcode.wire

import kotlinx.serialization.json.JsonPrimitive
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

class DeviceStateTest {
    @Test fun decodesAServerStateAndIgnoresFieldsItDoesNotRead() {
        val state = decodeJSON<DeviceServiceState>(
            """
            {"supportsHostRetry":true,"hosts":[{"id":"local","kind":"local","label":"M4","tools":{"hub":"1.2.0"}}],
             "hostStatus":"ready","hostStatuses":{"local":{"status":"ready"}},
             "devices":[{"hostId":"local","id":"439CE36F","platform":"ios","name":"iPhone Duo","version":"iOS 26.0","booted":true,"physical":false,"formFactor":"fold"}],
             "sessions":[{"threadId":"t-1","hostId":"local","deviceId":"439CE36F","platform":"ios","openedAt":"2026-10-25T08:00:00.000Z"}],
             "onboardingCompleted":true,"agentAccessEnabled":true,"hubBasePath":"/api/device-hub","revision":7}
            """.trimIndent(),
        )
        assertEquals(listOf(DeviceHostSummary(id = "local", kind = "local", label = "M4")), state.hosts)
        assertEquals("iPhone Duo", state.devices.first().name)
        assertEquals(DevicePlatform.Ios, state.devices.first().platform)
        assertEquals("439CE36F", state.sessions.first().deviceId)
        assertEquals("ready", state.hostStatus)
        assertEquals(7, state.revision)
        assertEquals("/api/device-hub", state.hubPath)
    }

    @Test fun skipsEntriesItCannotReadAndDefaultsMissingLists() {
        val state = decodeJSON<DeviceServiceState>(
            """
            {"devices":[{"hostId":"local","id":"a","platform":"ios","name":"One"},{"id":"no-host"},{"hostId":"h","id":"b","platform":"tvos","name":"Two"}],
             "sessions":"not a list","hostStatus":42,"hubBasePath":"https://elsewhere.example/hub"}
            """.trimIndent(),
        )
        assertEquals(listOf("a", "b"), state.devices.map { it.id })
        assertEquals("tvos", state.devices.last().platform.rawValue)
        assertTrue(state.hosts.isEmpty())
        assertTrue(state.sessions.isEmpty())
        assertNull(state.hostStatus)
        // Only an origin-relative hub path is used.
        assertEquals("/api/device-hub", state.hubPath)
    }
}

class PromptSuggestionWireTest {
    private val run = """"id":"run_1","threadId":"thr_1","ordinal":1,"providerInstanceId":"claudeAgent","modelSelection":{"instanceId":"claudeAgent","model":"claude-opus-5-5"},"userMessageId":"msg_1","status":"completed","requestedAt":"2026-10-18T06:11:00.000Z""""

    @Test fun runWithoutSuggestion() {
        val decoded = decodeJSON<Run>("{$run}")
        assertNull(decoded.promptSuggestion)
        assertNull(encodeToJSON(decoded)["promptSuggestion"])
    }

    @Test fun runWithSuggestion() {
        val decoded = decodeJSON<Run>("""{$run,"promptSuggestion":{"text":"Open a PR","source":"provider"}}""")
        assertEquals(PromptSuggestion(text = "Open a PR", source = "provider"), decoded.promptSuggestion)
        val round = encodeToJSON(decoded)
        assertEquals(JsonPrimitive("Open a PR"), round["promptSuggestion"]["text"])
        assertEquals(JsonPrimitive("provider"), round["promptSuggestion"]["source"])
    }

    @Test fun malformedSuggestionKeepsTheRun() {
        val decoded = decodeJSON<Run>("""{$run,"promptSuggestion":{"text":7}}""")
        assertEquals("run_1", decoded.id)
        assertNull(decoded.promptSuggestion)
    }

    @Test fun promptSuggestedEvent() {
        val json = """{"id":"ev_ps","threadId":"thr_1","runId":"run_1","occurredAt":"2026-10-18T06:20:00.000Z","type":"run.prompt-suggested","payload":{"runId":"run_1","promptSuggestion":{"text":"Run the tests","source":"generated"}}}"""
        val event = decodeJSON<DomainEvent>(json)
        assertTrue("run.prompt-suggested" in DomainEvent.typedEventTypes)
        assertFalse(event.isUnknown)
        val payload = assertIs<DomainEvent.Payload.PromptSuggestionPayload>(event.payload)
        assertEquals(RunPromptSuggestion("run_1", PromptSuggestion("Run the tests", "generated")), payload.value)
        assertEquals(parse(json), encodeToJSON(event))
    }

    @Test fun malformedPromptSuggestedEventFails() {
        assertFailsWith<IllegalArgumentException> {
            decodeJSON<DomainEvent>(
                """{"id":"ev_ps","threadId":"thr_1","occurredAt":"2026-10-18T06:20:00.000Z","type":"run.prompt-suggested","payload":{"runId":"run_1"}}""",
            )
        }
    }
}

class ProjectOriginTest {
    @Test fun demoFoldersAreAutomatedLikeTheWeb() {
        // Sample apps an agent registered to record a demo (October 30, 2026).
        assertTrue(ProjectOrigin.isAutomatedWorkspaceRoot("/Users/x/Projects/experiments/greet-app-demo"))
        assertTrue(ProjectOrigin.isAutomatedWorkspaceRoot("/Users/x/Projects/experiments/swc-demo-greet-fleet"))
        // Only whole words count, and the app's projects folder is always the person's.
        assertFalse(ProjectOrigin.isAutomatedWorkspaceRoot("/Users/x/Projects/demographics"))
        assertFalse(ProjectOrigin.isAutomatedWorkspaceRoot("/Users/x/Projects/demo/invoices"))
        assertFalse(ProjectOrigin.isAutomatedWorkspaceRoot("/Users/x/.specwithcode/m4/projects/demo-notes"))
        assertFalse(ProjectOrigin.isAutomatedWorkspaceRoot("/Users/x/Projects/sw-easychamp"))
    }
}
