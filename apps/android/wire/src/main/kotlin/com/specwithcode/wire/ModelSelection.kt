package com.specwithcode.wire

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

/**
 * A model on a configured provider instance, e.g. `{instanceId: "codex", model: "gpt-6"}`.
 *
 * Decoding also accepts the legacy `{provider, model}` form and options written as an
 * object (`{"effort": "high"}`). Encoding always writes the canonical form.
 */
@Serializable(with = ModelSelectionSerializer::class)
data class ModelSelection(
    val instanceId: String,
    val model: String,
    val options: List<ModelOption>? = null,
) {
    /** The value of one option, e.g. `option("effort")`. */
    fun option(id: String): ModelOption.Value? = options?.firstOrNull { it.id == id }?.value
}

/** One provider option chosen for a model, such as reasoning effort or fast mode. */
@Serializable(with = ModelOptionSerializer::class)
data class ModelOption(val id: String, val value: Value) {
    sealed interface Value {
        data class Text(val value: String) : Value
        data class Flag(val value: Boolean) : Value
    }
}

object ModelOptionSerializer : ObjectSerializer<ModelOption>("ModelOption") {
    override fun JsonReader.read(): ModelOption =
        parseOption(string("id"), element("value")) ?: throw WireDecodingException("Bad model option value")

    override fun JsonWriter.write(value: ModelOption) {
        put("id", value.id)
        when (val v = value.value) {
            is ModelOption.Value.Text -> put("value", v.value)
            is ModelOption.Value.Flag -> put("value", v.value)
        }
    }
}

private fun parseOption(id: String, value: JsonElement?): ModelOption? {
    val primitive = value as? JsonPrimitive ?: return null
    return when {
        primitive.isString -> ModelOption(id, ModelOption.Value.Text(primitive.content))
        primitive.booleanOrNull != null -> ModelOption(id, ModelOption.Value.Flag(primitive.booleanOrNull!!))
        else -> null
    }
}

object ModelSelectionSerializer : ObjectSerializer<ModelSelection>("ModelSelection") {
    override fun JsonReader.read(): ModelSelection {
        val instanceId = optString("instanceId")
            ?: lenient<String>("provider")
            ?: throw WireDecodingException("Model selection has no instanceId or provider")
        return ModelSelection(instanceId, string("model"), options(element("options")))
    }

    private fun options(raw: JsonElement?): List<ModelOption>? = when (raw) {
        is JsonArray -> raw.mapNotNull { item ->
            val id = item["id"].stringValue ?: return@mapNotNull null
            parseOption(id, item["value"])
        }
        // Legacy object form; keys sorted so the order is stable.
        is JsonObject -> raw.keys.sorted().mapNotNull { key ->
            val id = key.trim()
            if (id.isEmpty()) return@mapNotNull null
            val value = raw[key] as? JsonPrimitive ?: return@mapNotNull null
            when {
                value.isString && value.content.isNotBlank() -> ModelOption(id, ModelOption.Value.Text(value.content.trim()))
                !value.isString && value.booleanOrNull != null -> ModelOption(id, ModelOption.Value.Flag(value.booleanOrNull!!))
                else -> null
            }
        }
        else -> null
    }

    override fun JsonWriter.write(value: ModelSelection) {
        put("instanceId", value.instanceId)
        put("model", value.model)
        put("options", value.options)
    }
}
