package com.specwithcode.android.app.connect

import com.specwithcode.android.app.secure.SecureValues
import com.specwithcode.sync.ConnectAccount
import com.specwithcode.transport.ConnectConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import okhttp3.FormBody
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.IOException
import java.time.Instant
import java.util.Base64
import java.util.concurrent.TimeUnit

/** A sign-in failure with a sentence the UI shows as is. */
class ConnectSignInException(message: String) : Exception(message)

/**
 * SpecWithCode Connect sign-in through the hosted account service's frontend API, the way its
 * native SDKs talk to it: a client token kept on the phone, OAuth in a Custom Tab that
 * redirects to `clerk://<applicationId>.callback`, then short-lived session tokens from the
 * relay's JWT template. The client token and session id are sealed with a Keystore key.
 *
 * The vendor's Android SDK is not used: its current release needs a newer Kotlin and OkHttp
 * than this app builds with.
 */
class ClerkConnectAccount(
    private val config: ConnectConfig,
    private val values: SecureValues,
    /** Opens the provider's sign-in page and suspends until the redirect comes back. */
    private val browser: suspend (String) -> String,
    private val redirectUrl: String,
    private val http: OkHttpClient = OkHttpClient.Builder().callTimeout(30, TimeUnit.SECONDS).build(),
    private val now: () -> Instant = Instant::now,
) : ConnectAccount {
    private val api: HttpUrl = frontendApi(config.publishableKey).toHttpUrl()
    private val json = Json { ignoreUnknownKeys = true }

    @Volatile private var cachedToken: Pair<String, Instant>? = null

    override fun isSignedIn(): Boolean = values.get(SESSION) != null

    override fun accountLabel(): String? = values.get(LABEL)

    override suspend fun signIn() {
        val provider = config.oauthProviders.firstOrNull() ?: "google"
        val start = request(
            "POST", "client/sign_ins",
            form = mapOf("strategy" to "oauth_$provider", "redirect_url" to redirectUrl, "action_complete_redirect_url" to redirectUrl),
        )
        val signIn = start.obj("response") ?: throw ConnectSignInException(GENERIC)
        val signInId = signIn.string("id") ?: throw ConnectSignInException(GENERIC)
        val page = signIn.obj("first_factor_verification")?.string("external_verification_redirect_url")
            ?: throw ConnectSignInException(GENERIC)

        val callback = browser(page)
        val nonce = queryParameter(callback, "rotating_token_nonce")
        val finished = request("GET", "client/sign_ins/$signInId", query = listOfNotNull(nonce?.let { "rotating_token_nonce" to it }))
        val result = finished.obj("response")
        var sessionId = result?.string("created_session_id")
        var client = finished.obj("client")
        // A Google account with no SpecWithCode account yet: finish by creating one.
        if (sessionId == null && result?.obj("first_factor_verification")?.string("status") == "transferable") {
            val signUp = request("POST", "client/sign_ups", form = mapOf("transfer" to "true"))
            sessionId = signUp.obj("response")?.string("created_session_id")
            client = signUp.obj("client") ?: client
        }
        sessionId = sessionId ?: client?.string("last_active_session_id")
            ?: throw ConnectSignInException("Sign-in didn't finish. Try again.")
        val label = client?.let { accountEmail(it, sessionId) }
        // Sealing touches the Keystore and DataStore: never on the main thread.
        withContext(Dispatchers.IO) {
            values.put(SESSION, sessionId)
            values.put(LABEL, label)
        }
        cachedToken = null
    }

    override suspend fun signOut() = withContext(Dispatchers.IO) {
        val sessionId = values.get(SESSION)
        if (sessionId != null) runCatching { request("POST", "client/sessions/$sessionId/remove") }
        values.put(SESSION, null)
        values.put(LABEL, null)
        values.put(CLIENT, null)
        cachedToken = null
    }

    override suspend fun sessionToken(refresh: Boolean): String? = withContext(Dispatchers.IO) { readSessionToken(refresh) }

    private suspend fun readSessionToken(refresh: Boolean): String? {
        val sessionId = values.get(SESSION) ?: return null
        cachedToken?.let { (token, expires) -> if (!refresh && expires.isAfter(now().plusSeconds(30))) return token }
        val response = try {
            request("POST", "client/sessions/$sessionId/tokens/${config.jwtTemplate}")
        } catch (e: HttpFailure) {
            if (e.status == 401 || e.status == 404) {
                // The session ended elsewhere (signed out on the web, or expired).
                values.put(SESSION, null)
                cachedToken = null
                return null
            }
            throw ConnectSignInException(e.message ?: GENERIC)
        }
        val jwt = response.string("jwt") ?: return null
        cachedToken = jwt to (expiry(jwt) ?: now().plusSeconds(50))
        return jwt
    }

    // Frontend API

    private class HttpFailure(val status: Int, message: String) : IOException(message)

    private suspend fun request(
        method: String,
        path: String,
        form: Map<String, String>? = null,
        query: List<Pair<String, String>> = emptyList(),
    ): JsonObject = withContext(Dispatchers.IO) {
        val url = api.newBuilder().addPathSegment("v1").addPathSegments(path).addQueryParameter("_is_native", "1").apply {
            query.forEach { (name, value) -> addQueryParameter(name, value) }
        }.build()
        val builder = Request.Builder().url(url).header("Accept", "application/json").header("x-mobile", "1")
        values.get(CLIENT)?.let { builder.header("Authorization", it) }
        when (method) {
            "GET" -> builder.get()
            else -> builder.method(method, FormBody.Builder().apply { form?.forEach { (k, v) -> add(k, v) } }.build())
        }
        val response = try {
            http.newCall(builder.build()).execute()
        } catch (e: IOException) {
            throw ConnectSignInException("SpecWithCode Connect could not be reached. Check your connection.")
        }
        response.use {
            // The service hands the native client its token in this header and rotates it.
            it.header("Authorization")?.takeIf { token -> token.isNotBlank() }?.let { token -> values.put(CLIENT, token) }
            val body = it.body?.string().orEmpty()
            val parsed = runCatching { json.parseToJsonElement(body).jsonObject }.getOrNull()
            if (!it.isSuccessful) {
                val error = (parsed?.get("errors") as? kotlinx.serialization.json.JsonArray)?.firstOrNull() as? JsonObject
                val message = error?.string("long_message") ?: error?.string("message") ?: GENERIC
                throw HttpFailure(it.code, message)
            }
            parsed ?: throw ConnectSignInException(GENERIC)
        }
    }

    private fun accountEmail(client: JsonObject, sessionId: String): String? {
        val sessions = client["sessions"] as? kotlinx.serialization.json.JsonArray ?: return null
        val session = sessions.mapNotNull { it as? JsonObject }.firstOrNull { it.string("id") == sessionId } ?: return null
        val user = session.obj("user") ?: return null
        val primary = user.string("primary_email_address_id")
        val emails = (user["email_addresses"] as? kotlinx.serialization.json.JsonArray)?.mapNotNull { it as? JsonObject } ?: emptyList()
        return (emails.firstOrNull { it.string("id") == primary } ?: emails.firstOrNull())?.string("email_address")
    }

    private fun expiry(jwt: String): Instant? = runCatching {
        val payload = String(Base64.getUrlDecoder().decode(jwt.split('.')[1].let { it + "=".repeat((4 - it.length % 4) % 4) }))
        val exp = (json.parseToJsonElement(payload).jsonObject["exp"] as JsonPrimitive).content.toLong()
        Instant.ofEpochSecond(exp)
    }.getOrNull()

    private fun JsonObject.obj(name: String): JsonObject? = this[name] as? JsonObject

    private fun JsonObject.string(name: String): String? = (this[name] as? JsonPrimitive)?.takeIf { it.isString }?.content

    companion object {
        private const val CLIENT = "connect:client"
        private const val SESSION = "connect:session"
        private const val LABEL = "connect:label"
        private const val GENERIC = "Sign-in failed. Try again."

        /** One query parameter of the `clerk://` redirect, which OkHttp's URL parser refuses. */
        fun queryParameter(url: String, name: String): String? {
            val query = runCatching { java.net.URI(url).rawQuery }.getOrNull() ?: return null
            return query.split('&').map { it.split('=', limit = 2) }.firstOrNull { it[0] == name }
                ?.getOrNull(1)?.let { java.net.URLDecoder.decode(it, "UTF-8") }
        }

        /** `pk_live_<base64 of "clerk.example.com$">` names the frontend API host. */
        fun frontendApi(publishableKey: String): String {
            val encoded = publishableKey.split('_').getOrNull(2) ?: throw IllegalArgumentException("Bad publishable key")
            val padded = encoded + "=".repeat((4 - encoded.length % 4) % 4)
            val host = String(Base64.getDecoder().decode(padded)).trimEnd('$')
            return "https://$host"
        }
    }
}
