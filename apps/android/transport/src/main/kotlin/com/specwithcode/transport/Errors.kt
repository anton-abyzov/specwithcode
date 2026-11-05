package com.specwithcode.transport

import com.specwithcode.wire.EnvironmentDescriptor
import java.io.IOException
import java.io.InterruptedIOException
import java.net.SocketTimeoutException
import kotlin.coroutines.cancellation.CancellationException

/**
 * Failures from HTTP calls, the socket and the connection supervisor. Typed server
 * failures of an RPC arrive as `ServerError` from `:wire` instead.
 *
 * [message] is short and safe to show. It never carries a URL, so a socket ticket
 * cannot leak through a log or the UI.
 */
sealed class TransportException(message: String, cause: Throwable? = null) : Exception(message, cause) {
    /** The address could not be turned into a request. */
    class InvalidAddress(val address: String) : TransportException("That computer address is not valid.")

    /** The machine could not be reached (DNS, refused, no route, TLS). */
    class Unreachable(val detail: String) :
        TransportException("The computer could not be reached. Check that it is awake and on the same network or tailnet.")

    class TimedOut : TransportException("The computer took too long to answer.")

    /** The socket closed before the request finished. */
    class Closed : TransportException("The connection to the computer closed.")

    /**
     * The stored token is missing, expired or revoked. Pair again. [reason] is the server's
     * `EnvironmentAuthInvalidError` reason when it sent one; `device_reapproval_required`
     * means the computer wants this device approved again.
     */
    class NeedsRepair(val reason: String? = null) : TransportException(
        if (reason == REAPPROVAL_REQUIRED) {
            "Approve this device again in SpecWithCode. Create a new pairing code on the receiving machine and sign in again."
        } else {
            "This computer no longer accepts the app's sign-in. Pair it again."
        },
    ) {
        val reapprovalRequired: Boolean get() = reason == REAPPROVAL_REQUIRED

        companion object {
            const val REAPPROVAL_REQUIRED = "device_reapproval_required"
        }
    }

    /** The one-time pairing code expired, was already used, or is wrong. */
    class PairingCodeRejected :
        TransportException("That pairing code expired or was already used. Create a new one on your computer.")

    /** The server speaks a newer protocol than this app. */
    class AppTooOld(val descriptor: EnvironmentDescriptor) :
        TransportException("${descriptor.label} runs a newer SpecWithCode. Update the app to connect.")

    /** The server speaks an older protocol than this app. */
    class ServerTooOld(val descriptor: EnvironmentDescriptor) :
        TransportException("Update SpecWithCode on ${descriptor.label} to connect.")

    /** The address answered as a different machine. */
    class EnvironmentMismatch(val expected: String, val actual: String) :
        TransportException("That address belongs to a different computer.")

    /** The WebSocket upgrade did not return 101. */
    class UpgradeFailed(val status: Int?) : TransportException("The computer refused the live connection" + (status?.let { " (HTTP $it)." } ?: "."))

    /**
     * Any other non-2xx answer. [code] is the server's reason or code when it sent one.
     * [retryAfterSeconds] comes from a 429's body or `retry-after` header.
     */
    class Http(val status: Int, val code: String? = null, val retryAfterSeconds: Long? = null) : TransportException(
        if (status == 429) {
            "The computer is refusing sign-ins from this network for a few minutes after too many failed attempts."
        } else {
            "The computer answered with an error ($status)."
        },
    )

    /** A 2xx answer the app could not read. */
    class InvalidResponse(val detail: String) : TransportException("The computer sent an answer the app could not read.")

    /** SpecWithCode Connect could not hand out access to the machine. */
    class Connect(val error: ConnectError) : TransportException(error.message ?: "SpecWithCode Connect failed.", error)

    /**
     * The machine's Team rules refuse this phone or route. Nothing was revoked, so the
     * app keeps trying and connects again once the rule is removed.
     */
    class TeamRules(message: String) : TransportException(message)

    /** The failure will not go away by retrying. */
    val isPermanent: Boolean
        get() = when (this) {
            is NeedsRepair, is AppTooOld, is ServerTooOld, is PairingCodeRejected -> true
            is Connect -> error.isPermanent
            else -> false
        }

    /** Short, URL-free text for logs. */
    override fun toString(): String = when (this) {
        is Http -> "Http($status, $code)"
        is UpgradeFailed -> "UpgradeFailed($status)"
        is Unreachable -> "Unreachable($detail)"
        is InvalidResponse -> "InvalidResponse($detail)"
        is EnvironmentMismatch -> "EnvironmentMismatch($expected, $actual)"
        is Connect -> "Connect($error)"
        else -> javaClass.simpleName
    }

    companion object {
        /** Maps an I/O failure. The detail never quotes a URL. */
        fun fromIo(error: IOException): TransportException = when (error) {
            is SocketTimeoutException -> TimedOut()
            is InterruptedIOException -> if (error.message == "timeout") TimedOut() else Unreachable(error.javaClass.simpleName)
            else -> Unreachable(error.javaClass.simpleName)
        }

        /** Any failure as a transport failure; cancellation passes through. */
        fun from(error: Throwable): Throwable = when (error) {
            is CancellationException -> error
            is TransportException -> error
            is ConnectError -> if (error.isOffline) Unreachable("Offline") else Connect(error)
            is IOException -> fromIo(error)
            else -> Unreachable(error.javaClass.simpleName)
        }
    }
}

/** A failed relay call. `code` and `reason` come from the relay's error body. */
sealed class ConnectError(message: String) : Exception(message) {
    /** No Clerk session: the person signed out or the session ended. */
    class SignedOut : ConnectError("Sign in to reach your computers.")

    class Relay(val status: Int, val code: String?, val reason: String?) : ConnectError(relayMessage(code, reason))

    class Unreachable(val detail: String) : ConnectError("SpecWithCode Connect could not be reached. Check your connection.")

    class InvalidResponse(val detail: String) : ConnectError("SpecWithCode Connect sent an answer the app could not read.")

    /** Retrying without the person doing something will not help. */
    val isPermanent: Boolean
        get() = when (this) {
            is SignedOut -> true
            is Relay -> code == "environment_connect_not_authorized" || isDeviceRemoved
            else -> false
        }

    /** The person removed this phone from their account. Only a fresh sign-in lets it back in. */
    val isDeviceRemoved: Boolean
        get() = this is Relay && code == "auth_invalid" && reason == RelayClient.DEVICE_REMOVED

    /** A 401 a fresh Clerk session may fix. A removed phone stays removed. */
    internal val isRenewable: Boolean
        get() = this is Relay && status == 401 && !isDeviceRemoved

    /** Account deletion stopped partway and is safe to run again. */
    internal val isRetryableDeletion: Boolean
        get() = this is Relay && status == 500 && reason == RelayClient.UPSTREAM_UNAVAILABLE

    /** The machine is offline rather than broken. */
    val isOffline: Boolean
        get() = this is Relay && (code == "environment_endpoint_unavailable" || code == "environment_endpoint_timed_out")

    override fun toString(): String = when (this) {
        is Relay -> "Relay($status, $code, $reason)"
        is Unreachable -> "Unreachable($detail)"
        is InvalidResponse -> "InvalidResponse($detail)"
        is SignedOut -> "SignedOut"
    }

    companion object {
        const val DEVICE_REMOVED_MESSAGE = "This phone was removed from your account. Sign in again to reconnect."

        private fun relayMessage(code: String?, reason: String?): String = when {
            code == "environment_connect_not_authorized" && reason == "environment_link_not_found" ->
                "This computer is no longer linked to your account."
            code == "environment_connect_not_authorized" ->
                "This computer is not ready for SpecWithCode Connect yet. Update SpecWithCode on it and try again."
            code == "environment_endpoint_unavailable" || code == "environment_endpoint_timed_out" -> "The computer is offline."
            code == "auth_invalid" && reason == RelayClient.DEVICE_REMOVED -> DEVICE_REMOVED_MESSAGE
            code == "auth_invalid" -> "Your sign-in expired. Sign in again."
            else -> "SpecWithCode Connect is not available right now."
        }
    }
}
