package com.specwithcode.transport

import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Before
import org.junit.Test
import java.time.Instant
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicReference
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue

class RetryPolicyTest {
    private val policy = RetryPolicy()

    @Test
    fun delaysFollowTheSupervisorLadder() {
        // ceiling = min(300 s, 1 s * 2^(failures + 1)); delay in [ceiling / 2, ceiling].
        assertEquals(1_000, policy.delayMillis(0, 0.0))
        assertEquals(2_000, policy.delayMillis(0, 1.0))
        assertEquals(2_000, policy.delayMillis(1, 0.0))
        assertEquals(3_000, policy.delayMillis(1, 0.5))
        assertEquals(16_000, policy.delayMillis(3, 0.999_999_9))
        assertEquals(150_000, policy.delayMillis(8, 0.0))
        assertEquals(300_000, policy.delayMillis(8, 1.0))
        assertEquals(300_000, policy.delayMillis(1_000, 1.0))
        for (failures in 0..40) {
            repeat(20) {
                val random = Math.random()
                val ceiling = minOf(300_000.0, 1_000.0 * Math.pow(2.0, (failures + 1).coerceAtMost(30).toDouble()))
                val delay = policy.delayMillis(failures, random)
                assertTrue(delay >= ceiling / 2 - 1 && delay <= ceiling + 1, "failures=$failures delay=$delay")
            }
        }
    }

    @Test
    fun retryAfterIsTheFloor() {
        assertEquals(42_000, policy.delayMillis(0, 0.5, retryAfterMillis = 42_000))
        assertEquals(1_500, policy.delayMillis(0, 0.5, retryAfterMillis = 100))
    }
}

class MachineConnectionTest {
    private val server = MockWebServer()
    private val peers = CopyOnWriteArrayList<ServerSocket>()
    private val requests = CopyOnWriteArrayList<String>()
    private val sleeps = CopyOnWriteArrayList<Long>()
    private val clock = AtomicReference(Instant.parse("2026-11-05T10:00:00Z"))

    @Volatile var descriptor: () -> MockResponse = { json(descriptorJson()) }
    @Volatile var ticket: () -> MockResponse = { json("""{"ticket":"tk.sig","expiresAt":"2026-11-05T10:05:00.000Z"}""") }
    @Volatile var session: () -> MockResponse = { json("""{"authenticated":true,"scopes":[]}""") }
    @Volatile var upgrade: () -> MockResponse = { ServerSocket().also { peers += it }.upgrade() }

    private lateinit var base: String

    @Before
    fun setUp() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += "${request.method} ${request.path}"
                return when (request.requestUrl?.encodedPath) {
                    "/.well-known/studio/environment" -> descriptor()
                    "/api/auth/websocket-ticket" -> ticket()
                    "/api/auth/session" -> session()
                    "/ws" -> upgrade()
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        server.start()
        base = server.url("/").toString()
    }

    @After
    fun tearDown() = server.shutdown()

    private fun record(): MachineRecord = MachineRecord("env-1", "M4", listOf(MachineRoute(base, base.replaceFirst("http", "ws"))))

    private fun store(expiresAt: Instant = clock.get().plusSeconds(86_400)) = InMemoryCredentialStore().apply {
        save(MachineCredential("tok-1", expiresAt, listOf("orchestration:read")), "env-1", base.trimEnd('/'))
    }

    private fun connection(credentials: CredentialStore = store()) = MachineConnection(
        record(),
        credentials,
        http = MachineHttp(now = { clock.get() }),
        configuration = MachineConnection.Configuration(
            socket = RpcSocket.Configuration(pingIntervalMillis = 60_000),
            sleep = { sleeps += it; kotlinx.coroutines.delay(20) },
            random = { 0.5 },
            now = { clock.get() },
        ),
    )

    private suspend fun MachineConnection.await(state: MachineConnection.State): MachineConnection.Status =
        withTimeout(10_000) { status.first { it.state == state } }

    @Test
    fun connectsWithATicketAndTheClientParameters() = runBlocking {
        val connection = connection()
        connection.setActive(true)
        val status = connection.await(MachineConnection.State.CONNECTED)
        assertEquals("env-1", status.descriptor?.environmentId)
        assertEquals(1, status.tokenDaysLeft)
        val socketRequest = requests.first { it.startsWith("GET /ws") }
        assertEquals(
            "GET /ws?wsTicket=tk.sig&orchestrationProtocol=2&clientSurface=mobile&clientOs=Android&clientDeviceType=phone&connectionMethod=direct",
            socketRequest,
        )
        assertTrue(connection.socket.value != null)
        connection.close()
    }

    @Test
    fun socketUrlEncodesTheTicket() {
        assertEquals(
            "wss://m4.example.com/ws?wsTicket=a%2Bb%2Fc.d&orchestrationProtocol=2&clientOs=Android",
            MachineConnection.socketUrl("wss://m4.example.com/", "a+b/c.d", listOf("clientOs" to "Android")),
        )
        assertEquals(
            listOf("clientSurface" to "mobile", "connectionMethod" to "relay"),
            MachineConnection.relayParameters(listOf("clientSurface" to "mobile", "connectionMethod" to "direct")),
        )
    }

    @Test
    fun aRejectedTicketNeedsRepairAndStopsRetrying() = runBlocking {
        ticket = { json("""{"code":"auth_invalid","reason":"invalid_credential"}""", 401) }
        val connection = connection()
        connection.setActive(true)
        val status = connection.await(MachineConnection.State.NEEDS_REPAIR)
        assertIs<TransportException.NeedsRepair>(status.lastError)
        kotlinx.coroutines.delay(200)
        assertEquals(1, requests.count { it.contains("websocket-ticket") })
        assertTrue(sleeps.isEmpty())
        connection.close()
    }

    @Test
    fun aMissingOrExpiredTokenNeedsRepair() = runBlocking {
        val none = connection(InMemoryCredentialStore())
        none.setActive(true)
        none.await(MachineConnection.State.NEEDS_REPAIR)
        none.close()
        val expired = connection(store(expiresAt = clock.get().minusSeconds(1)))
        expired.setActive(true)
        expired.await(MachineConnection.State.NEEDS_REPAIR)
        assertTrue(requests.isEmpty())
        expired.close()
    }

    @Test
    fun anIncompatibleServerIsUnsupported() = runBlocking {
        descriptor = { json(descriptorJson(protocol = 3)) }
        val connection = connection()
        connection.setActive(true)
        assertIs<TransportException.AppTooOld>(connection.await(MachineConnection.State.UNSUPPORTED).lastError)
        connection.close()
    }

    @Test
    fun rateLimitedTicketsWaitAtLeastRetryAfter() = runBlocking {
        ticket = { json("""{"code":"rate_limited","retryAfterSeconds":42}""", 429) }
        val connection = connection()
        connection.setActive(true)
        withTimeout(10_000) { while (sleeps.isEmpty()) kotlinx.coroutines.delay(10) }
        assertEquals(42_000, sleeps.first())
        val status = connection.status.value
        assertTrue(status.state == MachineConnection.State.OFFLINE || status.state == MachineConnection.State.CONNECTING)
        connection.close()
    }

    @Test
    fun unreachableMachinesBackOffAlongTheLadder() = runBlocking {
        descriptor = { MockResponse().setResponseCode(503) }
        val connection = connection()
        connection.setActive(true)
        withTimeout(10_000) { while (sleeps.size < 3) kotlinx.coroutines.delay(10) }
        connection.close()
        // random = 0.5: 1.5 s, 3 s, 6 s.
        assertEquals(listOf(1_500L, 3_000L, 6_000L), sleeps.take(3))
    }

    @Test
    fun aRefusedUpgradeWithAValidSessionRetries() = runBlocking {
        upgrade = { MockResponse().setResponseCode(503) }
        val connection = connection()
        connection.setActive(true)
        withTimeout(10_000) { while (sleeps.isEmpty()) kotlinx.coroutines.delay(10) }
        assertIs<TransportException.UpgradeFailed>(connection.status.value.lastError)
        assertTrue(requests.any { it == "GET /api/auth/session" })
        connection.close()
    }

    @Test
    fun aRefusedUpgradeWithARevokedSessionNeedsRepair() = runBlocking {
        upgrade = { MockResponse().setResponseCode(401) }
        session = { json("""{"authenticated":false}""") }
        var tickets = 0
        ticket = {
            tickets++
            if (tickets == 1) json("""{"ticket":"t"}""") else json("""{"code":"auth_invalid","reason":"invalid_credential"}""", 401)
        }
        val connection = connection()
        connection.setActive(true)
        connection.await(MachineConnection.State.NEEDS_REPAIR)
        connection.close()
    }

    @Test
    fun aShortLivedConnectionBacksOffAndAStableOneDoesNot() = runBlocking {
        val connection = connection()
        connection.setActive(true)
        connection.await(MachineConnection.State.CONNECTED)
        // Dropped at once: counts as a failure.
        peers.last().awaitOpen().socket.close(1000, null)
        withTimeout(10_000) { while (sleeps.isEmpty()) kotlinx.coroutines.delay(10) }
        assertEquals(1_500L, sleeps.single())
        withTimeout(10_000) { while (peers.size < 2) kotlinx.coroutines.delay(10) }
        connection.await(MachineConnection.State.CONNECTED)
        // Lasted 31 s: the ladder resets and it reconnects without waiting.
        clock.set(clock.get().plusSeconds(31))
        peers.last().awaitOpen().socket.close(1000, null)
        withTimeout(10_000) { while (peers.size < 3) kotlinx.coroutines.delay(10) }
        connection.await(MachineConnection.State.CONNECTED)
        assertEquals(1, sleeps.size)
        // The cached ticket was reused while it had time left.
        assertEquals(1, requests.count { it.contains("websocket-ticket") })
        connection.close()
    }

    @Test
    fun backgroundClosesAndForegroundReconnects() = runBlocking {
        val connection = connection()
        connection.setActive(true)
        connection.await(MachineConnection.State.CONNECTED)
        connection.setActive(false)
        assertEquals(MachineConnection.State.OFFLINE, connection.status.value.state)
        assertEquals(null, connection.socket.value)
        connection.setActive(true)
        connection.await(MachineConnection.State.CONNECTED)
        assertEquals(2, peers.size)
        connection.close()
    }

    @Test
    fun aRouteWithoutItsOwnTokenIsNeverContacted() = runBlocking {
        val credentials = InMemoryCredentialStore().apply {
            save(MachineCredential("other", clock.get().plusSeconds(86_400)), "env-1", "http://192.168.1.99:8319")
        }
        val connection = connection(credentials)
        connection.setActive(true)
        connection.await(MachineConnection.State.NEEDS_REPAIR)
        assertTrue(requests.isEmpty())
        connection.close()
    }

    @Test
    fun unreadableStorageIsTransient() = runBlocking {
        val connection = connection(FailingCredentialStore())
        connection.setActive(true)
        withTimeout(10_000) { while (sleeps.isEmpty()) kotlinx.coroutines.delay(10) }
        assertIs<TransportException.Unreachable>(connection.status.value.lastError)
        connection.close()
    }
}
