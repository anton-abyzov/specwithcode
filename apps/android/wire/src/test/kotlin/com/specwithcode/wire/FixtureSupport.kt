package com.specwithcode.wire

import kotlinx.serialization.KSerializer
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.serializer

/** Reads the shared fixtures under `src/test/resources/fixtures`. */
object Fixture {
    fun text(name: String): String {
        val stream = Fixture::class.java.getResourceAsStream("/fixtures/$name") ?: error("Missing fixture $name")
        return stream.use { it.readBytes().toString(Charsets.UTF_8) }
    }

    fun json(name: String): JsonElement = WireJson.parseToJsonElement(text(name))

    fun <T> decode(serializer: KSerializer<T>, name: String): T = WireJson.decodeFromString(serializer, text(name))

    inline fun <reified T> decode(name: String): T = decode(serializer<T>(), name)

    fun <T> decodeList(serializer: KSerializer<T>, name: String): List<T> = decode(ListSerializer(serializer), name)

    /** Non-empty lines of a `.jsonl` fixture, parsed. */
    fun lines(name: String): List<JsonElement> =
        text(name).split('\n').filter { it.isNotBlank() }.map { WireJson.parseToJsonElement(it) }
}

inline fun <reified T> decodeJSON(json: String): T = WireJson.decodeFromString(serializer<T>(), json)

inline fun <reified T> encodeToJSON(value: T): JsonElement = WireJson.encodeToJsonElement(serializer<T>(), value)

fun parse(json: String): JsonElement = WireJson.parseToJsonElement(json)

/** Removes null members, so models that leave null keys out compare equal to server output that writes them as null. */
fun stripNulls(value: JsonElement): JsonElement = when (value) {
    is JsonObject -> JsonObject(value.filterValues { it !is JsonNull }.mapValues { stripNulls(it.value) })
    is JsonArray -> JsonArray(value.map(::stripNulls))
    else -> value
}

fun obj(vararg pairs: Pair<String, JsonElement>): JsonObject = JsonObject(mapOf(*pairs))
