package com.specwithcode.wire

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/** `server.getSettings` (and `ServerConfig.settings`): the subset the app reads. The rest are ignored. */
@Serializable(with = ServerSettingsSerializer::class)
data class ServerSettings(
    val defaultRuntimeMode: RuntimeMode? = null,
    val defaultModelSelection: ModelSelection? = null,
    val textGenerationModelSelection: ModelSelection? = null,
    val sidebarProjectOrder: SidebarProjectOrder? = null,
    /** Configured provider instances by instance id. */
    val providerInstances: Map<String, ProviderInstanceInfo> = emptyMap(),
    val defaultThreadEnvMode: ThreadEnvMode? = null,
    val environmentIcon: String? = null,
    /** The user's short names for every machine in the fleet, by environment id. Older servers omit it. */
    val machineNicknames: Map<String, MachineNicknameEntry> = emptyMap(),
    /** Whether Percy, the personal assistant, is shown. Off by default; older servers omit it. */
    val aideEnabled: Boolean = false,
    /** Suggested prompts: "all", "native" (the provider's own only) or "off". */
    val promptSuggestions: String = "all",
)

object ServerSettingsSerializer : ObjectSerializer<ServerSettings>("ServerSettings") {
    override fun JsonReader.read() = ServerSettings(
        defaultRuntimeMode = opt("defaultRuntimeMode"),
        defaultModelSelection = lenient("defaultModelSelection"),
        textGenerationModelSelection = lenient("textGenerationModelSelection"),
        sidebarProjectOrder = lenient("sidebarProjectOrder"),
        providerInstances = lenientMap("providerInstances"),
        defaultThreadEnvMode = opt("defaultThreadEnvMode"),
        environmentIcon = lenient("environmentIcon"),
        machineNicknames = lenientMap("machineNicknames"),
        aideEnabled = lenient<Boolean>("aideEnabled") ?: false,
        promptSuggestions = lenient<String>("promptSuggestions") ?: "all",
    )

    /** Drops a malformed entry rather than failing the whole settings snapshot. */
    private inline fun <reified T> JsonReader.lenientMap(key: String): Map<String, T> {
        val raw = element(key) as? JsonObject ?: return emptyMap()
        return raw.mapNotNull { (id, value) ->
            try {
                id to json.decodeFromJsonElement(kotlinx.serialization.serializer<T>(), value)
            } catch (_: IllegalArgumentException) {
                null
            }
        }.toMap()
    }

    override fun JsonWriter.write(value: ServerSettings) {
        put("defaultRuntimeMode", value.defaultRuntimeMode)
        put("defaultModelSelection", value.defaultModelSelection)
        put("textGenerationModelSelection", value.textGenerationModelSelection)
        put("sidebarProjectOrder", value.sidebarProjectOrder)
        put("providerInstances", value.providerInstances)
        put("defaultThreadEnvMode", value.defaultThreadEnvMode)
        put("environmentIcon", value.environmentIcon)
        put("machineNicknames", value.machineNicknames)
        put("aideEnabled", value.aideEnabled)
        put("promptSuggestions", value.promptSuggestions)
    }
}

/**
 * One entry of `ServerSettings.machineNicknames`. An empty name means the machine's default
 * short name; its stamp still lets a reset beat an older rename.
 */
@Serializable
data class MachineNicknameEntry(
    val name: String,
    /** ISO 8601; the newest entry wins when machines disagree. */
    val updatedAt: String,
)

/** The user's order of the projects list on one host: pinned first, then the rest. */
@Serializable
data class SidebarProjectOrder(
    val pinned: List<String> = emptyList(),
    val unpinned: List<String> = emptyList(),
    /** The `environmentId:projectId` members of each pinned project. */
    val pinnedMembers: Map<String, List<String>>? = null,
)

/** One entry of `ServerSettings.providerInstances`: its name and whether it is on. */
@Serializable
data class ProviderInstanceInfo(
    val driver: String,
    val displayName: String? = null,
    val enabled: Boolean? = null,
)

/** `server.updateSettings` patch. Every key is optional; omitted keys stay unchanged. */
@Serializable(with = ServerSettingsPatchSerializer::class)
data class ServerSettingsPatch(
    val defaultRuntimeMode: RuntimeMode? = null,
    /** [Nullable.Null] clears the default model. */
    val defaultModelSelection: Nullable<ModelSelection>? = null,
    /** Replaces the whole order; send both lists. */
    val sidebarProjectOrder: SidebarProjectOrder? = null,
) {
    val isEmpty: Boolean get() = defaultRuntimeMode == null && defaultModelSelection == null && sidebarProjectOrder == null
}

object ServerSettingsPatchSerializer : ObjectSerializer<ServerSettingsPatch>("ServerSettingsPatch") {
    override fun JsonReader.read() = ServerSettingsPatch(opt("defaultRuntimeMode"), nullable("defaultModelSelection"), opt("sidebarProjectOrder"))

    override fun JsonWriter.write(value: ServerSettingsPatch) {
        put("defaultRuntimeMode", value.defaultRuntimeMode)
        putNullable("defaultModelSelection", value.defaultModelSelection)
        put("sidebarProjectOrder", value.sidebarProjectOrder)
    }
}

/** Payload of `server.updateSettings`. */
@Serializable
data class UpdateServerSettingsInput(val patch: ServerSettingsPatch)
