package com.specwithcode.transport

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import com.specwithcode.wire.WireJson
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/** A descriptor body as `/.well-known/studio/environment` sends it. */
fun descriptorJson(environmentId: String = "env-1", label: String = "M4", protocol: Int? = 2): String {
    val version = protocol?.let { ""","orchestrationProtocolVersion":$it""" } ?: ""
    return """{"environmentId":"$environmentId","label":"$label","platform":{"os":"darwin","arch":"arm64"},"serverVersion":"1.0.0"$version,"capabilities":{"connectionProbe":true}}"""
}

fun json(body: String, status: Int = 200): MockResponse =
    MockResponse().setResponseCode(status).setHeader("Content-Type", "application/json").setBody(body)

/** The server's half of a WebSocket opened against a [MockWebServer]. */
class ServerSocket : WebSocketListener() {
    val received = LinkedBlockingQueue<String>()
    private val opened = CountDownLatch(1)
    val closedLatch = CountDownLatch(1)

    @Volatile
    lateinit var socket: WebSocket

    override fun onOpen(webSocket: WebSocket, response: Response) {
        socket = webSocket
        opened.countDown()
    }

    override fun onMessage(webSocket: WebSocket, text: String) {
        received.put(text)
    }

    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
        webSocket.close(1000, null)
        closedLatch.countDown()
    }

    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
        closedLatch.countDown()
    }

    fun awaitOpen(): ServerSocket {
        check(opened.await(5, TimeUnit.SECONDS)) { "socket did not open" }
        return this
    }

    /** The next message from the client, as JSON. */
    suspend fun next(timeoutMillis: Long = 5_000): JsonObject {
        // Off the test thread, so coroutines started with runBlocking keep running meanwhile.
        val text = withContext(Dispatchers.IO) { received.poll(timeoutMillis, TimeUnit.MILLISECONDS) } ?: error("no message from the client")
        return WireJson.parseToJsonElement(text).jsonObject
    }

    /** The next message whose `_tag` is not `Ping`. */
    suspend fun nextNonPing(timeoutMillis: Long = 5_000): JsonObject {
        while (true) {
            val message = next(timeoutMillis)
            if (message["_tag"].toString() != "\"Ping\"") return message
        }
    }

    fun send(text: String) = check(socket.send(text))

    fun upgrade(): MockResponse = MockResponse().withWebSocketUpgrade(this)
}

/** A [CredentialStore] that throws, like storage before the first unlock. */
class FailingCredentialStore : CredentialStore {
    override fun credential(environmentId: String, issuer: String): MachineCredential? = error("locked")
    override fun save(credential: MachineCredential, environmentId: String, issuer: String) = error("locked")
    override fun remove(environmentId: String) = error("locked")
}
