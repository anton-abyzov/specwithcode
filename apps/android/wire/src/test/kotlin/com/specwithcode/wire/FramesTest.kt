package com.specwithcode.wire

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlin.test.fail

/**
 * Replays captured sessions with a real server. Every WebSocket frame must decode; client
 * frames must re-encode to what was sent; chunk and exit values must decode as the type
 * their request's method returns.
 */
class FramesTest {
    data class Tally(
        var sent: Int = 0,
        var reencoded: Int = 0,
        var received: Int = 0,
        var chunkValues: Int = 0,
        var exits: Int = 0,
        var http: Int = 0,
        val skipped: MutableList<String> = mutableListOf(),
    )

    data class Replay(val tally: Tally, val shellItems: List<Pair<String, ShellStreamItem>>, val exits: List<Pair<String, RpcExit>>)

    private fun idKey(id: JsonElement?): String? {
        val primitive = id as? JsonPrimitive ?: return null
        return if (primitive.isString) primitive.content else primitive.intValue?.toString()
    }

    private fun numericId(id: JsonElement?): Int? = (id as? JsonPrimitive)?.takeIf { !it.isString }?.intOrNull

    private fun replay(file: String): Replay {
        val tally = Tally()
        val tags = mutableMapOf<String, String>()
        val lastUrl = mutableMapOf<String, String>()
        val shellItems = mutableListOf<Pair<String, ShellStreamItem>>()
        val exits = mutableListOf<Pair<String, RpcExit>>()

        for (line in Fixture.lines(file)) {
            val dir = line["dir"].stringValue ?: ""
            val kind = line["kind"].stringValue ?: ""
            val session = line["label"].stringValue ?: "main"

            if (kind == "http") {
                tally.http += 1
                if (dir == "send") {
                    line["url"].stringValue?.let { lastUrl[session] = it }
                    continue
                }
                val body = line["body"]
                val url = lastUrl[session]
                if (line["status"].intValue != 200 || body == null || url == null) continue
                if (url.endsWith("/.well-known/studio/environment")) {
                    val descriptor = body.decode<EnvironmentDescriptor>()
                    assertEquals(EnvironmentDescriptor.Compatibility.Compatible, descriptor.compatibility)
                    assertEquals("Wire Probe", descriptor.label)
                } else if (url.endsWith("/api/orchestration/shell")) {
                    assertTrue(body.decode<ShellSnapshot>().schemaVersion >= 1)
                }
                continue
            }
            if (kind != "ws" || dir == "event") continue

            // Frames sent as raw text: a batch array, or deliberately malformed input.
            var frames: List<JsonElement> = emptyList()
            val data = line["data"]
            val rawText = line["raw"].stringValue
            if (data != null) {
                frames = listOf(data)
            } else if (rawText != null) {
                val parsed = try {
                    WireJson.parseToJsonElement(rawText)
                } catch (_: IllegalArgumentException) {
                    null
                }
                if (parsed == null) {
                    tally.skipped += "$file: unparseable raw frame"
                    continue
                }
                frames = (parsed as? JsonArray) ?: listOf(parsed)
            }

            for (frame in frames) {
                val tag = frame["_tag"].stringValue ?: ""
                if (dir == "send") {
                    tally.sent += 1
                    val id = idKey(frame["id"])
                    val method = frame["tag"].stringValue
                    if (tag == "Request" && id != null && method != null) tags["$session/$id"] = method
                    val message: RpcClientMessage? = when (tag) {
                        "Request" -> {
                            val numeric = numericId(frame["id"])
                            if (numeric != null && method != null) {
                                RpcClientMessage.Request(numeric, method, frame["payload"] ?: JsonObject(emptyMap()))
                            } else {
                                null
                            }
                        }
                        "Ack" -> frame["requestId"].intValue?.let { RpcClientMessage.Ack(it) }
                        "Interrupt" -> frame["requestId"].intValue?.let { RpcClientMessage.Interrupt(it) }
                        "Ping" -> RpcClientMessage.Ping
                        else -> null
                    }
                    if (message != null) {
                        assertEquals(frame, encodeToJSON(message), "$file: $tag")
                        tally.reencoded += 1
                    } else {
                        tally.skipped += "$file: sent $tag ${frame["id"] ?: ""}"
                    }
                    continue
                }

                tally.received += 1
                val requestId = frame["requestId"] as? JsonPrimitive
                if (requestId != null && requestId.isString && requestId.content.toIntOrNull() == null) {
                    // The app only sends integer ids; a string id echo cannot be routed.
                    assertFailsWith<IllegalArgumentException> { WireJson.decodeFromJsonElement(RpcServerMessage.serializer(), frame) }
                    tally.skipped += "$file: string request id ${requestId.content}"
                    continue
                }
                when (val message = WireJson.decodeFromJsonElement(RpcServerMessage.serializer(), frame)) {
                    is RpcServerMessage.Chunk -> {
                        val method = assertNotNull(tags["$session/${message.requestId}"], "No request for chunk ${message.requestId}")
                        for (value in message.values) {
                            tally.chunkValues += 1
                            when (RpcMethod.fromTag(method)) {
                                RpcMethod.SubscribeShell -> {
                                    val item = value.decode<ShellStreamItem>()
                                    if (item is ShellStreamItem.Unknown) fail("Unknown shell item ${item.kind}")
                                    shellItems += method to item
                                }
                                RpcMethod.SubscribeThread -> {
                                    val item = value.decode<ThreadStreamItem>()
                                    if (item is ThreadStreamItem.Unknown) fail("Unknown thread item")
                                }
                                RpcMethod.SubscribeServerConfig -> {
                                    val item = value.decode<ServerConfigStreamItem>()
                                    if (item is ServerConfigStreamItem.Snapshot) {
                                        assertEquals(OrchestrationProtocol.VERSION, item.config.environment.protocolVersion)
                                    }
                                }
                                else -> fail("Chunk for non-stream method $method")
                            }
                        }
                    }
                    is RpcServerMessage.Exit -> {
                        tally.exits += 1
                        val method = assertNotNull(tags["$session/${message.requestId}"], "No request for exit ${message.requestId}")
                        exits += method to message.exit
                        if (message.exit.isSuccess) {
                            when (RpcMethod.fromTag(method)) {
                                RpcMethod.ServerGetConfig -> {
                                    val config = message.exit.value<ServerConfig>()
                                    assertTrue(config.providers.isNotEmpty())
                                    assertNotNull(config.settings)
                                }
                                RpcMethod.EnsureScratch -> message.exit.value<EnsureScratchResult>()
                                RpcMethod.ServerProbe -> message.exit.value<EmptyInput>()
                                else -> Unit
                            }
                        }
                    }
                    is RpcServerMessage.Unknown -> fail("Unknown server frame ${message.tag}")
                    else -> Unit
                }
            }
        }
        return Replay(tally, shellItems, exits)
    }

    @Test fun mainSession() {
        val (tally, shellItems, exits) = replay("frames-main.jsonl")
        assertEquals(24, tally.sent)
        assertEquals(21, tally.received)
        assertEquals(9, tally.chunkValues)
        assertEquals(9, tally.exits)
        assertEquals(22, tally.reencoded)
        // Eof is not a frame the app sends; the string id request and its echo are skipped.
        assertEquals(3, tally.skipped.size, tally.skipped.toString())

        // The resolved-roots snapshot is a metadata patch.
        val patches = shellItems.filter { (it.second as? ShellStreamItem.Snapshot)?.resolvedRepositoryIdentityRoots != null }
        assertEquals(2, patches.size)
        val projectUpdates = shellItems.mapNotNull { (it.second as? ShellStreamItem.ProjectUpdated)?.project }
        assertEquals(2, projectUpdates.size)
        assertEquals("No project", projectUpdates.first().title)

        // Unsubscribing ends each of the three streams with interrupts only.
        val interrupted = exits.filter { it.second.isInterruptOnly }.map { it.first }
        assertEquals(listOf(RpcMethod.SubscribeShell, RpcMethod.SubscribeShell, RpcMethod.SubscribeServerConfig).map { it.tag }, interrupted)

        // Unknown methods and bad payloads fail as defects.
        val defects = exits.filter { !it.second.isSuccess && !it.second.isInterruptOnly }.map { (_, exit) ->
            assertFailsWith<ServerError> { exit.value<JsonElement>() }
        }
        assertTrue(defects.all { it.kind == ServerError.Kind.Defect })
        assertEquals(2, defects.size)
        assertEquals("Unknown request tag: no.such.method", defects.first().message)
    }

    @Test fun extrasSession() {
        val (tally, _, exits) = replay("frames-extras.jsonl")
        assertEquals(5, tally.received)
        assertEquals(2, tally.reencoded)
        assertEquals(3, tally.skipped.size, tally.skipped.toString())
        assertEquals(2, exits.size)
        assertTrue(exits.all { it.second.isSuccess })
        assertTrue(tally.skipped.any { "unparseable" in it })
    }

    @Test fun narrowTokenSession() {
        val (tally, _, exits) = replay("frames-narrow.jsonl")
        assertEquals(2, tally.exits)
        for ((_, exit) in exits) {
            val error = assertFailsWith<ServerError> { exit.value<ServerConfig>() }
            assertEquals(ServerError.Kind.Authorization("orchestration:read"), error.kind)
        }
        assertFalse(exits.isEmpty())
        assertIs<RpcExit.Failure>(exits.first().second)
    }
}
