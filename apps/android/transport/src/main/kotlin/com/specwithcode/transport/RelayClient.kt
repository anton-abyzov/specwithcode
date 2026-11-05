package com.specwithcode.transport

import com.specwithcode.wire.WireJson
import kotlinx.coroutines.delay
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.time.Instant
import java.util.concurrent.ConcurrentHashMap
import kotlin.coroutines.cancellation.CancellationException

/** The Clerk session behind SpecWithCode Connect. The app implements it with the Clerk SDK. */
fun interface ConnectSessionTokenProvider {
    /** A Clerk session JWT from the relay's JWT template, null when signed out. `refresh` skips any cache. */
    suspend fun sessionToken(refresh: Boolean): String?
}

/** The machine's managed tunnel hostname. */
@Serializable
data class ConnectEndpoint(val httpBaseUrl: String, val wsBaseUrl: String, val providerKind: String? = null)

/** A machine linked to the signed-in account (`GET /v1/environments`). */
@Serializable
data class ConnectEnvironment(
    val environmentId: String,
    val label: String,
    val endpoint: ConnectEndpoint,
    val linkedAt: String? = null,
)

/** `POST /v1/environments/:id/status`. */
@Serializable
data class ConnectEnvironmentStatus(
    val environmentId: String,
    val status: String,
    /** When the relay last probed the machine. */
    val checkedAt: String,
    val offlineReason: String? = null,
    val error: String? = null,
) {
    val isOnline: Boolean get() = status == "online"
}

/** `POST /v1/environments/:id/connect`: a one-time credential bound to this device's key. */
@Serializable
data class ConnectBootstrap(
    val environmentId: String,
    val endpoint: ConnectEndpoint,
    val credential: String,
    val expiresAt: String,
) {
    override fun toString(): String = "ConnectBootstrap($environmentId, expiresAt=$expiresAt)"
}

/** `POST /v1/mobile/devices`, as `RelayDeviceRegistrationRequest` with `platform: "android"`. */
@Serializable
data class ConnectDeviceRegistration(
    val deviceId: String,
    val label: String,
    val androidApiLevel: Int,
    val preferences: Preferences,
    val platform: String = "android",
    val appVersion: String? = null,
    val pushToken: String? = null,
    /** The hardware model shown in "Your phones". */
    val model: String? = null,
) {
    @Serializable
    data class Preferences(
        val notificationsEnabled: Boolean,
        val liveActivitiesEnabled: Boolean = false,
        val notifyOnApproval: Boolean = true,
        val notifyOnInput: Boolean = true,
        val notifyOnCompletion: Boolean = true,
        val notifyOnFailure: Boolean = true,
    )
}

/** One phone on the account (`GET /v1/client/phones`). */
@Serializable
data class ConnectPhoneRecord(
    val deviceId: String,
    val label: String,
    val platform: String = "ios",
    val model: String? = null,
    val appVersion: String? = null,
    val iosMajorVersion: Int? = null,
    val androidApiLevel: Int? = null,
    val bundleId: String? = null,
    val lastSeenAt: String,
    /** The request came with the Clerk session this phone last used. */
    val current: Boolean = false,
)

/** `DELETE /v1/client/phones/:deviceId`. */
@Serializable
data class ConnectPhoneRemoval(val removed: Boolean, val current: Boolean)

/** `DELETE /v1/client/account`. */
@Serializable
data class ConnectAccountDeletion(val deleted: Boolean, val environmentCount: Int = 0)

/**
 * Talks to the SpecWithCode Connect relay: exchanges the Clerk session for DPoP-bound relay
 * tokens, lists linked machines and asks for one-time machine credentials. The relay never
 * carries machine traffic.
 */
class RelayClient(
    val config: ConnectConfig,
    private val session: ConnectSessionTokenProvider,
    val keys: DpopKeyStore,
    private val transport: HttpTransport = OkHttpTransport(),
    private val timeoutMillis: Long = 15_000,
    /** Sent with each token exchange so the relay refuses a removed phone. */
    val deviceId: String? = null,
    private val now: () -> Instant = Instant::now,
) {
    companion object {
        const val CONNECT_SCOPE = "environment:connect"
        const val STATUS_SCOPE = "environment:status"
        const val REGISTRATION_SCOPE = "mobile:registration"
        const val CLIENT_ID = "studio-mobile"
        const val UPSTREAM_UNAVAILABLE = "upstream_unavailable"

        /** `RelayAuthInvalidReason` for a phone removed from the account. */
        const val DEVICE_REMOVED = "device_removed"
        const val SUBJECT_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:jwt"

        /** A relay token is renewed this long before it expires. */
        const val REFRESH_SKEW_SECONDS = 60L

        private val FORM = "application/x-www-form-urlencoded".toMediaType()
        private val JSON = "application/json".toMediaType()

        /** The form body for `POST /v1/client/dpop-token`. */
        fun tokenExchangeBody(sessionToken: String, resource: String, scopes: List<String>, deviceId: String? = null): String {
            val fields = mutableListOf(
                "grant_type" to MachineHttp.TOKEN_EXCHANGE_GRANT_TYPE,
                "subject_token" to sessionToken,
                "subject_token_type" to SUBJECT_TOKEN_TYPE,
                "requested_token_type" to MachineHttp.ACCESS_TOKEN_TYPE,
                "resource" to resource,
                "scope" to scopes.joinToString(" "),
                "client_id" to CLIENT_ID,
            )
            if (!deviceId.isNullOrEmpty()) fields += "device_id" to deviceId
            return FormQuery.encode(fields)
        }
    }

    private data class CachedToken(val token: String, val expiresAt: Instant, val thumbprint: String)

    private val tokens = ConcurrentHashMap<String, CachedToken>()

    /** The DPoP key's thumbprint, which tokens and credentials are bound to. */
    fun thumbprint(): String = keys.loadOrCreate().thumbprint

    /** Forgets cached relay tokens, e.g. after sign-out. */
    fun reset() = tokens.clear()

    // Environments

    suspend fun environments(): List<ConnectEnvironment> =
        decode(EnvironmentsResponse.serializer(), bearerRequest(listOf("v1", "environments"), "GET")).environments

    suspend fun status(environmentId: String): ConnectEnvironmentStatus = decode(
        ConnectEnvironmentStatus.serializer(),
        dpopRequest(listOf("v1", "environments", environmentId, "status"), "POST", listOf(STATUS_SCOPE), "{}"),
    )

    /** A one-time credential for the machine, bound to this device's key. */
    suspend fun connect(environmentId: String, deviceId: String? = this.deviceId): ConnectBootstrap {
        val body = WireJson.encodeToString(ConnectBody.serializer(), ConnectBody(deviceId, thumbprint()))
        val data = dpopRequest(listOf("v1", "environments", environmentId, "connect"), "POST", listOf(CONNECT_SCOPE), body)
        val bootstrap = decode(ConnectBootstrap.serializer(), data)
        if (bootstrap.environmentId != environmentId) throw ConnectError.InvalidResponse("The relay answered for another computer.")
        return bootstrap
    }

    // Mobile devices

    suspend fun registerDevice(registration: ConnectDeviceRegistration) {
        val body = WireJson.encodeToString(ConnectDeviceRegistration.serializer(), registration)
        dpopRequest(listOf("v1", "mobile", "devices"), "POST", listOf(REGISTRATION_SCOPE), body)
    }

    suspend fun unregisterDevice(deviceId: String) {
        dpopRequest(listOf("v1", "mobile", "devices", deviceId), "DELETE", listOf(REGISTRATION_SCOPE), null)
    }

    // Phones

    suspend fun phones(): List<ConnectPhoneRecord> =
        decode(PhonesResponse.serializer(), bearerRequest(listOf("v1", "client", "phones"), "GET")).phones

    /** The relay stops notifications to the phone, ends its sign-in and refuses it until it signs in again. */
    suspend fun removePhone(deviceId: String): ConnectPhoneRemoval {
        val result = decode(
            ConnectPhoneRemoval.serializer(),
            bearerRequest(listOf("v1", "client", "phones", deviceId), "DELETE"),
        )
        if (result.current) tokens.clear()
        return result
    }

    /**
     * Whether the phone holding this DPoP key was removed from its account. Needs only a DPoP
     * proof, so a phone whose Clerk session the removal ended can still learn why.
     */
    suspend fun removalStatus(): Boolean {
        val key = keys.loadOrCreate()
        val url = url(listOf("v1", "client", "removal-status"))
        val request = Request.Builder().url(url).header("Accept", "application/json")
            .header("DPoP", DpopProof.make(key, "POST", url, now = now()))
            .post(ByteArray(0).toRequestBody(null)).build()
        return decode(RemovalResponse.serializer(), send(request)).removed
    }

    // Account

    /**
     * `DELETE /v1/client/account`. It is idempotent, so a `500 upstream_unavailable` is retried
     * after each delay in [retryDelaysMillis].
     */
    suspend fun deleteAccount(retryDelaysMillis: List<Long> = listOf(1_000, 2_000, 4_000)): ConnectAccountDeletion {
        val delays = ArrayDeque(retryDelaysMillis)
        while (true) {
            try {
                val result = decode(ConnectAccountDeletion.serializer(), bearerRequest(listOf("v1", "client", "account"), "DELETE"))
                if (!result.deleted) throw ConnectError.InvalidResponse("The relay did not delete the account.")
                tokens.clear()
                return result
            } catch (e: ConnectError) {
                if (!e.isRetryableDeletion) throw e
                delay(delays.removeFirstOrNull() ?: throw e)
            }
        }
    }

    // Token exchange

    /** A DPoP-bound relay token for [scopes], from the cache when it has time left. */
    suspend fun accessToken(scopes: List<String>, refresh: Boolean): Pair<String, DpopKey> {
        val key = keys.loadOrCreate()
        val cacheKey = scopes.sorted().joinToString(" ")
        val cached = tokens[cacheKey]
        if (!refresh && cached != null && cached.thumbprint == key.thumbprint &&
            cached.expiresAt.isAfter(now().plusSeconds(REFRESH_SKEW_SECONDS))
        ) {
            return cached.token to key
        }
        val jwt = sessionToken(refresh)
        val url = url(listOf("v1", "client", "dpop-token"))
        val request = Request.Builder().url(url)
            .header("Accept", "application/json")
            .header("DPoP", DpopProof.make(key, "POST", url, now = now()))
            .post(tokenExchangeBody(jwt, config.relayUrl, scopes, deviceId).toRequestBody(FORM))
            .build()
        val response = decode(TokenResponse.serializer(), send(request))
        tokens[cacheKey] = CachedToken(response.access_token, now().plusSeconds(response.expires_in.toLong()), key.thumbprint)
        return response.access_token to key
    }

    /** A request authorized by the Clerk session JWT alone, refreshed once on 401. */
    private suspend fun bearerRequest(segments: List<String>, method: String): ByteArray {
        var refresh = false
        while (true) {
            val jwt = sessionToken(refresh)
            val url = url(segments)
            val request = Request.Builder().url(url).header("Accept", "application/json")
                .header("Authorization", "Bearer $jwt")
                .method(method, null)
                .build()
            try {
                return send(request)
            } catch (e: ConnectError) {
                if (!e.isRenewable || refresh) throw e
                refresh = true
            }
        }
    }

    /** Sends a DPoP request, renewing the relay token and the Clerk session once when rejected. */
    private suspend fun dpopRequest(segments: List<String>, method: String, scopes: List<String>, body: String?): ByteArray {
        var refresh = false
        while (true) {
            val (token, key) = accessToken(scopes, refresh)
            val url = url(segments)
            val request = Request.Builder().url(url).header("Accept", "application/json")
                .header("Authorization", "DPoP $token")
                .header("DPoP", DpopProof.make(key, method, url, accessToken = token, now = now()))
                .method(method, body?.toRequestBody(JSON))
                .build()
            try {
                return send(request)
            } catch (e: ConnectError) {
                if (!e.isRenewable || refresh) throw e
                refresh = true
            }
        }
    }

    private suspend fun sessionToken(refresh: Boolean): String {
        val token = session.sessionToken(refresh)
        if (token.isNullOrEmpty()) {
            tokens.clear()
            throw ConnectError.SignedOut()
        }
        return token
    }

    // Plumbing

    @Serializable
    private class EnvironmentsResponse(val environments: List<ConnectEnvironment>)

    @Serializable
    private class PhonesResponse(val phones: List<ConnectPhoneRecord>)

    @Serializable
    private class RemovalResponse(val removed: Boolean)

    @Serializable
    private class ConnectBody(val deviceId: String? = null, val clientProofKeyThumbprint: String)

    @Serializable
    private class TokenResponse(val access_token: String, val token_type: String? = null, val expires_in: Double)

    /** The relay origin plus path segments, each percent-encoded. */
    private fun url(segments: List<String>): HttpUrl {
        val base = config.relayUrl.toHttpUrlOrNull() ?: throw ConnectError.InvalidResponse("Bad relay address")
        val builder = base.newBuilder().query(null).fragment(null)
        segments.filter { it.isNotEmpty() }.forEach { builder.addPathSegment(it) }
        return builder.build()
    }

    private suspend fun send(request: Request): ByteArray {
        val response = try {
            transport.send(request, timeoutMillis)
        } catch (e: CancellationException) {
            throw e
        } catch (e: IOException) {
            throw ConnectError.Unreachable(TransportException.fromIo(e).toString())
        }
        if (response.isSuccessful) return response.body
        val body = runCatching { WireJson.parseToJsonElement(response.body.decodeToString()).jsonObject }.getOrNull()
        fun field(name: String) = (body?.get(name) as? JsonPrimitive)?.takeIf { it.isString }?.content
        val error = ConnectError.Relay(response.status, field("code"), field("reason"))
        // A removed phone's tokens are worthless; the next sign-in exchanges anew.
        if (error.isDeviceRemoved) tokens.clear()
        throw error
    }

    private fun <T> decode(serializer: KSerializer<T>, data: ByteArray): T = try {
        WireJson.decodeFromString(serializer, data.decodeToString())
    } catch (e: IllegalArgumentException) {
        throw ConnectError.InvalidResponse(e.javaClass.simpleName)
    }
}
