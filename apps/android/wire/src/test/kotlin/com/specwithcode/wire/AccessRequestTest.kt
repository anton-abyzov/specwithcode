package com.specwithcode.wire

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Test
import java.time.Instant
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class AccessRequestWireTest {
    private fun accessItem(): TurnItem =
        assertNotNull(Fixture.decodeList(TurnItem.serializer(), "turnItems.json").firstOrNull { it.id == "ti_access" })

    @Test fun accessRequestDecodesFromTheFixture() {
        val item = accessItem()
        assertEquals("access_request", item.type)
        assertFalse(item.isUnknown)
        val request = assertIs<TurnItem.Content.AccessRequestContent>(item.content).value
        assertEquals("Use Activity Monitor and iPhone 17 Pro", request.accessTitle)
        assertTrue(request.reason.startsWith("To see what keeps"))
        assertEquals(AccessRequestStatus.Pending, request.accessStatus)
        assertTrue(request.isPending)
        assertNull(request.accessScope)
        assertEquals(2, request.subjects.size)

        val app = request.subjects[0]
        assertEquals(AccessRequestSubjectKind.App, app.kind)
        assertEquals("app:activity monitor", app.key)
        assertEquals("Activity Monitor", app.label)
        assertEquals("See and control its windows", app.detail)
        assertNull(app.hostLabel)
        assertEquals("image/png", app.icon?.mimeType)
        val png = assertNotNull(app.icon?.pngData)
        assertContentEquals(byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47), png.copyOfRange(0, 4))

        val phone = request.subjects[1]
        assertEquals(AccessRequestSubjectKind.Device, phone.kind)
        assertEquals("ios", phone.platform)
        assertEquals("M1", phone.hostLabel)
        assertNull(phone.icon)
    }

    @Test fun accessRequestIsAKnownType() {
        assertTrue("access_request" in TurnItem.knownTypes)
    }

    @Test fun accessRequestAnsweredStatesDecode() {
        fun request(status: String, scope: String?): TurnItem.AccessRequest {
            val scopePart = scope?.let { ""","accessScope":"$it"""" } ?: ""
            val item = decodeJSON<TurnItem>(
                """
                {"id":"ti_a","threadId":"thr_1","ordinal":1,"status":"completed","updatedAt":"2026-10-18T06:00:05.123Z",
                 "type":"access_request","accessTitle":"Use Notes","reason":"","accessStatus":"$status"$scopePart,
                 "subjects":[{"kind":"folder","key":"folder:/tmp","label":"tmp","detail":"Read files"}]}
                """.trimIndent(),
            )
            return assertIs<TurnItem.Content.AccessRequestContent>(item.content).value
        }
        assertEquals(AccessRequestScope.Machine, request("allowed", "machine").accessScope)
        assertEquals(AccessRequestScope.Thread, request("allowed", "thread").accessScope)
        assertEquals(AccessRequestStatus.Denied, request("denied", null).accessStatus)
        assertEquals(AccessRequestStatus.Cancelled, request("cancelled", null).accessStatus)
        // Newer servers stay readable: an unknown status and scope never fail the item.
        val future = request("expired", "everywhere")
        assertEquals("expired", future.accessStatus.rawValue)
        assertFalse(future.accessStatus.isKnown)
        assertNull(future.accessScope)
        assertEquals(AccessRequestSubjectKind.Folder, request("allowed", "thread").subjects.first().kind)
    }

    @Test fun accessRequestToleratesABrokenIconAndAnUnknownKind() {
        val item = decodeJSON<TurnItem>(
            """
            {"id":"ti_b","threadId":"thr_1","ordinal":1,"status":"waiting","updatedAt":"2026-10-18T06:00:05.123Z",
             "type":"access_request","accessTitle":"Use the printer","reason":"Print the report","accessStatus":"pending",
             "subjects":[{"kind":"printer","key":"printer:office","label":"Office","detail":"Print","icon":{"mimeType":"image/png"}}]}
            """.trimIndent(),
        )
        val request = assertIs<TurnItem.Content.AccessRequestContent>(item.content).value
        assertEquals("printer", request.subjects.first().kind.rawValue)
        assertNull(request.subjects.first().icon)
    }

    @Test fun accessRequestRoundTripsThroughTheCache() {
        val item = accessItem()
        val again = WireJson.decodeFromString(TurnItem.serializer(), WireJson.encodeToString(TurnItem.serializer(), item))
        assertEquals(item, again)
    }

    @Test fun accessRequestAnswerEncodesAsTheContract() {
        assertEquals(
            obj("type" to JsonPrimitive("allow"), "scope" to JsonPrimitive("thread")),
            encodeToJSON<AccessRequestAnswer>(AccessRequestAnswer.Allow(AccessRequestScope.Thread)),
        )
        assertEquals(
            obj("type" to JsonPrimitive("allow"), "scope" to JsonPrimitive("machine")),
            encodeToJSON<AccessRequestAnswer>(AccessRequestAnswer.Allow(AccessRequestScope.Machine)),
        )
        assertEquals(obj("type" to JsonPrimitive("deny")), encodeToJSON<AccessRequestAnswer>(AccessRequestAnswer.Deny))
        assertEquals(AccessRequestAnswer.Deny, decodeJSON<AccessRequestAnswer>("""{"type":"deny"}"""))
        assertFailsWith<IllegalArgumentException> { decodeJSON<AccessRequestAnswer>("""{"type":"maybe"}""") }
    }

    @Test fun accessRequestRpcFrame() {
        assertEquals("access.answerRequest", RpcMethod.AccessAnswerRequest.tag)
        assertFalse(RpcMethod.AccessAnswerRequest.isStream)
        val input = AccessAnswerRequestInput("thr_1", "ti_access", AccessRequestAnswer.Allow(AccessRequestScope.Machine))
        val frame = RpcClientMessage.request(9, RpcMethod.AccessAnswerRequest, input)
        val expected = obj(
            "_tag" to JsonPrimitive("Request"), "id" to JsonPrimitive(9), "tag" to JsonPrimitive("access.answerRequest"),
            "payload" to obj(
                "threadId" to JsonPrimitive("thr_1"),
                "turnItemId" to JsonPrimitive("ti_access"),
                "answer" to obj("type" to JsonPrimitive("allow"), "scope" to JsonPrimitive("machine")),
            ),
            "headers" to JsonArray(emptyList()),
        )
        assertEquals(expected, encodeToJSON(frame))
    }

    @Test fun accessRequestErrorsReadAsTheServerMeansThem() {
        val error = ServerError.from(
            listOf(RpcCause.Fail(obj("_tag" to JsonPrimitive("AccessRequestError"), "reason" to JsonPrimitive("already_answered")))),
        )
        assertEquals("This access request was already answered.", error.message)
        assertEquals(ServerError.Kind.Other("AccessRequestError"), error.kind)
        val stopped = ServerError.from(
            listOf(RpcCause.Fail(obj("_tag" to JsonPrimitive("AccessRequestError"), "reason" to JsonPrimitive("agent_stopped")))),
        )
        assertEquals("The agent that asked has stopped, so there is nothing to allow.", stopped.message)
    }
}

/** The port of `packages/client-runtime/src/accessRequest.ts` says what the desktop says. */
class AccessRequestCopyTest {
    private val app = AccessRequestCopy.SubjectName("app", "Notes")
    private val notes = AccessRequestCopy.SubjectName("app", "Notes")
    private val maps = AccessRequestCopy.SubjectName("app", "Maps")
    private val iphone = AccessRequestCopy.SubjectName("device", "iPhone 17 Pro")
    private val pixel = AccessRequestCopy.SubjectName("device", "Pixel 9")
    private val folder = AccessRequestCopy.SubjectName("folder", "src")
    private val machine = AccessRequestCopy.SubjectName("machine", "M1")

    @Test fun headlineNamesTheAgentAndWhatItUses() {
        assertEquals("Claude wants to use Notes", AccessRequestCopy.headline("Claude", listOf(app)))
        assertEquals("Codex wants to control iPhone 17 Pro", AccessRequestCopy.headline("Codex", listOf(iphone)))
        assertEquals("Claude wants to use Notes, Notes and Maps", AccessRequestCopy.headline("Claude", listOf(app, notes, maps)))
        assertEquals(
            "Claude wants to use Notes and control iPhone 17 Pro and Pixel 9",
            AccessRequestCopy.headline("Claude", listOf(notes, iphone, pixel)),
        )
    }

    @Test fun headlineFallsBackWithoutAnAgentOrSubjects() {
        assertEquals("The agent wants to use Notes", AccessRequestCopy.headline(null, listOf(app)))
        assertEquals("The agent wants to use Notes", AccessRequestCopy.headline("  ", listOf(app)))
        assertEquals("Claude wants to use something on your computer", AccessRequestCopy.headline(" Claude ", emptyList()))
    }

    @Test fun tagIsAll() {
        assertEquals("All", AccessRequestCopy.subjectTag(app))
        assertEquals("All", AccessRequestCopy.subjectTag(iphone))
    }

    @Test fun noteSaysWhatAllowLetsTheAgentDo() {
        assertEquals("The agent can see your screen and click and type in these apps while it works.", AccessRequestCopy.note(listOf(app)))
        assertEquals("The agent can see your screen, click and type in these apps, and drive the device.", AccessRequestCopy.note(listOf(app, iphone)))
        assertEquals("The agent can see the device's screen, tap, type and install apps on it.", AccessRequestCopy.note(listOf(iphone)))
        assertEquals("The agent can read and change files in this folder.", AccessRequestCopy.note(listOf(folder)))
        assertEquals("The agent can run work on that machine.", AccessRequestCopy.note(listOf(machine)))
        assertEquals("The agent can see your screen and click and type in these apps while it works.", AccessRequestCopy.note(emptyList()))
    }

    @Test fun waitingSubtitleByKind() {
        assertEquals("Asking to use apps on your computer", AccessRequestCopy.waitingSubtitle(listOf(app)))
        assertEquals("Asking to use apps on your computer", AccessRequestCopy.waitingSubtitle(emptyList()))
        assertEquals("Asking to control a device", AccessRequestCopy.waitingSubtitle(listOf(iphone)))
        assertEquals("Asking to control devices", AccessRequestCopy.waitingSubtitle(listOf(iphone, pixel)))
        assertEquals("Asking to use a folder", AccessRequestCopy.waitingSubtitle(listOf(folder)))
        assertEquals("Asking to work on another machine", AccessRequestCopy.waitingSubtitle(listOf(machine)))
        assertEquals("Asking to use apps on your computer", AccessRequestCopy.waitingSubtitle(listOf(app, iphone)))
    }

    @Test fun waitingSentenceTrimsThePurpose() {
        assertEquals(
            "is waiting for you to allow access to M4, so it can find what keeps the Mac awake.",
            AccessRequestCopy.waitingSentence("M4", "To find what keeps the Mac awake."),
        )
        assertEquals(
            "is waiting for you to allow access to M4, so it can capture screenshots.",
            AccessRequestCopy.waitingSentence("M4", "in order to Capture screenshots!!"),
        )
        assertEquals("is waiting for you to allow access to M4.", AccessRequestCopy.waitingSentence("M4", "  "))
    }

    @Test fun pendingAccessSummaryIsOptional() {
        val bare = decodeJSON<PendingRuntimeRequestSummary>(
            """{"id":"turn-item:access-request:t:k","kind":"permission","createdAt":"2026-11-04T12:00:00.000Z"}""",
        )
        assertNull(bare.access)
        assertTrue(bare.isAccessRequest)

        val full = decodeJSON<PendingRuntimeRequestSummary>(
            """
            {"id":"turn-item:access-request:t:k","kind":"permission","createdAt":"2026-11-04T12:00:00.000Z",
             "access":{"accessTitle":"Use iPhone 17 Pro","reason":"Check the fix","subjects":[{"kind":"device","label":"iPhone 17 Pro","hostLabel":"M1"}]}}
            """.trimIndent(),
        )
        assertEquals("Use iPhone 17 Pro", full.access?.accessTitle)
        assertEquals("M1", full.access?.subjects?.first()?.hostLabel)
        assertEquals("Asking to control a device", AccessRequestCopy.waitingSubtitle(full.access?.subjects?.map { it.copyName } ?: emptyList()))
    }

    @Test fun aMalformedAccessSummaryKeepsTheRequest() {
        val broken = decodeJSON<PendingRuntimeRequestSummary>(
            """{"id":"turn-item:access-request:t:k","kind":"permission","createdAt":"2026-11-04T12:00:00.000Z","access":{"subjects":"nope"}}""",
        )
        assertNull(broken.access)
        assertTrue(broken.isAccessRequest)
    }

    @Test fun otherPermissionRequestsAreNotAccessRequests() {
        val other = decodeJSON<PendingRuntimeRequestSummary>("""{"id":"req_1","kind":"permission","createdAt":"2026-11-04T12:00:00.000Z"}""")
        assertFalse(other.isAccessRequest)
        val command = PendingRuntimeRequestSummary(id = "turn-item:access-request:x", kind = RuntimeRequestKind.Command, createdAt = Instant.now())
        assertFalse(command.isAccessRequest)
    }
}
