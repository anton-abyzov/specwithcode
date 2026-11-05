package com.specwithcode.sync

import com.specwithcode.transport.ConnectAuthorizer
import com.specwithcode.transport.ConnectConfig
import com.specwithcode.transport.InMemoryCredentialStore
import com.specwithcode.transport.InMemoryDpopKeyStore
import com.specwithcode.transport.MachineHttp
import com.specwithcode.transport.MachineConnection
import com.specwithcode.transport.MachineCredential
import com.specwithcode.transport.MachineRegistry
import com.specwithcode.transport.MachineRoute
import com.specwithcode.transport.RetryPolicy
import com.specwithcode.wire.WireJson
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Before
import java.io.File
import java.nio.file.Files
import java.time.Instant
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

/**
 * The engine against a fake machine: HTTP for the descriptor, ticket and snapshots, and a
 * WebSocket that answers Effect RPC requests the way the desktop server does.
 */
class LiveEngineTest {
    private val server = MockWebServer()
    private val requests = CopyOnWriteArrayList<String>()

    /** Every RPC request the phone sent: tag and payload. */
    private val calls = CopyOnWriteArrayList<Pair<String, JsonObject>>()
    private val peers = CopyOnWriteArrayList<FakeMachineSocket>()
    private lateinit var base: String
    private lateinit var dir: File
    private var engine: LiveEngine? = null

    @Volatile private var capabilities = """{"connectionProbe":true}"""
    private val descriptor: String get() =
        """{"environmentId":"env-1","label":"M4","platform":{"os":"darwin","arch":"arm64"},"serverVersion":"1.0.0","orchestrationProtocolVersion":2,"capabilities":$capabilities}"""

    /** The environment the socket's config names; another id plays a reused hostname. */
    @Volatile private var configEnvironmentId = "env-1"

    /** Extra `server.getConfig` fields, e.g. the completion-marker flags. */
    @Volatile private var configExtra = ""

    /** The pairing was revoked on the machine: authenticated HTTP calls are refused. */
    @Volatile private var revoked = false

    /** Open `subscribeShell` streams: the peer and the request id. */
    private val shellStreams = CopyOnWriteArrayList<Pair<FakeMachineSocket, String>>()

    private fun json(body: String) = MockResponse().setHeader("Content-Type", "application/json").setBody(body)

    @Before
    fun setUp() {
        dir = Files.createTempDirectory("live-engine").toFile()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += "${request.method} ${request.requestUrl?.encodedPath}"
                return when (request.requestUrl?.encodedPath) {
                    "/.well-known/studio/environment" -> json(descriptor)
                    "/api/auth/websocket-ticket" -> if (revoked) {
                        json("""{"error":"unauthorized"}""").setResponseCode(401)
                    } else {
                        json("""{"ticket":"tk.sig","expiresAt":"2099-01-01T00:00:00.000Z"}""")
                    }
                    "/api/auth/session" -> json(if (revoked) """{"authenticated":false}""" else """{"authenticated":true,"scopes":[]}""")
                    "/api/orchestration/shell" -> json(TestData.json("shellStreamItem.snapshot.json").jsonObject.getValue("snapshot").toString())
                    "/api/orchestration/threads/thr_1" -> json(TestData.text("threadStreamItem.snapshot.json"))
                    "/ws" -> MockResponse().withWebSocketUpgrade(FakeMachineSocket().also { peers += it })
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        server.start()
        base = server.url("/").toString()
    }

    @After
    fun tearDown() {
        engine?.shutdown()
        server.shutdown()
        dir.deleteRecursively()
    }

    private inner class FakeMachineSocket : WebSocketListener() {
        @Volatile var socket: WebSocket? = null

        override fun onOpen(webSocket: WebSocket, response: Response) {
            socket = webSocket
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            val element = WireJson.parseToJsonElement(text)
            val messages = if (element is kotlinx.serialization.json.JsonArray) element.map { it.jsonObject } else listOf(element.jsonObject)
            for (message in messages) handle(webSocket, message)
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(1000, null)
        }

        private fun handle(webSocket: WebSocket, message: JsonObject) {
            when (message["_tag"]?.jsonPrimitive?.content) {
                "Ping" -> webSocket.send("""{"_tag":"Pong"}""")
                "Request" -> {
                    val id = message.getValue("id").jsonPrimitive.content
                    val tag = message.getValue("tag").jsonPrimitive.content
                    val payload = message["payload"] as? JsonObject ?: JsonObject(emptyMap())
                    calls += tag to payload
                    when (tag) {
                        "server.getConfig" -> {
                            val environment = descriptor.replace("\"env-1\"", "\"$configEnvironmentId\"")
                            exit(webSocket, id, """{"environment":$environment,"providers":[]$configExtra}""")
                        }
                        "orchestration.subscribeShell" -> {
                            shellStreams += this to id
                            chunk(webSocket, id, """[{"kind":"synchronized"}]""")
                        }
                        "orchestration.subscribeThread" -> chunk(webSocket, id, TestData.text("threadEvents.json"))
                        "orchestration.dispatchCommand" -> exit(webSocket, id, """{"sequence":300}""")
                        else -> exit(webSocket, id, "null")
                    }
                }
            }
        }

        /** Ends a request with the server's authorization failure. */
        fun failAuthorization(id: String) {
            socket?.send(
                """{"_tag":"Exit","requestId":"$id","exit":{"_tag":"Failure","cause":[{"_tag":"Fail","error":""" +
                    """{"_tag":"EnvironmentAuthorizationError","message":"The token was revoked.","requiredScope":"orchestration:read"}}]}}""",
            )
        }

        private fun exit(webSocket: WebSocket, id: String, value: String) {
            webSocket.send("""{"_tag":"Exit","requestId":"$id","exit":{"_tag":"Success","value":$value}}""")
        }

        private fun chunk(webSocket: WebSocket, id: String, values: String) {
            webSocket.send("""{"_tag":"Chunk","requestId":"$id","values":$values}""")
        }
    }

    private suspend fun <T> eventually(timeoutMillis: Long = 10_000, check: () -> T?): T = withTimeout(timeoutMillis) {
        while (true) {
            check()?.let { return@withTimeout it }
            delay(20)
        }
        @Suppress("UNREACHABLE_CODE")
        error("unreachable")
    }

    /** A Connect account whose Clerk session can end, the way the hosted one clears it on a 401. */
    private class FakeAccount : ConnectAccount {
        @Volatile var session = true
        @Volatile var expired = false

        override fun isSignedIn(): Boolean = session

        override suspend fun signIn() {
            session = true
        }

        override suspend fun signOut() {
            session = false
        }

        override suspend fun sessionToken(refresh: Boolean): String? {
            if (expired) session = false
            return if (session) "jwt" else null
        }
    }

    private lateinit var registry: MachineRegistry
    private lateinit var credentials: InMemoryCredentialStore
    private val directRoute: MachineRoute get() = MachineRoute(base, base.replaceFirst("http", "ws"))
    /** The same fake machine under another host name, as the relay tunnel would reach it. */
    private val connectRoute: MachineRoute get() {
        val other = if ("localhost" in base) base.replace("localhost", "127.0.0.1") else base.replace(Regex("//[^:/]+"), "//localhost")
        return MachineRoute(other, other.replaceFirst("http", "ws"), issuer = ConnectAuthorizer.ISSUER)
    }

    private fun start(
        direct: Boolean = true,
        viaConnect: Boolean = false,
        account: ConnectAccount? = null,
    ): Pair<LiveEngine, AppModel> = runBlocking {
        registry = MachineRegistry(File(dir, "machines.json"))
        val route = directRoute
        if (direct) registry.recordPairing("env-1", "M4", route)
        if (viaConnect) registry.recordConnect("env-1", "M4", connectRoute)
        credentials = InMemoryCredentialStore().apply {
            save(MachineCredential("tok-1", Instant.now().plusSeconds(86_400), listOf("orchestration:read", "orchestration:operate")), "env-1", route.address)
        }
        val configuration = MachineConnection.Configuration(retry = RetryPolicy(baseDelayMillis = 20, maxDelayMillis = 100))
        val http = MachineHttp()
        val connect = account?.let {
            ConnectRuntime(ConnectConfig("pk_test_x", base.trimEnd('/')), it, InMemoryDpopKeyStore(), credentials, http, "device-1", "Test phone")
        }
        val live = LiveEngine(registry, credentials, "Test phone", http = http, configuration = configuration, connect = connect)
        engine = live
        val model = AppModel(live)
        live.setActive(true)
        live to model
    }

    private fun payloads(tag: String) = calls.filter { it.first == tag }.map { it.second }

    private fun JsonElement?.int(): Int? = (this as? JsonPrimitive)?.content?.toIntOrNull()

    @Test
    fun shellSnapshotThenSubscribeFromItsSequence() = runBlocking {
        val (_, model) = start()
        val state = eventually { model.value.takeIf { it.projects.isNotEmpty() && !it.isLoading } }
        assertEquals(MachineStatus.Connected, state.machines.single().status)
        assertEquals("SpecWeave", state.projects.single().title)
        assertEquals(listOf("thr_1"), state.recentThreads.map { it.ref.threadId })
        assertTrue("GET /api/orchestration/shell" in requests)
        // The stream resumes after the HTTP snapshot instead of sending it again.
        val subscribe = eventually { payloads("orchestration.subscribeShell").firstOrNull() }
        assertEquals(42, subscribe["afterSequence"].int())
        // The server did not offer the completion marker, so none is asked for.
        assertNull(subscribe["requestCompletionMarker"])
        assertTrue(payloads("server.getConfig").isNotEmpty())
        eventually { model.value.machines.singleOrNull()?.takeIf { !it.isStale } }
        Unit
    }

    @Test
    fun threadSnapshotEventsAndSendWithStableCommandId() = runBlocking {
        val (live, model) = start()
        eventually { model.value.takeIf { it.recentThreads.isNotEmpty() } }
        val target = ChatTarget.Thread(ThreadRef("env-1", "thr_1"))
        val session = model.session(target)
        model.openSession(session)
        val chat = eventually { session.value.takeIf { it.isLoaded && it.rows.map { r -> r.id } == listOf("thr_1/ti_1", "thr_1/ti_asst") } }
        assertTrue(chat.isRunning)
        // The fixture events rename the thread; the title follows the projection.
        assertEquals("Fix login flow", chat.title)
        val subscribe = eventually { payloads("orchestration.subscribeThread").firstOrNull() }
        assertEquals("thr_1", (subscribe["threadId"] as JsonPrimitive).content)
        assertEquals(99, subscribe["afterSequence"].int())
        // No history paging in the app: the full snapshot, never a bounded window.
        assertNull(subscribe["acceptBoundedSnapshot"])
        assertNull(subscribe["requestCompletionMarker"])

        live.send("Ship it", target = target)
        val dispatch = eventually { payloads("orchestration.dispatchCommand").firstOrNull { (it["type"] as? JsonPrimitive)?.content == "message.dispatch" } }
        assertEquals("thr_1", (dispatch["threadId"] as JsonPrimitive).content)
        assertEquals("Ship it", (dispatch["text"] as JsonPrimitive).content)
        assertNotNull(dispatch["commandId"])
        assertNotNull(dispatch["messageId"])
        // The run is active, so the message queues behind it.
        assertEquals("queue_after_active", dispatch["dispatchMode"]?.jsonObject?.get("type")?.jsonPrimitive?.content)
        // Shown as sending until the machine echoes it.
        assertTrue(session.value.rows.any { it.kind == TranscriptRow.Kind.User("Ship it", UserMessageState.Sending) })
        model.closeSession(session)
    }

    @Test
    fun reconnectTakesAFreshSnapshotAndResubscribes() = runBlocking {
        val (_, model) = start()
        eventually { model.value.takeIf { it.projects.isNotEmpty() } }
        eventually { payloads("orchestration.subscribeShell").firstOrNull() }
        val first = peers.first()
        first.socket?.close(1001, "going away")
        eventually { payloads("orchestration.subscribeShell").takeIf { it.size >= 2 } }
        assertTrue(requests.count { it == "GET /api/orchestration/shell" } >= 2)
        eventually { model.value.machines.singleOrNull()?.takeIf { it.status == MachineStatus.Connected } }
        Unit
    }

    @Test
    fun markerFlagsAreSentOnlyWhenTheServerOffersThem() = runBlocking {
        configExtra = ""","shellResumeCompletionMarker":true,"threadResumeCompletionMarker":true"""
        val (_, model) = start()
        eventually { model.value.takeIf { it.recentThreads.isNotEmpty() } }
        val shell = eventually { payloads("orchestration.subscribeShell").firstOrNull() }
        assertEquals("true", shell["requestCompletionMarker"].toString())
        val session = model.session(ChatTarget.Thread(ThreadRef("env-1", "thr_1")))
        model.openSession(session)
        val thread = eventually { payloads("orchestration.subscribeThread").firstOrNull() }
        assertEquals("true", thread["requestCompletionMarker"].toString())
        model.closeSession(session)
    }

    @Test
    fun aServerThatResolvesCommandContextPicksTheDeliveryMode() = runBlocking {
        capabilities = """{"connectionProbe":true,"serverResolvedCommandContext":true}"""
        val (live, model) = start()
        eventually { model.value.takeIf { it.recentThreads.isNotEmpty() } }
        val target = ChatTarget.Thread(ThreadRef("env-1", "thr_1"))
        val session = model.session(target)
        model.openSession(session)
        eventually { session.value.takeIf { it.isLoaded && it.isRunning } }
        live.send("Ship it", target = target)
        val dispatch = eventually { payloads("orchestration.dispatchCommand").firstOrNull { (it["type"] as? JsonPrimitive)?.content == "message.dispatch" } }
        assertEquals("start_immediately", dispatch["dispatchMode"]?.jsonObject?.get("type")?.jsonPrimitive?.content)
        assertEquals("auto", dispatch["deliveryIntent"]?.jsonPrimitive?.content)
        model.closeSession(session)
    }

    @Test
    fun aConfigFromAnotherEnvironmentDropsTheSocket() = runBlocking {
        configEnvironmentId = "env-other"
        val (_, model) = start()
        eventually { payloads("server.getConfig").takeIf { it.size >= 2 } }
        // Never subscribed, never showed the other machine's projects.
        assertTrue(payloads("orchestration.subscribeShell").isEmpty())
        assertTrue("GET /api/orchestration/shell" !in requests)
        assertTrue(model.value.projects.isEmpty())
        Unit
    }

    @Test
    fun aRevokedPairingIsNoticedWhileTheSocketStaysOpen() = runBlocking {
        val (_, model) = start()
        eventually { model.value.machines.singleOrNull()?.takeIf { it.status == MachineStatus.Connected } }
        val (peer, id) = eventually { shellStreams.lastOrNull() }
        // The machine revokes the phone and fails the open stream; the socket itself stays up.
        revoked = true
        peer.failAuthorization(id)
        eventually { model.value.machines.singleOrNull()?.takeIf { it.status == MachineStatus.NeedsRepair } }
        Unit
    }

    @Test
    fun addingAHeldMachineAgainKeepsItsOneConnection() = runBlocking {
        val (live, model) = start()
        eventually { model.value.machines.singleOrNull() }
        val held = withContext(live.engineDispatcher) { live.machines.getValue("env-1") }
        withContext(live.engineDispatcher) { live.addMachine(held.record.copy(label = "Stale copy")) }
        val after = withContext(live.engineDispatcher) { live.machines.values.toList() }
        assertEquals(1, after.size)
        assertSame(held, after.single())
        assertEquals("M4", after.single().record.label)
    }

    @Test
    fun signingOutDropsConnectFromMachinesAlsoPairedDirectly() = runBlocking {
        val account = FakeAccount()
        val (live, model) = start(direct = true, viaConnect = true, account = account)
        eventually { model.value.machines.singleOrNull()?.takeIf { it.status == MachineStatus.Connected } }
        // A Connect session token cached from an earlier sign-in.
        credentials.save(MachineCredential("connect-tok", Instant.now().plusSeconds(86_400), emptyList()), "env-1", ConnectAuthorizer.ISSUER)
        live.connectSignOut()
        assertNull(registry.machine("env-1")?.connectRoute)
        assertEquals(Instant.EPOCH, credentials.credential("env-1", ConnectAuthorizer.ISSUER)?.expiresAt)
        val record = withContext(live.engineDispatcher) { live.machines.getValue("env-1").record }
        assertNull(record.connectRoute)
        val machine = eventually { model.value.machines.singleOrNull()?.takeIf { it.status == MachineStatus.Connected } }
        assertEquals(false, machine.viaConnect)
        assertEquals(false, machine.needsSignIn)
        assertEquals(directRoute.address, machine.address)
    }

    @Test
    fun anEndedClerkSessionAsksToSignInInsteadOfPairingAgain() = runBlocking {
        val account = FakeAccount()
        val (live, model) = start(direct = false, viaConnect = true, account = account)
        // Signed in at launch; the relay is not reachable yet, so the machine keeps retrying.
        eventually { model.value.machines.singleOrNull() }
        assertTrue(live.connect!!.isSignedIn())
        // The Clerk session ends elsewhere: the next relay call finds no session token.
        account.expired = true
        live.reconnect("env-1")
        val machine = eventually { model.value.machines.singleOrNull()?.takeIf { it.needsSignIn } }
        assertEquals(true, machine.viaConnect)
        assertEquals(false, live.connect!!.isSignedIn())
    }
}
