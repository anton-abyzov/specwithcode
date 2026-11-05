package com.specwithcode.transport

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.ReceiveChannel
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.cancellation.CancellationException

/** An open WebSocket that carries text frames. */
interface WebSocketConnection {
    /**
     * Text frames in arrival order. The channel closes with [TransportException.Closed] when the
     * socket closes, or with another [TransportException] when it fails.
     */
    val frames: ReceiveChannel<String>

    /** Queues one text frame. False when the socket is closed or closing. */
    fun send(text: String): Boolean

    fun close()
}

/**
 * Opens sockets. Returns only after the upgrade succeeded; a refused upgrade throws
 * [TransportException.UpgradeFailed], a network failure [TransportException.Unreachable] or
 * [TransportException.TimedOut].
 */
fun interface WebSocketConnector {
    /** [url] is a `ws://` or `wss://` URL. It carries the ticket, so it is never logged. */
    suspend fun connect(url: String): WebSocketConnection
}

/** OkHttp sockets with no subprotocol, cookies or auth header: the ticket in the URL is the only credential. */
class OkHttpWebSocketConnector(
    client: OkHttpClient = OkHttpTransport.defaultClient(),
    private val openTimeoutMillis: Long = 15_000,
) : WebSocketConnector {
    // Keepalive is the RPC layer's Ping, so OkHttp's own pings stay off.
    private val client = client.newBuilder().pingInterval(0, TimeUnit.MILLISECONDS).build()

    override suspend fun connect(url: String): WebSocketConnection {
        val opened = CompletableDeferred<Unit>()
        val frames = Channel<String>(Channel.UNLIMITED)
        val listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                opened.complete(Unit)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                frames.trySend(text)
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                frames.trySend(bytes.utf8())
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
                frames.close(TransportException.Closed())
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                frames.close(TransportException.Closed())
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                val error: TransportException = when {
                    response != null && response.code != 101 -> TransportException.UpgradeFailed(response.code)
                    t is IOException -> TransportException.fromIo(t)
                    else -> TransportException.Unreachable(t.javaClass.simpleName)
                }
                opened.completeExceptionally(error)
                frames.close(error)
            }
        }
        val request = try {
            Request.Builder().url(url).build()
        } catch (_: IllegalArgumentException) {
            throw TransportException.InvalidAddress("socket")
        }
        val socket = client.newWebSocket(request, listener)
        try {
            withTimeout(openTimeoutMillis) { opened.await() }
        } catch (e: TimeoutCancellationException) {
            socket.cancel()
            throw TransportException.TimedOut()
        } catch (e: CancellationException) {
            socket.cancel()
            throw e
        } catch (e: TransportException) {
            socket.cancel()
            throw e
        }
        return OkHttpWebSocketConnection(socket, frames)
    }
}

private class OkHttpWebSocketConnection(private val socket: WebSocket, override val frames: Channel<String>) : WebSocketConnection {
    override fun send(text: String): Boolean = socket.send(text)

    override fun close() {
        if (!socket.close(1000, null)) socket.cancel()
        frames.close(TransportException.Closed())
    }
}
