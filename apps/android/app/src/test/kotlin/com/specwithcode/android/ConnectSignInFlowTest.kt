package com.specwithcode.android

import com.specwithcode.android.app.connect.ClerkConnectAccount
import com.specwithcode.android.app.secure.SealedValueFile
import com.specwithcode.android.app.secure.SecretBox
import com.specwithcode.android.app.secure.SecureValues
import com.specwithcode.transport.ConnectConfig
import com.specwithcode.transport.DpopProof
import com.specwithcode.transport.Ecdsa
import com.specwithcode.transport.SoftwareDpopKey
import com.specwithcode.android.app.secure.KeystoreDpopKey
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Before
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.util.Base64
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

private class PlainBox : SecretBox {
    override fun seal(plain: ByteArray) = plain.reversedArray()
    override fun open(sealed: ByteArray) = sealed.reversedArray()
}

private class Memory : SealedValueFile {
    val values = LinkedHashMap<String, String>()
    override fun readAll() = values.toMap()
    override fun write(key: String, value: String?) {
        if (value == null) values.remove(key) else values[key] = value
    }
}

/** The frontend API sign-in against a fake account service, with a fake browser. */
class ConnectSignInFlowTest {
    private val server = MockWebServer()
    private val seen = CopyOnWriteArrayList<RecordedRequest>()
    private val redirect = "clerk://com.specwithcode.android.callback"

    @Before
    fun setUp() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                seen += request
                val path = request.requestUrl!!.encodedPath
                return when {
                    request.method == "POST" && path == "/v1/client/sign_ins" -> json(
                        """{"response":{"id":"sia_1","status":"needs_first_factor","first_factor_verification":{"status":"unverified","external_verification_redirect_url":"https://accounts.google.com/o/oauth2/auth?x=1"}},"client":{"id":"client_1"}}""",
                    ).setHeader("Authorization", "client-token-1")
                    request.method == "GET" && path == "/v1/client/sign_ins/sia_1" -> json(
                        """{"response":{"id":"sia_1","status":"complete","created_session_id":"sess_1"},"client":{"id":"client_1","last_active_session_id":"sess_1","sessions":[{"id":"sess_1","user":{"primary_email_address_id":"em_1","email_addresses":[{"id":"em_1","email_address":"anton@example.com"}]}}]}}""",
                    ).setHeader("Authorization", "client-token-2")
                    request.method == "POST" && path == "/v1/client/sessions/sess_1/tokens/studio-relay" -> json("""{"jwt":"${jwt()}"}""")
                    request.method == "POST" && path == "/v1/client/sessions/sess_1/remove" -> json("""{"response":{"id":"sess_1","status":"removed"}}""")
                    else -> MockResponse().setResponseCode(404).setBody("""{"errors":[{"message":"not found"}]}""")
                }
            }
        }
        server.start()
    }

    @After
    fun tearDown() = server.shutdown()

    private fun json(body: String) = MockResponse().setHeader("Content-Type", "application/json").setBody(body)

    private fun jwt(): String {
        val enc = Base64.getUrlEncoder().withoutPadding()
        return enc.encodeToString("""{"alg":"RS256"}""".toByteArray()) + "." +
            enc.encodeToString("""{"exp":${System.currentTimeMillis() / 1000 + 60},"aud":"relay"}""".toByteArray()) + ".sig"
    }

    private fun account(values: SecureValues, browser: suspend (String) -> String): ClerkConnectAccount {
        val host = server.hostName + ":" + server.port
        val key = "pk_test_" + Base64.getEncoder().encodeToString("$host$".toByteArray())
        val config = ConnectConfig(publishableKey = key, relayUrl = "https://relay.example.com", oauthProviders = listOf("google"))
        // The frontend API is https in production; the fake server speaks http on localhost.
        val client = OkHttpClient.Builder().addInterceptor { chain ->
            val request = chain.request()
            chain.proceed(request.newBuilder().url(request.url.newBuilder().scheme("http").build()).build())
        }.build()
        return ClerkConnectAccount(config, values, browser, redirect, client)
    }

    @Test fun signInRedirectsThroughTheBrowserAndKeepsTheSession() = runBlocking {
        val values = SecureValues(Memory(), PlainBox())
        val opened = CopyOnWriteArrayList<String>()
        val account = account(values) { url ->
            opened += url
            "$redirect?rotating_token_nonce=nonce-1"
        }
        assertFalse(account.isSignedIn())
        account.signIn()
        assertTrue(account.isSignedIn())
        assertEquals("anton@example.com", account.accountLabel())
        assertEquals(listOf("https://accounts.google.com/o/oauth2/auth?x=1"), opened)

        val start = seen.first { it.requestUrl!!.encodedPath == "/v1/client/sign_ins" }
        assertEquals("1", start.requestUrl!!.queryParameter("_is_native"))
        val form = start.body.readUtf8()
        assertTrue("strategy=oauth_google" in form, form)
        assertTrue("redirect_url=clerk%3A%2F%2Fcom.specwithcode.android.callback" in form, form)
        val finish = seen.first { it.requestUrl!!.encodedPath == "/v1/client/sign_ins/sia_1" }
        assertEquals("nonce-1", finish.requestUrl!!.queryParameter("rotating_token_nonce"))
        // The client token from the first answer goes back on the next request.
        assertEquals("client-token-1", finish.getHeader("Authorization"))

        val token = account.sessionToken(refresh = false)
        assertTrue(token!!.endsWith(".sig"))
        val tokenRequest = seen.last()
        assertEquals("client-token-2", tokenRequest.getHeader("Authorization"))
        // Cached until close to expiry.
        assertEquals(token, account.sessionToken(refresh = false))
        assertEquals(1, seen.count { it.requestUrl!!.encodedPath.endsWith("/tokens/studio-relay") })

        account.signOut()
        assertFalse(account.isSignedIn())
        assertNull(account.sessionToken(refresh = false))
    }

    @Test fun frontendApiHostComesFromThePublishableKey() {
        assertEquals("https://clerk.spec-weave.com", ClerkConnectAccount.frontendApi(ConnectConfig.hosted.publishableKey))
        assertEquals("clerk.spec-weave.com", ClerkConnectAccount.frontendApi(ConnectConfig.hosted.publishableKey).toHttpUrl().host)
    }

    @Test fun keystoreKeyShapeSignsVerifiableRawSignatures() {
        // The Keystore key class wraps any EC key pair; with a software pair it can run here.
        val pair = SoftwareDpopKey.generate()
        val key = KeystoreDpopKey(pair.private, pair.public as ECPublicKey)
        assertEquals(32, key.publicX.size)
        assertEquals(32, key.publicY.size)
        val raw = key.sign("hello".toByteArray())
        assertEquals(64, raw.size)
        val verifier = Signature.getInstance("SHA256withECDSA").apply { initVerify(pair.public); update("hello".toByteArray()) }
        assertTrue(verifier.verify(Ecdsa.rawToDer(raw)))
        // A full proof verifies the same way.
        val proof = DpopProof.make(key, "POST", "https://relay.example.com/v1/client/dpop-token".toHttpUrl())
        assertEquals(3, proof.split('.').size)
    }
}
