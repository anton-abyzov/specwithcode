package com.specwithcode.wire

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/** The orchestration protocol this app speaks. */
object OrchestrationProtocol {
    const val VERSION = 2

    /** Query parameter for the socket URL. */
    const val QUERY_PARAMETER = "orchestrationProtocol"

    /** Header for REST snapshot routes. */
    const val HEADER = "x-studio-orchestration-protocol"
}

/** `GET /.well-known/studio/environment`, served without auth. */
@Serializable(with = EnvironmentDescriptorSerializer::class)
data class EnvironmentDescriptor(
    val environmentId: String,
    val label: String,
    val platform: EnvironmentPlatform,
    val serverVersion: String? = null,
    val serverSourceCommit: String? = null,
    /** Absent on hosts that predate protocol negotiation, which speak version 1. */
    val orchestrationProtocolVersion: Int? = null,
    val capabilities: EnvironmentCapabilities = EnvironmentCapabilities(),
) {
    /** The protocol version, treating a missing value as 1. */
    val protocolVersion: Int get() = orchestrationProtocolVersion ?: 1

    sealed interface Compatibility {
        data object Compatible : Compatibility

        /** The machine runs an older protocol; its server needs an update. */
        data class ServerTooOld(val version: Int) : Compatibility

        /** The machine runs a newer protocol; this app needs an update. */
        data class AppTooOld(val version: Int) : Compatibility
    }

    val compatibility: Compatibility
        get() {
            val v = protocolVersion
            return when {
                v == OrchestrationProtocol.VERSION -> Compatibility.Compatible
                v < OrchestrationProtocol.VERSION -> Compatibility.ServerTooOld(v)
                else -> Compatibility.AppTooOld(v)
            }
        }
}

object EnvironmentDescriptorSerializer : ObjectSerializer<EnvironmentDescriptor>("EnvironmentDescriptor") {
    override fun JsonReader.read(): EnvironmentDescriptor {
        val id = string("environmentId")
        return EnvironmentDescriptor(
            environmentId = id,
            label = optString("label") ?: id,
            platform = opt("platform") ?: EnvironmentPlatform("unknown", "other"),
            serverVersion = optString("serverVersion"),
            serverSourceCommit = optString("serverSourceCommit"),
            orchestrationProtocolVersion = optInt("orchestrationProtocolVersion"),
            capabilities = opt("capabilities") ?: EnvironmentCapabilities(),
        )
    }

    override fun JsonWriter.write(value: EnvironmentDescriptor) {
        put("environmentId", value.environmentId)
        put("label", value.label)
        put("platform", value.platform)
        put("serverVersion", value.serverVersion)
        put("serverSourceCommit", value.serverSourceCommit)
        put("orchestrationProtocolVersion", value.orchestrationProtocolVersion)
        put("capabilities", value.capabilities)
    }
}

@Serializable
data class EnvironmentPlatform(
    /** `darwin`, `linux`, `windows` or `unknown`. */
    val os: String,
    /** `arm64`, `x64` or `other`. */
    val arch: String,
    /** Hardware shape such as `laptop` or `mac-mini`, when the server detected one. */
    val machine: String? = null,
) {
    /** e.g. "macOS · arm64" */
    val displayName: String
        get() {
            val name = when (os) {
                "darwin" -> "macOS"
                "linux" -> "Linux"
                "windows" -> "Windows"
                else -> os
            }
            return if (arch == "other") name else "$name · $arch"
        }
}

/** Feature flags a server advertises. Kept raw so new flags pass through. */
@Serializable(with = EnvironmentCapabilitiesSerializer::class)
data class EnvironmentCapabilities(val values: Map<String, JsonElement> = emptyMap()) {
    /** True when the server reports the flag as `true`. */
    fun has(name: String): Boolean = values[name].boolValue == true

    operator fun get(name: String): JsonElement? = values[name]

    val serverResolvedCommandContext: Boolean get() = has("serverResolvedCommandContext")
    val threadPinning: Boolean get() = has("threadPinning")
    val threadSettlement: Boolean get() = has("threadSettlement")
    val threadVisitedTracking: Boolean get() = has("threadVisitedTracking")
    val attachmentUploads: Boolean get() = has("attachmentUploads")
    val maxUploadBytes: Int? get() = values["fileAttachments"]["maxUploadBytes"].intValue
}

object EnvironmentCapabilitiesSerializer : ElementSerializer<EnvironmentCapabilities>("EnvironmentCapabilities") {
    override fun read(element: JsonElement, json: Json) = EnvironmentCapabilities((element as? JsonObject) ?: emptyMap())
    override fun write(value: EnvironmentCapabilities, json: Json): JsonElement = JsonObject(value.values)
}

/** An address the server listens on, so a client connected one way can learn others. */
@Serializable
data class DirectEndpoint(val kind: DirectEndpointKind, val httpBaseUrl: String)

/** `server.getConfig`: the subset the app reads. */
@Serializable(with = ServerConfigSerializer::class)
data class ServerConfig(
    val environment: EnvironmentDescriptor,
    val directEndpoints: List<DirectEndpoint> = emptyList(),
    val settings: ServerSettings? = null,
    /** The machine's Team rules. Absent with no rules, and on servers that predate them. */
    val teamRules: TeamRulesSummary? = null,
    val providers: List<ServerProviderSummary> = emptyList(),
    val shellResumeCompletionMarker: Boolean? = null,
    val threadResumeCompletionMarker: Boolean? = null,
    val threadSnapshotPagination: Boolean? = null,
    val newProjectsRoot: String? = null,
    val scratchWorkspaceRoot: String? = null,
) {
    /** The provider snapshot for a model selection's instance. */
    fun provider(instanceId: String): ServerProviderSummary? = providers.firstOrNull { it.instanceId == instanceId }
}

object ServerConfigSerializer : ObjectSerializer<ServerConfig>("ServerConfig") {
    override fun JsonReader.read() = ServerConfig(
        environment = req("environment"),
        directEndpoints = lossyList("directEndpoints"),
        settings = opt("settings"),
        teamRules = lenient("teamRules"),
        providers = lossyList("providers"),
        shellResumeCompletionMarker = optBool("shellResumeCompletionMarker"),
        threadResumeCompletionMarker = optBool("threadResumeCompletionMarker"),
        threadSnapshotPagination = optBool("threadSnapshotPagination"),
        newProjectsRoot = optString("newProjectsRoot"),
        scratchWorkspaceRoot = optString("scratchWorkspaceRoot"),
    )

    override fun JsonWriter.write(value: ServerConfig) {
        put("environment", value.environment)
        put("directEndpoints", value.directEndpoints)
        put("settings", value.settings)
        put("teamRules", value.teamRules)
        put("providers", value.providers)
        put("shellResumeCompletionMarker", value.shellResumeCompletionMarker)
        put("threadResumeCompletionMarker", value.threadResumeCompletionMarker)
        put("threadSnapshotPagination", value.threadSnapshotPagination)
        put("newProjectsRoot", value.newProjectsRoot)
        put("scratchWorkspaceRoot", value.scratchWorkspaceRoot)
    }
}

/** A configured provider instance and its models, from `ServerConfig.providers`. */
@Serializable(with = ServerProviderSummarySerializer::class)
data class ServerProviderSummary(
    val instanceId: String,
    val driver: String,
    val displayName: String? = null,
    val iconUrl: String? = null,
    val enabled: Boolean = true,
    val installed: Boolean = true,
    /** e.g. `ready`, `error`, `disabled`. */
    val status: String = "ready",
    val message: String? = null,
    val models: List<ServerProviderModel> = emptyList(),
) {
    val id: String get() = instanceId

    /** The display name of a model slug, falling back to the slug. */
    fun modelName(slug: String): String =
        models.firstOrNull { it.slug == slug || (it.aliases ?: emptyList()).contains(slug) }?.name ?: slug
}

object ServerProviderSummarySerializer : ObjectSerializer<ServerProviderSummary>("ServerProviderSummary") {
    override fun JsonReader.read(): ServerProviderSummary {
        val id = string("instanceId")
        return ServerProviderSummary(
            instanceId = id,
            driver = optString("driver") ?: id,
            displayName = optString("displayName"),
            iconUrl = optString("iconUrl"),
            enabled = optBool("enabled") ?: false,
            installed = optBool("installed") ?: false,
            status = optString("status") ?: "unknown",
            message = optString("message"),
            models = lossyList("models"),
        )
    }

    override fun JsonWriter.write(value: ServerProviderSummary) {
        put("instanceId", value.instanceId)
        put("driver", value.driver)
        put("displayName", value.displayName)
        put("iconUrl", value.iconUrl)
        put("enabled", value.enabled)
        put("installed", value.installed)
        put("status", value.status)
        put("message", value.message)
        put("models", value.models)
    }
}

@Serializable
data class ServerProviderModel(
    val slug: String,
    val name: String,
    val aliases: List<String>? = null,
    val badge: String? = null,
    val isCustom: Boolean? = null,
)

/** Items of the `subscribeServerConfig` stream. Only the snapshot, settings and provider statuses are modelled. */
@Serializable(with = ServerConfigStreamItemSerializer::class)
sealed interface ServerConfigStreamItem {
    data class Snapshot(val config: ServerConfig) : ServerConfigStreamItem

    /** The server's settings after any change, such as a machine rename. */
    data class SettingsUpdated(val settings: ServerSettings) : ServerConfigStreamItem

    /** The provider list and the rules that shape it. No rules means none now. */
    data class ProviderStatuses(val providers: List<ServerProviderSummary>, val teamRules: TeamRulesSummary?) : ServerConfigStreamItem

    /** Any other update, such as `usageLimitSourcesUpdated`. */
    data class Other(val type: String, val raw: JsonObject) : ServerConfigStreamItem
}

object ServerConfigStreamItemSerializer : ObjectSerializer<ServerConfigStreamItem>("ServerConfigStreamItem") {
    override fun JsonReader.read(): ServerConfigStreamItem = when (val type = optString("type") ?: "") {
        "snapshot" -> ServerConfigStreamItem.Snapshot(req("config"))
        "settingsUpdated" -> ServerConfigStreamItem.SettingsUpdated(JsonReader(req("payload"), json).req("settings"))
        "providerStatuses" -> {
            val payload = JsonReader(req("payload"), json)
            ServerConfigStreamItem.ProviderStatuses(payload.lossyList("providers"), payload.lenient("teamRules"))
        }
        else -> ServerConfigStreamItem.Other(type, raw)
    }

    override fun JsonWriter.write(value: ServerConfigStreamItem) {
        when (value) {
            is ServerConfigStreamItem.Snapshot -> {
                put("type", "snapshot")
                put("config", value.config)
            }
            is ServerConfigStreamItem.SettingsUpdated -> {
                put("type", "settingsUpdated")
                members["payload"] = JsonWriter(json).apply { put("settings", value.settings) }.build()
            }
            is ServerConfigStreamItem.ProviderStatuses -> {
                put("type", "providerStatuses")
                members["payload"] = JsonWriter(json).apply {
                    put("providers", value.providers)
                    put("teamRules", value.teamRules)
                }.build()
            }
            is ServerConfigStreamItem.Other -> merge(value.raw)
        }
    }
}
