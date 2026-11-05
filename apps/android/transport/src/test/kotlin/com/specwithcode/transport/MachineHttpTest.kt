package com.specwithcode.transport

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.time.Instant
import java.util.concurrent.TimeUnit
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class MachineHttpTest {
    private val server = MockWebServer()
    private val now = Instant.parse("2026-11-05T10:00:00Z")
    private lateinit var base: String
    private lateinit var http: MachineHttp

    @Before
    fun setUp() {
        server.start()
        base = server.url("/").toString()
        http = MachineHttp(now = { now })
    }

    @After
    fun tearDown() = server.shutdown()

    private fun taken() = server.takeRequest(5, TimeUnit.SECONDS)!!

    @Test
    fun fetchesTheDescriptorWithoutAuth() = runBlocking {
        server.enqueue(json(descriptorJson()))
        val descriptor = http.descriptor(base)
        assertEquals("env-1", descriptor.environmentId)
        assertEquals("M4", descriptor.label)
        val request = taken()
        assertEquals("GET", request.method)
        assertEquals("/.well-known/studio/environment", request.path)
        assertNull(request.getHeader("Authorization"))
    }

    @Test
    fun checksTheProtocolVersion() = runBlocking {
        server.enqueue(json(descriptorJson(protocol = null)))
        assertEquals(1, assertFailsWith<TransportException.ServerTooOld> { http.descriptor(base) }.descriptor.protocolVersion)
        server.enqueue(json(descriptorJson(protocol = 1)))
        assertFailsWith<TransportException.ServerTooOld> { http.descriptor(base) }
        server.enqueue(json(descriptorJson(protocol = 3)))
        val tooOld = assertFailsWith<TransportException.AppTooOld> { http.descriptor(base) }
        assertEquals("M4 runs a newer SpecWithCode. Update the app to connect.", tooOld.message)
        assertTrue(tooOld.isPermanent)
    }

    @Test
    fun checksTheEnvironmentBeforeTheVersion() = runBlocking {
        server.enqueue(json(descriptorJson(environmentId = "other", protocol = 3)))
        val error = assertFailsWith<TransportException.EnvironmentMismatch> { http.descriptor(base, expectedEnvironmentId = "env-1") }
        assertEquals("other", error.actual)
    }

    @Test
    fun descriptorTimesOut() = runBlocking {
        server.enqueue(json(descriptorJson()).setHeadersDelay(2, TimeUnit.SECONDS))
        val quick = MachineHttp(descriptorTimeoutMillis = 200)
        assertFailsWith<TransportException.TimedOut> { quick.descriptor(base) }
        Unit
    }

    @Test
    fun mapsNetworkFailures() = runBlocking {
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AT_START))
        assertFailsWith<TransportException.Unreachable> { http.rawDescriptor(base) }
        server.shutdown()
        assertFailsWith<TransportException.Unreachable> { http.rawDescriptor(base) }
        Unit
    }

    @Test
    fun exchangesThePairingCodeFormEncoded() = runBlocking {
        server.enqueue(
            json(
                """{"access_token":"tok-1","issued_token_type":"urn:ietf:params:oauth:token-type:access_token","token_type":"Bearer","expires_in":2592000,"scope":"orchestration:read orchestration:operate"}""",
            ),
        )
        val grant = http.exchangePairingCode("7KQ2MZ9XPTB4", base, "Pixel 9 (SpecWithCode)")
        assertEquals("tok-1", grant.accessToken)
        assertEquals(now.plusSeconds(2_592_000), grant.expiresAt)
        assertEquals(listOf("orchestration:read", "orchestration:operate"), grant.scopes)
        assertTrue("tok-1" !in grant.toString())

        val request = taken()
        assertEquals("POST", request.method)
        assertEquals("/oauth/token", request.path)
        assertEquals("application/x-www-form-urlencoded", request.getHeader("Content-Type")?.substringBefore(';'))
        assertNull(request.getHeader("Authorization"))
        assertNull(request.getHeader("DPoP"))
        assertEquals(
            "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange" +
                "&subject_token=7KQ2MZ9XPTB4" +
                "&subject_token_type=urn%3Aspecweave-studio%3Aparams%3Aoauth%3Atoken-type%3Aenvironment-bootstrap" +
                "&requested_token_type=urn%3Aietf%3Aparams%3Aoauth%3Atoken-type%3Aaccess_token" +
                "&client_device_type=mobile&client_os=Android&client_label=Pixel+9+%28SpecWithCode%29",
            request.body.readUtf8(),
        )
    }

    @Test
    fun missingExpiryMeansThirtyDays() = runBlocking {
        server.enqueue(json("""{"access_token":"t"}"""))
        assertEquals(now.plusSeconds(30L * 86_400), http.exchangePairingCode("C", base, "x").expiresAt)
    }

    @Test
    fun aSpentCodeIsRejectedNotARepair() = runBlocking {
        server.enqueue(json("""{"_tag":"EnvironmentAuthInvalidError","code":"auth_invalid","reason":"invalid_credential","traceId":"t"}""", 401))
        val error = assertFailsWith<TransportException.PairingCodeRejected> { http.exchangePairingCode("USED", base, "x") }
        assertTrue(error.isPermanent)
    }

    @Test
    fun rateLimitCarriesItsRetryAfter() = runBlocking {
        server.enqueue(json("""{"code":"rate_limited","retryAfterSeconds":42}""", 429).setHeader("retry-after", "40"))
        val fromBody = assertFailsWith<TransportException.Http> { http.exchangePairingCode("C", base, "x") }
        assertEquals(429, fromBody.status)
        assertEquals("rate_limited", fromBody.code)
        assertEquals(42L, fromBody.retryAfterSeconds)
        server.enqueue(json("""{"code":"rate_limited"}""", 429).setHeader("retry-after", "17"))
        assertEquals(17L, assertFailsWith<TransportException.Http> { http.exchangePairingCode("C", base, "x") }.retryAfterSeconds)
    }

    @Test
    fun badScopeKeepsItsReason() = runBlocking {
        server.enqueue(json("""{"code":"invalid_request","reason":"scope_not_granted"}""", 400))
        val error = assertFailsWith<TransportException.Http> { http.exchangePairingCode("C", base, "x") }
        assertEquals(400, error.status)
        assertEquals("scope_not_granted", error.code)
    }

    @Test
    fun getsAWebSocketTicketWithTheBearerToken() = runBlocking {
        server.enqueue(json("""{"ticket":"abc.def","expiresAt":"2026-11-05T10:05:00.000Z"}"""))
        val ticket = http.websocketTicket(MachineAuth.Bearer("tok-1"), base)
        assertEquals("abc.def", ticket.ticket)
        assertEquals(Instant.parse("2026-11-05T10:05:00Z"), ticket.expiresAt)
        val request = taken()
        assertEquals("POST", request.method)
        assertEquals("/api/auth/websocket-ticket", request.path)
        assertEquals("Bearer tok-1", request.getHeader("Authorization"))
        assertEquals(0L, request.bodySize)
    }

    @Test
    fun dpopRequestsCarryAProofWithAth() = runBlocking {
        val key = SoftwareDpopKey()
        server.enqueue(json("""{"ticket":"t"}"""))
        http.websocketTicket(MachineAuth.Dpop("env-token", key), base)
        val request = taken()
        assertEquals("DPoP env-token", request.getHeader("Authorization"))
        val proof = request.getHeader("DPoP")!!
        val payload = String(Base64Url.decode(proof.split('.')[1])!!)
        assertTrue(payload.contains(""""ath":"${DpopProof.accessTokenHash("env-token")}""""), payload)
        assertTrue(payload.contains(""""htu":"${base}api/auth/websocket-ticket""""), payload)
    }

    @Test
    fun invalidCredentialNeedsRepair() = runBlocking {
        server.enqueue(json("""{"_tag":"EnvironmentAuthInvalidError","code":"auth_invalid","reason":"invalid_credential"}""", 401))
        assertFailsWith<TransportException.NeedsRepair> { http.websocketTicket(MachineAuth.Bearer("old"), base) }
        server.enqueue(json("{}", 401))
        assertFailsWith<TransportException.NeedsRepair> { http.websocketTicket(MachineAuth.Bearer("old"), base) }
        server.enqueue(json("""{"code":"auth_invalid","reason":"device_reapproval_required"}""", 401))
        val reapproval = assertFailsWith<TransportException.NeedsRepair> { http.websocketTicket(MachineAuth.Bearer("old"), base) }
        assertEquals("device_reapproval_required", reapproval.reason)
        assertTrue(reapproval.reapprovalRequired)
        assertTrue(reapproval.message!!.startsWith("Approve this device again"))
        server.enqueue(json("""{"_tag":"EnvironmentAuthInvalidError","code":"auth_invalid","reason":"missing_credential"}""", 401))
        assertEquals("missing_credential", assertFailsWith<TransportException.NeedsRepair> { http.websocketTicket(MachineAuth.Bearer("old"), base) }.reason)
    }

    @Test
    fun aTeamRulesRefusalIsNotARepair() = runBlocking {
        server.enqueue(json("""{"code":"auth_invalid","reason":"invalid_credential","teamRulesMessage":"Phones are off for this machine."}""", 403))
        val error = assertFailsWith<TransportException.TeamRules> { http.websocketTicket(MachineAuth.Bearer("t"), base) }
        assertEquals("Phones are off for this machine.", error.message)
        assertTrue(!error.isPermanent)
    }

    @Test
    fun readsTheSession() = runBlocking {
        server.enqueue(
            json("""{"authenticated":true,"scopes":["orchestration:read"],"permissions":["x"],"sessionMethod":"bearer","expiresAt":"2026-12-05T10:00:00.000Z","auth":{}}"""),
        )
        val session = http.session(MachineAuth.Bearer("t"), base)
        assertTrue(session.authenticated)
        assertTrue(session.allows("orchestration:read"))
        assertEquals(Instant.parse("2026-12-05T10:00:00Z"), session.expiresAt)
        assertEquals("/api/auth/session", taken().path)
    }

    @Test
    fun snapshotsSendTheProtocolHeader() = runBlocking {
        server.enqueue(json("""{"schemaVersion":1,"snapshotSequence":12,"threads":[],"archivedThreads":[],"projects":[]}"""))
        assertEquals(12, http.shellSnapshot(MachineAuth.Bearer("t"), base).snapshotSequence)
        val shell = taken()
        assertEquals("/api/orchestration/shell", shell.path)
        assertEquals("2", shell.getHeader("x-studio-orchestration-protocol"))
        assertEquals("Bearer t", shell.getHeader("Authorization"))

        server.enqueue(json("{}", 404))
        assertNull(http.threadSnapshot(MachineAuth.Bearer("t"), base, "thread/1"))
        val thread = taken()
        assertEquals("/api/orchestration/threads/thread%2F1", thread.path)
        assertEquals("2", thread.getHeader("x-studio-orchestration-protocol"))
    }

    @Test
    fun unreadableAnswersAreInvalidResponses() = runBlocking {
        server.enqueue(json("<html>"))
        assertFailsWith<TransportException.InvalidResponse> { http.rawDescriptor(base) }
        Unit
    }

    @Test
    fun signedUploadsStayOnTheMachine() = runBlocking {
        assertFailsWith<TransportException.InvalidAddress> { http.uploadSigned(ByteArray(1), "image/png", "//evil.example.com/x", base) }
        assertFailsWith<TransportException.InvalidAddress> { http.uploadSigned(ByteArray(1), "image/png", "https://evil.example.com/x", base) }
        server.enqueue(MockResponse().setResponseCode(204))
        http.uploadSigned(byteArrayOf(1, 2), "image/png", "/api/attachments/upload/tok?x=1", base)
        val request = taken()
        assertEquals("/api/attachments/upload/tok?x=1", request.path)
        assertEquals("image/png", request.getHeader("Content-Type"))
    }

    @Test
    fun readsThePhoneRoster() = runBlocking {
        server.enqueue(
            json(
                """{"hub":{"environmentId":"env-1","label":"M4"},"machines":[{"environmentId":"env-2","label":"M1",""" +
                    """"routes":[{"kind":"fleet","httpBaseUrl":"http://10.0.0.2:8319"}],"pairing":{"code":"ABCDEFGHJKLM","expiresAt":"2026-11-05T10:05:00.000Z"}},""" +
                    """{"environmentId":"env-3","label":"Box","problem":"unreachable"}]}""",
            ),
        )
        val roster = http.phoneRoster(MachineAuth.Bearer("t"), base, mint = listOf("env-2"))
        assertEquals("M4", roster.hub.label)
        assertEquals("ABCDEFGHJKLM", roster.machines[0].pairing?.code)
        assertEquals("unreachable", roster.machines[1].problem)
        assertEquals("""{"mint":["env-2"]}""", taken().body.readUtf8())
    }

    @Test
    fun pairsAndRemembersTheMachine() = runBlocking {
        val dir = Files.createTempDirectory("registry").toFile()
        try {
            val registry = MachineRegistry(File(dir, "machines.json"))
            val store = InMemoryCredentialStore()
            server.enqueue(json(descriptorJson()))
            server.enqueue(json("""{"access_token":"tok-1","expires_in":2592000,"scope":"orchestration:read"}"""))
            val result = MachinePairing(http, store, registry).pair("${base}pair#token=7KQ2MZ9XPTB4", "Pixel")
            assertEquals("env-1", result.record.environmentId)
            assertEquals("tok-1", store.credential("env-1", base.trimEnd('/'))?.token)
            assertEquals(listOf(base), registry.all().single().routes.map { it.httpBase })
            // Reading the file back gives the same record.
            assertEquals(registry.all(), MachineRegistry(File(dir, "machines.json")).all())
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun doesNotSpendTheCodeOnTheWrongMachine() = runBlocking {
        server.enqueue(json(descriptorJson(environmentId = "other")))
        val pairing = MachinePairing(http, InMemoryCredentialStore(), MachineRegistry(File.createTempFile("machines", ".json").apply { deleteOnExit() }))
        assertFailsWith<TransportException.EnvironmentMismatch> {
            pairing.pair(PairingLink.parse("${base}#token=C"), "Pixel", expectedEnvironmentId = "env-1")
        }
        assertEquals(1, server.requestCount)
        assertNotNull(taken())
        Unit
    }
}
