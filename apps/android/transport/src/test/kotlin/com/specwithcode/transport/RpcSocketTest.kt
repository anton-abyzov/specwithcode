package com.specwithcode.transport

import com.specwithcode.wire.ServerError
import com.specwithcode.wire.intValue
import com.specwithcode.wire.stringValue
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Before
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

class RpcSocketTest {
    private val server = MockWebServer()
    private lateinit var peer: ServerSocket

    @Before
    fun setUp() {
        peer = ServerSocket()
        server.enqueue(peer.upgrade())
        server.start()
    }

    @After
    fun tearDown() = server.shutdown()

    private suspend fun open(configuration: RpcSocket.Configuration = RpcSocket.Configuration(pingIntervalMillis = 60_000)): RpcSocket {
        val url = server.url("/ws").toString().replaceFirst("http", "ws") + "?wsTicket=t&orchestrationProtocol=2"
        val socket = RpcSocket(OkHttpWebSocketConnector().connect(url), configuration)
        socket.start()
        peer.awaitOpen()
        return socket
    }

    private fun JsonObject.tag() = this["_tag"]!!.jsonPrimitive.content
    private fun JsonObject.int(key: String) = this[key].intValue

    @Test
    fun opensTheSocketWithTheTicketAndNoHeaders() = runBlocking {
        open()
        val request = server.takeRequest(5, TimeUnit.SECONDS)!!
        assertEquals("/ws?wsTicket=t&orchestrationProtocol=2", request.path)
        assertNull(request.getHeader("Authorization"))
        assertNull(request.getHeader("Cookie"))
        assertNull(request.getHeader("Sec-WebSocket-Protocol"))
    }

    @Test
    fun idsCountFromZeroAndAnswersFindTheirCall() = runBlocking {
        val socket = open()
        val first = async { socket.call("server.getConfig") }
        val second = async { socket.call("server.probe", JsonObject(mapOf("x" to JsonPrimitive(1)))) }
        val requests = listOf(peer.nextNonPing(), peer.nextNonPing()).sortedBy { it.int("id") }
        assertEquals(listOf(0, 1), requests.map { it.int("id") })
        assertTrue(requests.all { it.tag() == "Request" && it["headers"].toString() == "[]" })
        val probe = requests.first { it["tag"].stringValue == "server.probe" }
        val config = requests.first { it["tag"].stringValue == "server.getConfig" }
        assertEquals("{}", config["payload"].toString())
        // Answer out of order; the second answer uses a string id.
        peer.send("""{"_tag":"Exit","requestId":"${probe.int("id")}","exit":{"_tag":"Success","value":{"ok":true}}}""")
        peer.send("""{"_tag":"Exit","requestId":${config.int("id")},"exit":{"_tag":"Success","value":{"v":1}}}""")
        assertEquals("""{"v":1}""", first.await().toString())
        assertEquals("""{"ok":true}""", second.await().toString())
    }

    @Test
    fun streamsAckEachChunkAfterItIsProcessed() = runBlocking {
        val socket = open()
        val seen = CopyOnWriteArrayList<String>()
        val collector = launch {
            socket.stream("orchestration.subscribeShell", JsonObject(mapOf("afterSequence" to JsonPrimitive(4)))).collect { values ->
                seen += values.map { it.toString() }
            }
        }
        val request = peer.nextNonPing()
        assertEquals("orchestration.subscribeShell", request["tag"].stringValue)
        assertEquals("""{"afterSequence":4}""", request["payload"].toString())
        val id = request.int("id")
        peer.send("""{"_tag":"Chunk","requestId":$id,"values":[{"kind":"synchronized"},{"kind":"x"}]}""")
        val ack = peer.nextNonPing()
        assertEquals("Ack", ack.tag())
        assertEquals(id, ack.int("requestId"))
        // A batch frame carries two messages.
        peer.send("""[{"_tag":"Chunk","requestId":$id,"values":[{"n":3}]},{"_tag":"Pong"}]""")
        assertEquals("Ack", peer.nextNonPing().tag())
        peer.send("""{"_tag":"Exit","requestId":$id,"exit":{"_tag":"Success","value":null}}""")
        withTimeout(5_000) { collector.join() }
        assertEquals(listOf("""{"kind":"synchronized"}""", """{"kind":"x"}""", """{"n":3}"""), seen)
        assertTrue(peer.received.isEmpty() || peer.received.all { it.contains("Ping") })
    }

    @Test
    fun endingAStreamEarlySendsInterrupt() = runBlocking {
        val socket = open()
        val first = async { socket.stream("orchestration.subscribeThread").take(1).toList() }
        val id = peer.nextNonPing().int("id")
        peer.send("""{"_tag":"Chunk","requestId":$id,"values":[1]}""")
        assertEquals(1, first.await().size)
        val next = peer.nextNonPing()
        // The consumer stopped inside emit, so no ack goes out for that chunk; the stream is interrupted.
        assertEquals("Interrupt", next.tag())
        assertEquals(id, next.int("requestId"))
    }

    @Test
    fun cancellingACallSendsInterrupt() = runBlocking {
        val socket = open()
        val job = launch { socket.call("orchestration.getThreadProjection") }
        val id = peer.nextNonPing().int("id")
        job.cancelAndJoin()
        val interrupt = peer.nextNonPing()
        assertEquals("Interrupt", interrupt.tag())
        assertEquals(id, interrupt.int("requestId"))
    }

    @Test
    fun typedFailuresBecomeServerErrors() = runBlocking {
        val socket = open()
        val call = async { runCatching { socket.call("orchestration.dispatchCommand") } }
        val id = peer.nextNonPing().int("id")
        peer.send(
            """{"_tag":"Exit","requestId":$id,"exit":{"_tag":"Failure","cause":[{"_tag":"Fail","error":{"_tag":"EnvironmentAuthorizationError","message":"Needs operate","requiredScope":"orchestration:operate"}}]}}""",
        )
        val error = call.await().exceptionOrNull()
        assertIs<ServerError>(error)
        val stream = async { runCatching { socket.stream("orchestration.subscribeThread").toList() } }
        val streamId = peer.nextNonPing().int("id")
        peer.send("""{"_tag":"Exit","requestId":$streamId,"exit":{"_tag":"Failure","cause":[{"_tag":"Die","defect":"boom"}]}}""")
        assertIs<ServerError>(stream.await().exceptionOrNull())
        assertTrue(!socket.isClosed)
    }

    @Test
    fun unansweredCallTimesOutAndIsInterrupted() = runBlocking {
        val socket = open(RpcSocket.Configuration(callTimeoutMillis = 200, pingIntervalMillis = 60_000))
        assertFailsWith<TransportException.TimedOut> { socket.call("server.getConfig") }
        assertEquals("Request", peer.nextNonPing().tag())
        assertEquals("Interrupt", peer.nextNonPing().tag())
    }

    @Test
    fun missedPongsCloseTheSocket() = runBlocking {
        val socket = open(RpcSocket.Configuration(pingIntervalMillis = 100, maxMissedPongs = 3))
        val pending = async { runCatching { socket.call("server.getConfig") } }
        assertEquals(RpcSocket.CloseReason.PingTimeout, withTimeout(5_000) { socket.awaitClose() })
        assertIs<TransportException.Closed>(pending.await().exceptionOrNull())
        var pings = 0
        while (true) {
            val text = peer.received.poll() ?: break
            if (text == """{"_tag":"Ping"}""") pings++
        }
        assertEquals(3, pings)
    }

    @Test
    fun pongsKeepTheSocketOpen() = runBlocking {
        val socket = open(RpcSocket.Configuration(pingIntervalMillis = 100, maxMissedPongs = 2))
        repeat(6) {
            val ping = peer.next()
            assertEquals("Ping", ping.tag())
            peer.send("""{"_tag":"Pong"}""")
        }
        assertTrue(!socket.isClosed)
        socket.close()
    }

    @Test
    fun aDefectFailsPendingWorkAndCloses() = runBlocking {
        val socket = open()
        val pending = async { runCatching { socket.call("server.getConfig") } }
        peer.nextNonPing()
        peer.send("""{"_tag":"Defect","defect":"bad frame"}""")
        assertEquals(RpcSocket.CloseReason.Defect, withTimeout(5_000) { socket.awaitClose() })
        assertIs<TransportException.Closed>(pending.await().exceptionOrNull())
        Unit
    }

    @Test
    fun unknownAndUnreadableFramesAreIgnored() = runBlocking {
        val socket = open()
        peer.send("""{"_tag":"ClientProtocolError"}""")
        peer.send("not json")
        peer.send("""[{"_tag":"Pong"},{"nope":1}]""")
        val call = async { socket.call("server.probe") }
        val id = peer.nextNonPing().int("id")
        peer.send("""{"_tag":"Exit","requestId":$id,"exit":{"_tag":"Success","value":{}}}""")
        assertEquals("{}", call.await().toString())
        assertTrue(!socket.isClosed)
    }

    @Test
    fun aDroppedConnectionFailsEverything() = runBlocking {
        val socket = open()
        val stream = async { runCatching { socket.stream("subscribeServerConfig").first() } }
        peer.nextNonPing()
        server.shutdown()
        assertIs<RpcSocket.CloseReason.ConnectionLost>(withTimeout(5_000) { socket.awaitClose() })
        assertIs<TransportException.Closed>(stream.await().exceptionOrNull())
        assertFailsWith<TransportException.Closed> { socket.call("server.probe") }
        Unit
    }

    @Test
    fun closeFailsPendingWork() = runBlocking {
        val socket = open()
        val call = async { runCatching { socket.call("server.getConfig") } }
        peer.nextNonPing()
        socket.close()
        assertIs<TransportException.Closed>(call.await().exceptionOrNull())
        assertEquals(RpcSocket.CloseReason.Requested, socket.closeReason)
    }

    @Test
    fun aRefusedUpgradeReportsItsStatus() = runBlocking {
        server.shutdown()
        val refusing = MockWebServer()
        refusing.enqueue(
            MockResponse().setResponseCode(426).setBody("""{"code":"orchestration_protocol_incompatible","orchestrationProtocolVersion":2}"""),
        )
        refusing.start()
        try {
            val url = refusing.url("/ws").toString().replaceFirst("http", "ws")
            val error = assertFailsWith<TransportException.UpgradeFailed> { OkHttpWebSocketConnector().connect(url) }
            assertEquals(426, error.status)
        } finally {
            refusing.shutdown()
        }
    }
}
