package com.specwithcode.wire

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerializationException
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.descriptors.buildClassSerialDescriptor
import kotlinx.serialization.descriptors.nullable
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.serializer
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException
import java.time.temporal.ChronoUnit

// Shared wire coding. The server speaks Effect RPC over a WebSocket with the Schema
// JSON codec: one JSON value per UTF-8 text frame, `DateTimeUtc` as ISO strings with
// milliseconds, optional keys omitted (or null), extra keys ignored.

/** The one [Json] every wire type is read and written with. */
val WireJson: Json = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    coerceInputValues = true
    encodeDefaults = true
}

/** Any JSON value. Used for payloads the app does not model and for raw passthrough. */
typealias JsonValue = JsonElement

/** A member of an object, or null for anything else. */
operator fun JsonElement?.get(key: String): JsonElement? = (this as? JsonObject)?.get(key)

val JsonElement?.stringValue: String?
    get() = (this as? JsonPrimitive)?.takeIf { it.isString }?.content

val JsonElement?.intValue: Int?
    get() = (this as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull?.toInt()

val JsonElement?.boolValue: Boolean?
    get() = (this as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull

val JsonElement?.isNull: Boolean get() = this is JsonNull

val JsonElement?.arrayValue: List<JsonElement>? get() = this as? JsonArray

val JsonElement?.objectValue: Map<String, JsonElement>? get() = this as? JsonObject

/** Re-decodes a raw value as a typed model. */
inline fun <reified T> JsonElement.decode(): T = WireJson.decodeFromJsonElement(serializer<T>(), this)

/** Encodes a typed model as a raw value. */
inline fun <reified T> T.toJsonValue(): JsonElement = WireJson.encodeToJsonElement(serializer<T>(), this)

/** A failure to read a wire value. */
class WireDecodingException(message: String, cause: Throwable? = null) : SerializationException(message, cause)

// MARK: - Dates

object WireDates {
    private val format: DateTimeFormatter =
        DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC)

    /** Parses `DateTimeUtc` (always with milliseconds) and lenient `IsoDateTime` strings. */
    fun parse(text: String): Instant? = try {
        OffsetDateTime.parse(text, DateTimeFormatter.ISO_OFFSET_DATE_TIME).toInstant()
    } catch (_: DateTimeParseException) {
        null
    }

    /** Formats like JavaScript `Date.toISOString()`: UTC with milliseconds. */
    fun format(instant: Instant): String = format.format(instant.truncatedTo(ChronoUnit.MILLIS))
}

/** `DateTimeUtc` on the wire. An unparseable string fails the decode. */
object InstantSerializer : KSerializer<Instant> {
    override val descriptor: SerialDescriptor = serializer<String>().descriptor

    override fun deserialize(decoder: Decoder): Instant {
        val text = decoder.decodeString()
        return WireDates.parse(text) ?: throw WireDecodingException("Unparseable date $text")
    }

    override fun serialize(encoder: Encoder, value: Instant) = encoder.encodeString(WireDates.format(value))
}

/** An [Instant] field written with [InstantSerializer]. */
typealias WireInstant = @kotlinx.serialization.Serializable(with = InstantSerializer::class) Instant

// MARK: - Nullable

/**
 * A patch field that can be set to a value or cleared with an explicit null.
 * Use it as `Nullable<T>?`: null leaves the key out, [Null] sends `null`.
 */
sealed interface Nullable<out T> {
    data object Null : Nullable<Nothing>
    data class Value<T>(val value: T) : Nullable<T>

    val valueOrNull: T? get() = (this as? Value<T>)?.value

    companion object {
        /** [Value] for a value and [Null] for null. */
        fun <T> of(value: T?): Nullable<T> = if (value == null) Null else Value(value)
    }
}

// MARK: - Lenient fields

private fun Decoder.json(): JsonDecoder =
    this as? JsonDecoder ?: throw SerializationException("Wire types decode from JSON only")

private fun Encoder.json(): JsonEncoder =
    this as? JsonEncoder ?: throw SerializationException("Wire types encode to JSON only")

/** A field that reads as absent when it is missing, null or malformed. */
open class LenientSerializer<T : Any>(private val inner: KSerializer<T>) : KSerializer<T?> {
    override val descriptor: SerialDescriptor = inner.descriptor.nullable

    override fun deserialize(decoder: Decoder): T? {
        val input = decoder.json()
        val element = input.decodeJsonElement()
        if (element is JsonNull) return null
        return try {
            input.json.decodeFromJsonElement(inner, element)
        } catch (_: IllegalArgumentException) {
            null
        }
    }

    override fun serialize(encoder: Encoder, value: T?) {
        val output = encoder.json()
        if (value == null) output.encodeJsonElement(JsonNull) else output.encodeSerializableValue(inner, value)
    }
}

/** A forward-compatible array: elements this build cannot decode are dropped. Null reads as empty. */
open class LossyListSerializer<T>(private val element: KSerializer<T>) : KSerializer<List<T>> {
    private val list = ListSerializer(element)
    override val descriptor: SerialDescriptor = list.descriptor

    override fun deserialize(decoder: Decoder): List<T> {
        val input = decoder.json()
        return when (val value = input.decodeJsonElement()) {
            is JsonNull -> emptyList()
            is JsonArray -> value.mapNotNull { item ->
                try {
                    input.json.decodeFromJsonElement(element, item)
                } catch (_: IllegalArgumentException) {
                    null
                }
            }
            else -> throw WireDecodingException("Expected an array")
        }
    }

    override fun serialize(encoder: Encoder, value: List<T>) = encoder.encodeSerializableValue(list, value)
}

/** A list that reads as empty when it is missing, null or not a list, and drops bad elements. */
open class LenientListSerializer<T>(element: KSerializer<T>) : LossyListSerializer<T>(element) {
    override fun deserialize(decoder: Decoder): List<T> = try {
        super.deserialize(decoder)
    } catch (_: IllegalArgumentException) {
        emptyList()
    }
}

object LenientString : LenientSerializer<String>(serializer())
object LenientBool : LenientSerializer<Boolean>(serializer())
object LenientInt : LenientSerializer<Int>(serializer())
object LenientInstant : LenientSerializer<Instant>(InstantSerializer)
object LenientStringList : LenientSerializer<List<String>>(serializer())
object LossyStringList : LossyListSerializer<String>(serializer())

// MARK: - Hand-written objects

/** Reads one JSON object the way the Swift `Decodable` initialisers do. */
class JsonReader(val obj: JsonObject, val json: Json) {
    fun has(key: String): Boolean = obj.containsKey(key)

    /** The member, or null when it is missing or JSON null. */
    fun element(key: String): JsonElement? = obj[key]?.takeUnless { it is JsonNull }

    fun <T> decode(serializer: KSerializer<T>, element: JsonElement, key: String): T = try {
        json.decodeFromJsonElement(serializer, element)
    } catch (e: IllegalArgumentException) {
        throw WireDecodingException("Bad value for $key: ${e.message}", e)
    }

    fun <T> req(key: String, serializer: KSerializer<T>): T =
        element(key)?.let { decode(serializer, it, key) } ?: throw WireDecodingException("Missing $key")

    fun <T> opt(key: String, serializer: KSerializer<T>): T? = element(key)?.let { decode(serializer, it, key) }

    inline fun <reified T> req(key: String): T = req(key, serializer<T>())

    inline fun <reified T> opt(key: String): T? = opt(key, serializer<T>())

    /** A missing, null or malformed value reads as absent. */
    inline fun <reified T> lenient(key: String): T? = try {
        opt<T>(key)
    } catch (_: IllegalArgumentException) {
        null
    }

    fun string(key: String): String = req(key, serializer())
    fun optString(key: String): String? = opt(key, serializer())
    fun int(key: String): Int = req(key, serializer())
    fun optInt(key: String): Int? = opt(key, serializer())
    fun optBool(key: String): Boolean? = opt(key, serializer())
    fun instant(key: String): Instant = req(key, InstantSerializer)
    fun optInstant(key: String): Instant? = opt(key, InstantSerializer)

    /** An array that may be missing or null. Elements must decode. */
    inline fun <reified T> list(key: String): List<T> = opt<List<T>>(key) ?: emptyList()

    /** A forward-compatible array: elements this build cannot decode are dropped. */
    fun <T> lossyList(key: String, serializer: KSerializer<T>): List<T> {
        val value = element(key) ?: return emptyList()
        val items = value as? JsonArray ?: throw WireDecodingException("Expected an array for $key")
        return items.mapNotNull {
            try {
                json.decodeFromJsonElement(serializer, it)
            } catch (_: IllegalArgumentException) {
                null
            }
        }
    }

    inline fun <reified T> lossyList(key: String): List<T> = lossyList(key, serializer<T>())

    /** Distinguishes a missing key (null) from an explicit null ([Nullable.Null]). */
    fun <T> nullable(key: String, serializer: KSerializer<T>): Nullable<T>? {
        if (!has(key)) return null
        val value = element(key) ?: return Nullable.Null
        return Nullable.Value(decode(serializer, value, key))
    }

    inline fun <reified T> nullable(key: String): Nullable<T>? = nullable(key, serializer<T>())

    /** The whole object as a raw value. */
    val raw: JsonObject get() = obj
}

/** Builds one JSON object; null values are left out like `encodeIfPresent`. */
class JsonWriter(val json: Json) {
    val members = LinkedHashMap<String, JsonElement>()

    fun <T> put(key: String, value: T?, serializer: KSerializer<T>) {
        if (value != null) members[key] = json.encodeToJsonElement(serializer, value)
    }

    inline fun <reified T> put(key: String, value: T?) = put(key, value, serializer<T>())

    fun putInstant(key: String, value: Instant?) = put(key, value, InstantSerializer)

    fun <T> putNullable(key: String, value: Nullable<T>?, serializer: KSerializer<T>) {
        when (value) {
            null -> Unit
            Nullable.Null -> members[key] = JsonNull
            is Nullable.Value -> members[key] = json.encodeToJsonElement(serializer, value.value)
        }
    }

    inline fun <reified T> putNullable(key: String, value: Nullable<T>?) = putNullable(key, value, serializer<T>())

    /** Adds every member of another object (a payload that shares the same object). */
    fun merge(other: JsonElement) {
        (other as? JsonObject)?.let { members.putAll(it) }
    }

    fun build(): JsonObject = JsonObject(members)
}

/** A serializer written by hand over a JSON object. */
abstract class ObjectSerializer<T>(serialName: String) : KSerializer<T> {
    override val descriptor: SerialDescriptor = buildClassSerialDescriptor(serialName)

    protected abstract fun JsonReader.read(): T
    protected abstract fun JsonWriter.write(value: T)

    /** Reads a value from an object already in hand. */
    fun readFrom(obj: JsonObject, json: Json = WireJson): T = JsonReader(obj, json).read()

    /** Writes a value as an object. */
    fun writeTo(value: T, json: Json = WireJson): JsonObject = JsonWriter(json).apply { write(value) }.build()

    override fun deserialize(decoder: Decoder): T {
        val input = decoder.json()
        val obj = input.decodeJsonElement() as? JsonObject ?: throw WireDecodingException("Expected an object for ${descriptor.serialName}")
        return readFrom(obj, input.json)
    }

    override fun serialize(encoder: Encoder, value: T) {
        val output = encoder.json()
        output.encodeJsonElement(writeTo(value, output.json))
    }
}

/** A serializer over any JSON value. */
abstract class ElementSerializer<T>(serialName: String) : KSerializer<T> {
    override val descriptor: SerialDescriptor = buildClassSerialDescriptor(serialName)

    protected abstract fun read(element: JsonElement, json: Json): T
    protected abstract fun write(value: T, json: Json): JsonElement

    override fun deserialize(decoder: Decoder): T {
        val input = decoder.json()
        return read(input.decodeJsonElement(), input.json)
    }

    override fun serialize(encoder: Encoder, value: T) {
        val output = encoder.json()
        output.encodeJsonElement(write(value, output.json))
    }
}

/** A string literal union the server may extend. Unknown values never fail a decode. */
interface OpenEnum {
    val rawValue: String

    /** True when this build knows the value. */
    val isKnown: Boolean
}
