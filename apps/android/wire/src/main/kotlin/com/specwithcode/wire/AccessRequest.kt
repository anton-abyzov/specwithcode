package com.specwithcode.wire

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import java.util.Base64

// Access requests: an agent asks to use apps, devices, machines or folders. One answer
// covers every subject; an Allow carries how long it lasts. Mirrors
// `packages/contracts/src/accessRequest.ts`.

/** How long an Allow lasts: this thread only, or every thread on this machine. */
@Serializable
enum class AccessRequestScope {
    @SerialName("thread") Thread,
    @SerialName("machine") Machine,
}

/** A small PNG of the subject's own icon, base64 encoded. */
@Serializable
data class AccessRequestIcon(val mimeType: String = "image/png", val data: String) {
    /** The decoded PNG bytes, null when the data is not valid base64. */
    val pngData: ByteArray?
        get() = try {
            Base64.getMimeDecoder().decode(data)
        } catch (_: IllegalArgumentException) {
            null
        }
}

object LenientAccessIcon : LenientSerializer<AccessRequestIcon>(AccessRequestIcon.serializer())
object LenientAccessScope : LenientSerializer<AccessRequestScope>(AccessRequestScope.serializer())

/** One thing the agent asks to use, with what it may do with it. */
@Serializable
data class AccessRequestSubject(
    val kind: AccessRequestSubjectKind,
    /** The grant this subject is recorded under, e.g. `app:activity monitor`. */
    val key: String,
    /** Its name, e.g. "Activity Monitor" or "iPhone 17 Pro". */
    val label: String,
    /** What the agent may do with it, e.g. "See and control its windows". */
    val detail: String = "",
    /** The machine it is on, when that is worth saying, e.g. "M1". */
    val hostLabel: String? = null,
    /** `ios` or `android`, for a device. */
    val platform: String? = null,
    /** A malformed icon falls back to the kind's glyph rather than failing the item. */
    @Serializable(with = LenientAccessIcon::class) val icon: AccessRequestIcon? = null,
) {
    val id: String get() = key
    val copyName: AccessRequestCopy.SubjectName get() = AccessRequestCopy.SubjectName(kind.rawValue, label)
}

/** The user's answer to an access request card. */
@Serializable(with = AccessRequestAnswerSerializer::class)
sealed interface AccessRequestAnswer {
    data class Allow(val scope: AccessRequestScope) : AccessRequestAnswer
    data object Deny : AccessRequestAnswer
}

object AccessRequestAnswerSerializer : ObjectSerializer<AccessRequestAnswer>("AccessRequestAnswer") {
    override fun JsonReader.read(): AccessRequestAnswer = when (val type = string("type")) {
        "allow" -> AccessRequestAnswer.Allow(req("scope"))
        "deny" -> AccessRequestAnswer.Deny
        else -> throw WireDecodingException("Unknown answer $type")
    }

    override fun JsonWriter.write(value: AccessRequestAnswer) {
        when (value) {
            is AccessRequestAnswer.Allow -> {
                put("type", "allow")
                put("scope", value.scope)
            }
            AccessRequestAnswer.Deny -> put("type", "deny")
        }
    }
}

/** `access.answerRequest` -> void. */
@Serializable
data class AccessAnswerRequestInput(val threadId: String, val turnItemId: String, val answer: AccessRequestAnswer)

/** User-facing text for `AccessRequestError.reason`. The server sends only the reason. */
object AccessRequestErrorText {
    fun message(reason: String?): String = when (reason) {
        "load_failed" -> "Could not load the access request."
        "not_found" -> "This access request no longer exists."
        "already_answered" -> "This access request was already answered."
        "agent_stopped" -> "The agent that asked has stopped, so there is nothing to allow."
        "grant_failed" -> "Could not save the access."
        "record_failed" -> "Saved the access, but could not update the request."
        else -> "Could not answer the access request."
    }
}

/** The words every client uses for an access request. A port of `packages/client-runtime/src/accessRequest.ts`. */
object AccessRequestCopy {
    /** What the copy needs from a subject: its kind and its name. */
    data class SubjectName(val kind: String, val label: String)

    internal fun joinNames(names: List<String>): String {
        if (names.size <= 1) return names.firstOrNull() ?: ""
        return "${names.dropLast(1).joinToString(", ")} and ${names.last()}"
    }

    /** "Claude wants to use SpecWithCode", "Codex wants to control iPhone 17 Pro". */
    fun headline(agentLabel: String?, subjects: List<SubjectName>): String {
        val trimmed = agentLabel?.trim().orEmpty()
        val agent = trimmed.ifEmpty { "The agent" }
        val used = subjects.filter { it.kind != "device" }.map { it.label }
        val controlled = subjects.filter { it.kind == "device" }.map { it.label }
        val parts = buildList {
            if (used.isNotEmpty()) add("use ${joinNames(used)}")
            if (controlled.isNotEmpty()) add("control ${joinNames(controlled)}")
        }
        val what = if (parts.isEmpty()) "use something on your computer" else parts.joinToString(" and ")
        return "$agent wants to $what"
    }

    /** The scope tag on each subject chip: what the agent may do with it. */
    @Suppress("UNUSED_PARAMETER")
    fun subjectTag(subject: SubjectName): String = "All"

    /** The one plain line under the chips, saying what Allow lets the agent do. */
    fun note(subjects: List<SubjectName>): String {
        val apps = subjects.any { it.kind == "app" }
        val devices = subjects.any { it.kind == "device" }
        return when {
            apps && devices -> "The agent can see your screen, click and type in these apps, and drive the device."
            devices -> "The agent can see the device's screen, tap, type and install apps on it."
            subjects.any { it.kind == "folder" } -> "The agent can read and change files in this folder."
            subjects.any { it.kind == "machine" } -> "The agent can run work on that machine."
            else -> "The agent can see your screen and click and type in these apps while it works."
        }
    }

    /** A waiting thread's subtitle in the thread lists. */
    fun waitingSubtitle(subjects: List<SubjectName>): String {
        val kinds = subjects.map { it.kind }.toSet()
        return when (kinds) {
            setOf("device") -> if (subjects.size == 1) "Asking to control a device" else "Asking to control devices"
            setOf("folder") -> "Asking to use a folder"
            setOf("machine") -> "Asking to work on another machine"
            else -> "Asking to use apps on your computer"
        }
    }

    private val purposePrefix = Regex("^(?:to|in order to)\\s+", RegexOption.IGNORE_CASE)

    /** After a thread link: "is waiting for you to allow access to M4, so it can find …". */
    fun waitingSentence(machineLabel: String, reason: String): String {
        var purpose = reason.trim().trimEnd('.', '!')
        purpose = purpose.replaceFirst(purposePrefix, "")
        if (purpose.isEmpty()) return "is waiting for you to allow access to $machineLabel."
        return "is waiting for you to allow access to $machineLabel, so it can ${purpose.first().lowercase()}${purpose.drop(1)}."
    }
}

/** What a thread's pending access request asks for, as the thread shell carries it. Older servers leave it out. */
@Serializable
data class PendingAccessSummary(
    val accessTitle: String = "",
    val reason: String = "",
    val subjects: List<Subject> = emptyList(),
) {
    @Serializable
    data class Subject(val kind: String, val label: String, val hostLabel: String? = null) {
        val copyName: AccessRequestCopy.SubjectName get() = AccessRequestCopy.SubjectName(kind, label)
    }
}
