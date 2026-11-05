package com.specwithcode.wire

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.serializer

/** A file or image attached to a message. Unknown attachment types keep their base fields. */
@Serializable
data class ChatAttachment(
    /** `image`, `file`, or a type from a newer server. */
    val type: String = "file",
    val id: String,
    val name: String = "",
    val mimeType: String = "application/octet-stream",
    val sizeBytes: Int = 0,
) {
    val isImage: Boolean get() = type == "image"
}

object LossyAttachments : LossyListSerializer<ChatAttachment>(ChatAttachment.serializer())

// MARK: - RPC envelopes

/** Request id chosen by the client and echoed by the server. */
typealias RpcRequestId = Int

/** Client to server frames. */
@Serializable(with = RpcClientMessageSerializer::class)
sealed interface RpcClientMessage {
    data class Request(val id: RpcRequestId, val tag: String, val payload: JsonElement) : RpcClientMessage
    data class Ack(val requestId: RpcRequestId) : RpcClientMessage
    data class Interrupt(val requestId: RpcRequestId) : RpcClientMessage
    data object Ping : RpcClientMessage

    companion object {
        /** A request frame with a typed payload. */
        fun <P> request(id: RpcRequestId, method: RpcMethod, payload: P, serializer: KSerializer<P>): RpcClientMessage =
            Request(id, method.tag, WireJson.encodeToJsonElement(serializer, payload))

        inline fun <reified P> request(id: RpcRequestId, method: RpcMethod, payload: P): RpcClientMessage =
            request(id, method, payload, serializer<P>())

        /** A request frame for a method that takes no input. */
        fun request(id: RpcRequestId, method: RpcMethod): RpcClientMessage = Request(id, method.tag, JsonObject(emptyMap()))
    }
}

object RpcClientMessageSerializer : ObjectSerializer<RpcClientMessage>("RpcClientMessage") {
    override fun JsonReader.read(): RpcClientMessage = when (val tag = string("_tag")) {
        "Request" -> RpcClientMessage.Request(int("id"), string("tag"), element("payload") ?: JsonObject(emptyMap()))
        "Ack" -> RpcClientMessage.Ack(int("requestId"))
        "Interrupt" -> RpcClientMessage.Interrupt(int("requestId"))
        "Ping" -> RpcClientMessage.Ping
        else -> throw WireDecodingException("Unknown client frame $tag")
    }

    override fun JsonWriter.write(value: RpcClientMessage) {
        when (value) {
            is RpcClientMessage.Request -> {
                put("_tag", "Request")
                put("id", value.id)
                put("tag", value.tag)
                members["payload"] = value.payload
                members["headers"] = JsonArray(emptyList())
            }
            is RpcClientMessage.Ack -> {
                put("_tag", "Ack")
                put("requestId", value.requestId)
            }
            is RpcClientMessage.Interrupt -> {
                put("_tag", "Interrupt")
                put("requestId", value.requestId)
            }
            RpcClientMessage.Ping -> put("_tag", "Ping")
        }
    }
}

/** One entry of an Effect `Cause` in a failed exit. */
@Serializable(with = RpcCauseSerializer::class)
sealed interface RpcCause {
    /** A typed error the handler declared (`_tag` names it, e.g. `ProjectWorkspaceError`). */
    data class Fail(val error: JsonElement) : RpcCause

    /** An unexpected defect, usually a message string. */
    data class Die(val defect: JsonElement) : RpcCause
    data object Interrupt : RpcCause
}

object RpcCauseSerializer : ObjectSerializer<RpcCause>("RpcCause") {
    override fun JsonReader.read(): RpcCause = when (string("_tag")) {
        "Fail" -> RpcCause.Fail(element("error") ?: JsonNull)
        "Die" -> RpcCause.Die(element("defect") ?: JsonNull)
        else -> RpcCause.Interrupt
    }

    override fun JsonWriter.write(value: RpcCause) {
        when (value) {
            is RpcCause.Fail -> {
                put("_tag", "Fail")
                members["error"] = value.error
            }
            is RpcCause.Die -> {
                put("_tag", "Die")
                members["defect"] = value.defect
            }
            RpcCause.Interrupt -> put("_tag", "Interrupt")
        }
    }
}

@Serializable(with = RpcExitSerializer::class)
sealed interface RpcExit {
    data class Success(val value: JsonElement) : RpcExit
    data class Failure(val causes: List<RpcCause>) : RpcExit

    val isSuccess: Boolean get() = this is Success

    /** True when the call ended only because it was interrupted (an unsubscribe). */
    val isInterruptOnly: Boolean
        get() = this is Failure && causes.isNotEmpty() && causes.all { it == RpcCause.Interrupt }

    /** The success value decoded with [serializer], or the failure as a [ServerError]. */
    fun <T> value(serializer: KSerializer<T>, json: Json = WireJson): T = when (this) {
        is Success -> json.decodeFromJsonElement(serializer, value)
        is Failure -> throw ServerError.from(causes)
    }
}

/** The success value decoded as [T], or the failure as a [ServerError]. */
inline fun <reified T> RpcExit.value(): T = value(serializer<T>())

object RpcExitSerializer : ObjectSerializer<RpcExit>("RpcExit") {
    override fun JsonReader.read(): RpcExit =
        if (string("_tag") == "Success") RpcExit.Success(element("value") ?: JsonNull)
        else RpcExit.Failure(opt<List<RpcCause>>("cause") ?: emptyList())

    override fun JsonWriter.write(value: RpcExit) {
        when (value) {
            is RpcExit.Success -> {
                put("_tag", "Success")
                members["value"] = value.value
            }
            is RpcExit.Failure -> {
                put("_tag", "Failure")
                put("cause", value.causes)
            }
        }
    }
}

/** Server to client frames. Values stay raw so the socket can route them to the decoder of each request. */
@Serializable(with = RpcServerMessageSerializer::class)
sealed interface RpcServerMessage {
    data class Chunk(val requestId: RpcRequestId, val values: List<JsonElement>) : RpcServerMessage
    data class Exit(val requestId: RpcRequestId, val exit: RpcExit) : RpcServerMessage
    data object Pong : RpcServerMessage
    data class Defect(val defect: JsonElement) : RpcServerMessage
    data class Unknown(val tag: String) : RpcServerMessage
}

object RpcServerMessageSerializer : ObjectSerializer<RpcServerMessage>("RpcServerMessage") {
    override fun JsonReader.read(): RpcServerMessage = when (val tag = string("_tag")) {
        "Chunk" -> RpcServerMessage.Chunk(requestId(), req("values"))
        "Exit" -> RpcServerMessage.Exit(requestId(), req("exit"))
        "Pong" -> RpcServerMessage.Pong
        "Defect" -> RpcServerMessage.Defect(element("defect") ?: JsonNull)
        else -> RpcServerMessage.Unknown(tag)
    }

    private fun JsonReader.requestId(): RpcRequestId {
        val raw = element("requestId") as? JsonPrimitive ?: throw WireDecodingException("Missing requestId")
        // Effect may echo numeric ids as strings.
        return raw.content.toIntOrNull() ?: throw WireDecodingException("Non-numeric request id ${raw.content}")
    }

    override fun JsonWriter.write(value: RpcServerMessage) {
        when (value) {
            is RpcServerMessage.Chunk -> {
                put("_tag", "Chunk")
                put("requestId", value.requestId)
                put("values", value.values)
            }
            is RpcServerMessage.Exit -> {
                put("_tag", "Exit")
                put("requestId", value.requestId)
                put("exit", value.exit)
            }
            RpcServerMessage.Pong -> put("_tag", "Pong")
            is RpcServerMessage.Defect -> {
                put("_tag", "Defect")
                members["defect"] = value.defect
            }
            is RpcServerMessage.Unknown -> put("_tag", value.tag)
        }
    }
}

// MARK: - Typed server errors

/** A failure the UI can explain. Built from an [RpcCause] list. */
class ServerError(val kind: Kind, override val message: String, val raw: JsonElement = JsonNull) : Exception(message) {
    sealed interface Kind {
        /** Token lacks a scope, e.g. `orchestration:operate`. */
        data class Authorization(val requiredScope: String?) : Kind

        /** Command rejected by the orchestrator. */
        data class Dispatch(val commandType: String?) : Kind

        /** `ProjectWorkspaceError` with its `code` (paused, archived, model_required, busy, ...). */
        data class ProjectWorkspace(val code: String) : Kind
        data object ProjectMutation : Kind
        data object ServerSettings : Kind

        /** Some other typed error, identified by its `_tag`. */
        data class Other(val tag: String) : Kind
        data object Defect : Kind
        data object Interrupted : Kind
    }

    override fun toString(): String = message

    override fun equals(other: Any?): Boolean =
        other is ServerError && other.kind == kind && other.message == message && other.raw == raw

    override fun hashCode(): Int = (kind.hashCode() * 31 + message.hashCode()) * 31 + raw.hashCode()

    companion object {
        fun from(causes: List<RpcCause>): ServerError {
            for (cause in causes) {
                when (cause) {
                    is RpcCause.Fail -> {
                        val error = cause.error
                        val tag = error["_tag"].stringValue ?: "UnknownError"
                        // A tagged error's `message` is a getter, so it never crosses the wire:
                        // a Team rules refusal travels in its own field.
                        val message = error["teamRulesRefusal"]["message"].stringValue
                            ?: error["teamRulesMessage"].stringValue
                            ?: error["message"].stringValue
                        return when (tag) {
                            "EnvironmentAuthorizationError" -> ServerError(
                                Kind.Authorization(error["requiredScope"].stringValue),
                                message ?: "This machine did not grant the app permission for that.", error,
                            )
                            "OrchestrationV2DispatchCommandError" -> ServerError(
                                Kind.Dispatch(error["commandType"].stringValue), message ?: "The machine rejected the command.", error,
                            )
                            "ProjectWorkspaceError" -> {
                                val code = error["code"].stringValue ?: "unknown"
                                ServerError(Kind.ProjectWorkspace(code), ProjectWorkspaceErrorText.message(code), error)
                            }
                            "ProjectMutationError" -> ServerError(Kind.ProjectMutation, message ?: "The project could not be saved.", error)
                            "ServerSettingsError" -> ServerError(Kind.ServerSettings, message ?: "The setting could not be saved.", error)
                            "AccessRequestError" -> ServerError(Kind.Other(tag), AccessRequestErrorText.message(error["reason"].stringValue), error)
                            else -> ServerError(Kind.Other(tag), message ?: tag, error)
                        }
                    }
                    is RpcCause.Die -> {
                        val defect = cause.defect
                        val text = defect.stringValue ?: defect["message"].stringValue ?: "The machine hit an unexpected error."
                        return ServerError(Kind.Defect, text, defect)
                    }
                    RpcCause.Interrupt -> continue
                }
            }
            return ServerError(Kind.Interrupted, "The request was cancelled.")
        }
    }
}

/** User-facing text for `ProjectWorkspaceError.code`. The server sends only the code. */
object ProjectWorkspaceErrorText {
    fun message(code: String): String = when (code) {
        "not_found" -> "This project no longer exists on that machine."
        "conflict" -> "Someone else changed this project. Reload and try again."
        "paused" -> "This project is paused. Resume it to send messages."
        "archived" -> "This project is archived."
        "model_required" -> "Choose a model for the coordinator first."
        "unsupported_provider" -> "The coordinator's provider is not available on that machine."
        "busy" -> "The coordinator is busy. Try again in a moment."
        "transferred" -> "This project moved to another machine."
        "update_in_progress" -> "That machine is updating. Try again shortly."
        "invalid_coordinator" -> "The coordinator thread is in a bad state on that machine."
        else -> "The project could not do that ($code)."
    }
}
