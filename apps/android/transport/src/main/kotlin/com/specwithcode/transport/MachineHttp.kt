package com.specwithcode.transport

import com.specwithcode.wire.EnvironmentDescriptor
import com.specwithcode.wire.OrchestrationProtocol
import com.specwithcode.wire.ShellSnapshot
import com.specwithcode.wire.ThreadSnapshot
import com.specwithcode.wire.WireDates
import com.specwithcode.wire.WireJson
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Headers
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.time.Instant
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** One HTTP answer, read in full. */
class HttpResponse(val status: Int, val headers: Headers, val body: ByteArray) {
    val isSuccessful: Boolean get() = status in 200..299
}

/** Sends one HTTP request. Swapped for a fake in tests. */
fun interface HttpTransport {
    /** Throws [IOException] for network failures. */
    suspend fun send(request: Request, timeoutMillis: Long): HttpResponse
}

/**
 * OkHttp without cookies, cache or redirects: the server must see only the token, and a
 * token must never follow a redirect to another address.
 */
class OkHttpTransport(val client: OkHttpClient = defaultClient()) : HttpTransport {
    override suspend fun send(request: Request, timeoutMillis: Long): HttpResponse {
        val call = client.newCall(request)
        call.timeout().timeout(timeoutMillis, TimeUnit.MILLISECONDS)
        return call.await()
    }

    companion object {
        fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            .followRedirects(false)
            .followSslRedirects(false)
            .retryOnConnectionFailure(false)
            .build()
    }
}

internal suspend fun Call.await(): HttpResponse = suspendCancellableCoroutine { continuation ->
    continuation.invokeOnCancellation { cancel() }
    enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) {
            if (!continuation.isCancelled) continuation.resumeWithException(e)
        }

        override fun onResponse(call: Call, response: Response) {
            val result = try {
                response.use { HttpResponse(it.code, it.headers, it.body?.bytes() ?: ByteArray(0)) }
            } catch (e: IOException) {
                continuation.resumeWithException(e)
                return
            }
            continuation.resume(result)
        }
    })
}

/** A token from `POST /oauth/token`. A direct token lasts 30 days and cannot be refreshed. */
data class TokenGrant(val accessToken: String, val expiresAt: Instant, val scopes: List<String>) {
    override fun toString(): String = "TokenGrant(expiresAt=$expiresAt, scopes=$scopes)"
}

/** A short-lived ticket for `/ws?wsTicket=`. It can be reused until shortly before it expires. */
data class WebSocketTicket(val ticket: String, val expiresAt: Instant?) {
    override fun toString(): String = "WebSocketTicket(expiresAt=$expiresAt)"
}

/** `GET /api/auth/session`. */
data class SessionState(
    val authenticated: Boolean,
    val scopes: List<String>,
    val expiresAt: Instant? = null,
) {
    fun allows(scope: String): Boolean = scope in scopes
}

/** How a request to a machine is authorized. */
sealed interface MachineAuth {
    val token: String

    /** A direct pairing's token. */
    class Bearer(override val token: String) : MachineAuth

    /** A Connect token, bound to [key]. Every request carries a fresh proof with `ath`. */
    class Dpop(override val token: String, val key: DpopKey) : MachineAuth
}

/** The plain HTTP endpoints of one machine. */
class MachineHttp(
    val transport: HttpTransport = OkHttpTransport(),
    val descriptorTimeoutMillis: Long = 10_000,
    val requestTimeoutMillis: Long = 15_000,
    val snapshotTimeoutMillis: Long = 20_000,
    /** `client_os` in the token exchange. */
    val clientOs: String = "Android",
    private val now: () -> Instant = Instant::now,
) {
    companion object {
        const val TOKEN_EXCHANGE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:token-exchange"
        const val BOOTSTRAP_TOKEN_TYPE = "urn:specweave-studio:params:oauth:token-type:environment-bootstrap"
        const val ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token"

        /** Token lifetime when the server leaves out `expires_in`. */
        const val DEFAULT_TOKEN_LIFETIME_SECONDS = 30L * 86_400

        /** At most this many machines mint a code per roster request. */
        const val PHONE_ROSTER_MINT_LIMIT = 16

        private val FORM = "application/x-www-form-urlencoded".toMediaType()
        private val JSON = "application/json".toMediaType()

        /** The form body for `POST /oauth/token`, encoded like `URLSearchParams`. */
        fun tokenExchangeBody(code: String, clientLabel: String, clientOs: String = "Android"): String = FormQuery.encode(
            listOf(
                "grant_type" to TOKEN_EXCHANGE_GRANT_TYPE,
                "subject_token" to code,
                "subject_token_type" to BOOTSTRAP_TOKEN_TYPE,
                "requested_token_type" to ACCESS_TOKEN_TYPE,
                "client_device_type" to "mobile",
                "client_os" to clientOs,
                "client_label" to clientLabel,
            ),
        )
    }

    /**
     * Fetches the descriptor and requires protocol 2. With [expectedEnvironmentId], an answer
     * from another machine fails before anything else is checked.
     */
    suspend fun descriptor(httpBase: String, expectedEnvironmentId: String? = null): EnvironmentDescriptor {
        val descriptor = rawDescriptor(httpBase)
        if (expectedEnvironmentId != null && descriptor.environmentId != expectedEnvironmentId) {
            throw TransportException.EnvironmentMismatch(expectedEnvironmentId, descriptor.environmentId)
        }
        return when (descriptor.compatibility) {
            EnvironmentDescriptor.Compatibility.Compatible -> descriptor
            is EnvironmentDescriptor.Compatibility.AppTooOld -> throw TransportException.AppTooOld(descriptor)
            is EnvironmentDescriptor.Compatibility.ServerTooOld -> throw TransportException.ServerTooOld(descriptor)
        }
    }

    /** The descriptor without the version check. */
    suspend fun rawDescriptor(httpBase: String): EnvironmentDescriptor {
        val request = request(httpBase, "/.well-known/studio/environment").get().build()
        return decode(EnvironmentDescriptor.serializer(), perform(request, descriptorTimeoutMillis, authenticated = false))
    }

    /** Spends a one-time pairing code for a bearer token. */
    suspend fun exchangePairingCode(code: String, httpBase: String, clientLabel: String): TokenGrant {
        val request = request(httpBase, "/oauth/token")
            .post(tokenExchangeBody(code, clientLabel, clientOs).toRequestBody(FORM))
            .build()
        val data = try {
            perform(request, requestTimeoutMillis, authenticated = false)
        } catch (e: TransportException.Http) {
            if (e.status == 401) throw TransportException.PairingCodeRejected()
            throw e
        }
        return grant(data)
    }

    /**
     * Spends a one-time SpecWithCode Connect credential. The machine accepts it only with a DPoP
     * proof from the key the relay bound it to, and the token it returns is bound to the same key.
     */
    suspend fun redeemConnectCredential(credential: String, httpBase: String, clientLabel: String, key: DpopKey): TokenGrant {
        val url = url(httpBase, "/oauth/token")
        val request = Request.Builder().url(url)
            .header("Accept", "application/json")
            .header("DPoP", DpopProof.make(key, "POST", url, now = now()))
            .post(tokenExchangeBody(credential, clientLabel, clientOs).toRequestBody(FORM))
            .build()
        val data = try {
            perform(request, requestTimeoutMillis, authenticated = false)
        } catch (e: TransportException.Http) {
            if (e.status == 401) throw TransportException.PairingCodeRejected()
            throw e
        }
        return grant(data)
    }

    /** A ticket for one socket open. */
    suspend fun websocketTicket(auth: MachineAuth, httpBase: String): WebSocketTicket {
        val request = authorized(auth, "POST", httpBase, "/api/auth/websocket-ticket", ByteArray(0).toRequestBody(null))
        val body = decode(TicketResponse.serializer(), perform(request, requestTimeoutMillis, authenticated = true))
        return WebSocketTicket(body.ticket, body.expiresAt?.let(WireDates::parse))
    }

    /**
     * Whether the token is still accepted. A rejected token comes back as
     * `authenticated == false` or as [TransportException.NeedsRepair].
     */
    suspend fun session(auth: MachineAuth, httpBase: String): SessionState {
        val request = authorized(auth, "GET", httpBase, "/api/auth/session", null)
        val body = decode(SessionResponse.serializer(), perform(request, requestTimeoutMillis, authenticated = true))
        return SessionState(body.authenticated, body.scopes ?: body.permissions ?: emptyList(), body.expiresAt?.let(WireDates::parse))
    }

    /** `GET /api/orchestration/shell`: the cold shell list. */
    suspend fun shellSnapshot(auth: MachineAuth, httpBase: String): ShellSnapshot {
        val request = authorized(auth, "GET", httpBase, "/api/orchestration/shell", null, orchestration = true)
        return decode(ShellSnapshot.serializer(), perform(request, snapshotTimeoutMillis, authenticated = true))
    }

    /** `GET /api/orchestration/threads/{id}`. Null when the thread was deleted (404). */
    suspend fun threadSnapshot(auth: MachineAuth, httpBase: String, threadId: String): ThreadSnapshot? {
        val url = httpBase.toHttpBase().newBuilder().encodedPath("/").addPathSegments("api/orchestration/threads")
            .addPathSegment(threadId).query(null).fragment(null).build()
        val request = authorized(auth, "GET", url, null, orchestration = true)
        val data = try {
            perform(request, snapshotTimeoutMillis, authenticated = true)
        } catch (e: TransportException.Http) {
            if (e.status == 404) return null
            throw e
        }
        return decode(ThreadSnapshot.serializer(), data)
    }

    /**
     * Posts bytes to a signed URL the machine issued. The token in the path is the credential,
     * so this works on any route.
     */
    suspend fun uploadSigned(body: ByteArray, contentType: String, relativeUrl: String, httpBase: String, timeoutMillis: Long = 120_000) {
        if (!relativeUrl.startsWith("/") || relativeUrl.startsWith("//")) throw TransportException.InvalidAddress(relativeUrl)
        val url = httpBase.toHttpBase().resolve(relativeUrl) ?: throw TransportException.InvalidAddress(relativeUrl)
        val request = Request.Builder().url(url).post(body.toRequestBody(contentType.toMediaType())).build()
        perform(request, timeoutMillis, authenticated = false)
    }

    /**
     * `POST /api/studio/fleet/phone`: the rest of a paired machine's fleet. [mint] names the
     * machines the phone has no working token for. A machine older than the roster answers 404 or 405.
     */
    suspend fun phoneRoster(auth: MachineAuth, httpBase: String, mint: List<String> = emptyList()): PhoneRoster {
        val ids = mint.take(PHONE_ROSTER_MINT_LIMIT)
        val body = if (ids.isEmpty()) JsonObject(emptyMap()) else JsonObject(mapOf("mint" to JsonArray(ids.map(::JsonPrimitive))))
        val request = authorized(auth, "POST", httpBase, "/api/studio/fleet/phone", body.toString().toRequestBody(JSON))
        return decode(PhoneRoster.serializer(), perform(request, requestTimeoutMillis, authenticated = true))
    }

    // Plumbing

    @Serializable
    private class TokenResponse(val access_token: String, val expires_in: Double? = null, val scope: String? = null)

    @Serializable
    private class TicketResponse(val ticket: String, val expiresAt: String? = null)

    @Serializable
    private class SessionResponse(
        val authenticated: Boolean,
        val permissions: List<String>? = null,
        val scopes: List<String>? = null,
        val expiresAt: String? = null,
    )

    private fun grant(data: ByteArray): TokenGrant {
        val body = decode(TokenResponse.serializer(), data)
        val lifetime = body.expires_in?.toLong() ?: DEFAULT_TOKEN_LIFETIME_SECONDS
        val scopes = body.scope.orEmpty().split(' ').filter { it.isNotEmpty() }
        return TokenGrant(body.access_token, now().plusSeconds(lifetime), scopes)
    }

    internal fun url(httpBase: String, path: String): HttpUrl =
        httpBase.toHttpBase().newBuilder().encodedPath(path).query(null).fragment(null).build()

    private fun request(httpBase: String, path: String): Request.Builder =
        Request.Builder().url(url(httpBase, path)).header("Accept", "application/json")

    private fun authorized(auth: MachineAuth, method: String, httpBase: String, path: String, body: RequestBody?, orchestration: Boolean = false) =
        authorized(auth, method, url(httpBase, path), body, orchestration)

    private fun authorized(auth: MachineAuth, method: String, url: HttpUrl, body: RequestBody?, orchestration: Boolean = false): Request {
        val builder = Request.Builder().url(url).header("Accept", "application/json").method(method, body)
        when (auth) {
            is MachineAuth.Bearer -> builder.header("Authorization", "Bearer ${auth.token}")
            is MachineAuth.Dpop -> builder
                .header("Authorization", "DPoP ${auth.token}")
                .header("DPoP", DpopProof.make(auth.key, method, url, accessToken = auth.token, now = now()))
        }
        if (orchestration) builder.header(OrchestrationProtocol.HEADER, OrchestrationProtocol.VERSION.toString())
        return builder.build()
    }

    /**
     * Runs the request under a hard deadline and maps failures. `authenticated` requests turn
     * any 401 (unless Team rules refused it) into [TransportException.NeedsRepair].
     */
    internal suspend fun perform(request: Request, timeoutMillis: Long, authenticated: Boolean): ByteArray {
        val response = try {
            transport.send(request, timeoutMillis)
        } catch (e: IOException) {
            throw TransportException.fromIo(e)
        }
        if (response.isSuccessful) return response.body
        throw errorFor(response, authenticated)
    }

    internal fun errorFor(response: HttpResponse, authenticated: Boolean): TransportException {
        val body = runCatching { WireJson.parseToJsonElement(response.body.decodeToString()).jsonObject }.getOrNull()
        fun field(name: String) = (body?.get(name) as? JsonPrimitive)?.takeIf { it.isString }?.content
        val teamRules = field("teamRulesMessage")
        // Team rules said no: the credential is fine, so this is never "pair again".
        if (!teamRules.isNullOrEmpty()) return TransportException.TeamRules(teamRules)
        val reason = field("reason")
        // Every 401 on an authenticated call means the credential is gone (missing, invalid, or
        // the device must be approved again), as the TypeScript client treats it: never retried.
        if (authenticated && response.status == 401) {
            return TransportException.NeedsRepair(reason)
        }
        val retryAfter = if (response.status == 429) {
            (body?.get("retryAfterSeconds") as? JsonPrimitive)?.content?.toDoubleOrNull()?.toLong()
                ?: response.headers["retry-after"]?.trim()?.toLongOrNull()
        } else {
            null
        }
        return TransportException.Http(response.status, reason ?: field("code"), retryAfter)
    }

    internal fun <T> decode(serializer: KSerializer<T>, data: ByteArray): T = try {
        WireJson.decodeFromString(serializer, data.decodeToString())
    } catch (e: IllegalArgumentException) {
        throw TransportException.InvalidResponse(e.javaClass.simpleName)
    }
}

/**
 * The other machines of a paired machine's fleet, from `POST /api/studio/fleet/phone`. A machine
 * the phone asked to `mint` for carries a one-time pairing code the phone spends on that machine.
 */
@Serializable
data class PhoneRoster(val hub: Hub, val machines: List<Machine>) {
    @Serializable
    data class Hub(val environmentId: String, val label: String)

    @Serializable
    data class Route(
        /** `lan`, `tailnet` or `fleet` (the machine's private fleet address). */
        val kind: String,
        val httpBaseUrl: String,
    )

    @Serializable
    data class Pairing(val code: String, val expiresAt: String)

    @Serializable
    data class Machine(
        val environmentId: String,
        val label: String,
        /** Best first: the private fleet address, then the addresses the machine reported. */
        val routes: List<Route> = emptyList(),
        val pairing: Pairing? = null,
        /** Why no code came back: `unreachable`, `identity_mismatch`, `pairing_unavailable` or `update_required`. */
        val problem: String? = null,
    )
}
