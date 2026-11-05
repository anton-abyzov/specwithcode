package com.specwithcode.transport

import com.specwithcode.wire.RpcClientMessage
import com.specwithcode.wire.RpcClientMessageSerializer
import com.specwithcode.wire.RpcExit
import com.specwithcode.wire.RpcMethod
import com.specwithcode.wire.RpcRequestId
import com.specwithcode.wire.RpcServerMessage
import com.specwithcode.wire.RpcServerMessageSerializer
import com.specwithcode.wire.ServerError
import com.specwithcode.wire.WireJson
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.serializer
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.cancellation.CancellationException

/** One chunk of a stream. [ack] tells the server to send the next one; calling it again does nothing. */
class RpcChunk internal constructor(
    val requestId: RpcRequestId,
    val values: List<JsonElement>,
    private val sendAck: () -> Unit,
) {
    private val acked = AtomicBoolean(false)

    fun ack() {
        if (acked.compareAndSet(false, true)) sendAck()
    }
}

/**
 * Effect RPC over one WebSocket (`RpcSerialization.layerJson`): unary calls, acked streams and
 * keepalive. One JSON message per text frame out; an object or a batch array in.
 *
 * Request ids are JSON integers counting from 0 per socket, as the TypeScript client sends them.
 * A socket never resumes: when it closes, every pending request fails with
 * [TransportException.Closed] and the supervisor opens a new one.
 */
class RpcSocket(
    val connection: WebSocketConnection,
    val configuration: Configuration = Configuration(),
    dispatcher: CoroutineDispatcher = Dispatchers.Default,
) {
    data class Configuration(
        /** A unary call without an answer by then fails with [TransportException.TimedOut] and is interrupted. */
        val callTimeoutMillis: Long = 30_000,
        val pingIntervalMillis: Long = 5_000,
        /** Consecutive unanswered pings before the socket is closed. */
        val maxMissedPongs: Int = 3,
    )

    sealed interface CloseReason {
        data object Requested : CloseReason
        data object PingTimeout : CloseReason

        /** The server sent a socket-level `Defect`. */
        data object Defect : CloseReason

        data class ConnectionLost(val detail: String) : CloseReason
    }

    private sealed interface Pending {
        class Call(val result: CompletableDeferred<JsonElement>) : Pending
        class Stream(val chunks: Channel<RpcChunk>) : Pending
    }

    private val scope = CoroutineScope(SupervisorJob() + dispatcher)
    private val lock = Any()
    private val pending = HashMap<RpcRequestId, Pending>()
    private var nextId: RpcRequestId = 0
    private var awaitingPong = false
    private var missedPongs = 0
    private val started = AtomicBoolean(false)
    private val closed = CompletableDeferred<CloseReason>()

    /** Set once the socket is closed. */
    @Volatile
    var closeReason: CloseReason? = null
        private set

    val isClosed: Boolean get() = closeReason != null

    /** Starts reading and pinging. Calls and streams start it too. */
    fun start() {
        if (closeReason != null || !started.compareAndSet(false, true)) return
        scope.launch {
            try {
                for (text in connection.frames) handle(decode(text))
                finish(CloseReason.ConnectionLost("Closed"))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                finish(CloseReason.ConnectionLost(e.toString()))
            }
        }
        scope.launch {
            while (isActive) {
                delay(configuration.pingIntervalMillis)
                if (!pingTick()) break
            }
        }
    }

    /**
     * A unary call. Throws [ServerError] for a failed exit, [TransportException.TimedOut] after
     * the call timeout, and [TransportException.Closed] if the socket closes first. Cancelling
     * the caller sends an Interrupt.
     */
    suspend fun call(tag: String, payload: JsonElement = JsonObject(emptyMap())): JsonElement {
        start()
        val result = CompletableDeferred<JsonElement>()
        val id = register(Pending.Call(result))
        send(RpcClientMessage.Request(id, tag, payload))
        try {
            return withTimeout(configuration.callTimeoutMillis) { result.await() }
        } catch (e: TimeoutCancellationException) {
            if (unregister(id) != null) send(RpcClientMessage.Interrupt(id))
            throw TransportException.TimedOut()
        } catch (e: CancellationException) {
            if (unregister(id) != null) send(RpcClientMessage.Interrupt(id))
            throw e
        }
    }

    /**
     * A streaming call. Each chunk's values are emitted, then acked once the collector has
     * processed them. The flow completes on a successful exit, throws [ServerError] on a failed
     * one and [TransportException.Closed] when the socket closes. Stopping collection early
     * sends an Interrupt.
     */
    fun stream(tag: String, payload: JsonElement = JsonObject(emptyMap())): Flow<List<JsonElement>> = flow {
        start()
        val chunks = Channel<RpcChunk>(Channel.UNLIMITED)
        val id = register(Pending.Stream(chunks))
        send(RpcClientMessage.Request(id, tag, payload))
        var finished = false
        try {
            for (chunk in chunks) {
                emit(chunk.values)
                chunk.ack()
            }
            finished = true
        } finally {
            if (!finished && unregister(id) != null) send(RpcClientMessage.Interrupt(id))
        }
    }

    /** Closes the socket and fails everything pending with [TransportException.Closed]. */
    fun close() = finish(CloseReason.Requested)

    /** Waits until the socket closes. */
    suspend fun awaitClose(): CloseReason = closed.await()

    // Internals

    private fun register(entry: Pending): RpcRequestId = synchronized(lock) {
        if (closeReason != null) throw TransportException.Closed()
        val id = nextId++
        pending[id] = entry
        id
    }

    private fun unregister(id: RpcRequestId): Pending? = synchronized(lock) { pending.remove(id) }

    private fun send(message: RpcClientMessage) {
        if (closeReason != null) return
        val text = WireJson.encodeToString(RpcClientMessageSerializer, message)
        if (!connection.send(text)) finish(CloseReason.ConnectionLost("Send failed"))
    }

    private fun handle(messages: List<RpcServerMessage>) {
        for (message in messages) {
            when (message) {
                RpcServerMessage.Pong -> synchronized(lock) {
                    awaitingPong = false
                    missedPongs = 0
                }
                is RpcServerMessage.Chunk -> {
                    val entry = synchronized(lock) { pending[message.requestId] } as? Pending.Stream ?: continue
                    val id = message.requestId
                    entry.chunks.trySend(RpcChunk(id, message.values) { send(RpcClientMessage.Ack(id)) })
                }
                is RpcServerMessage.Exit -> {
                    val entry = unregister(message.requestId) ?: continue
                    when (entry) {
                        is Pending.Call -> when (val exit = message.exit) {
                            is RpcExit.Success -> entry.result.complete(exit.value)
                            is RpcExit.Failure -> entry.result.completeExceptionally(ServerError.from(exit.causes))
                        }
                        is Pending.Stream -> when (val exit = message.exit) {
                            is RpcExit.Success -> entry.chunks.close()
                            is RpcExit.Failure -> entry.chunks.close(ServerError.from(exit.causes))
                        }
                    }
                }
                // A defect is not tied to a request: the protocol state is unknown, so start over.
                is RpcServerMessage.Defect -> finish(CloseReason.Defect)
                is RpcServerMessage.Unknown -> Unit
            }
        }
    }

    private fun pingTick(): Boolean {
        val dead = synchronized(lock) {
            if (closeReason != null) return false
            if (awaitingPong) missedPongs++ else missedPongs = 0
            awaitingPong = true
            missedPongs >= configuration.maxMissedPongs
        }
        if (dead) {
            finish(CloseReason.PingTimeout)
            return false
        }
        send(RpcClientMessage.Ping)
        return true
    }

    private fun finish(reason: CloseReason) {
        val entries = synchronized(lock) {
            if (closeReason != null) return
            closeReason = reason
            pending.values.toList().also { pending.clear() }
        }
        connection.close()
        for (entry in entries) {
            when (entry) {
                is Pending.Call -> entry.result.completeExceptionally(TransportException.Closed())
                is Pending.Stream -> entry.chunks.close(TransportException.Closed())
            }
        }
        closed.complete(reason)
        scope.cancel()
    }

    companion object {
        /** Decodes one frame into server messages. Accepts one message or a batch; unreadable items are dropped. */
        fun decode(text: String): List<RpcServerMessage> {
            val element = try {
                WireJson.parseToJsonElement(text)
            } catch (_: IllegalArgumentException) {
                return emptyList()
            }
            val items = if (element is JsonArray) element else listOf(element)
            return items.mapNotNull {
                try {
                    WireJson.decodeFromJsonElement(RpcServerMessageSerializer, it)
                } catch (_: IllegalArgumentException) {
                    null
                }
            }
        }
    }
}

/** A typed unary call. */
suspend fun <P, R> RpcSocket.call(method: RpcMethod, payload: P, payloadSerializer: KSerializer<P>, resultSerializer: KSerializer<R>): R {
    val result = call(method.tag, WireJson.encodeToJsonElement(payloadSerializer, payload))
    return try {
        WireJson.decodeFromJsonElement(resultSerializer, result)
    } catch (e: IllegalArgumentException) {
        throw TransportException.InvalidResponse(e.javaClass.simpleName)
    }
}

suspend inline fun <reified P, reified R> RpcSocket.call(method: RpcMethod, payload: P): R =
    call(method, payload, serializer<P>(), serializer<R>())
