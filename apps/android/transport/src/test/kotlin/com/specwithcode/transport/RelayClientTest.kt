package com.specwithcode.transport

import com.specwithcode.wire.WireJson
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Before
import org.junit.Test
import java.time.Instant
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

class RelayClientTest {
    private val server = MockWebServer()
    private val now = Instant.parse("2026-11-05T10:00:00Z")
    private val key = SoftwareDpopKey()
    private val sessionCalls = AtomicInteger()
    private lateinit var relay: RelayClient
    private lateinit var relayUrl: String

    @Before
    fun setUp() {
        server.start()
        relayUrl = server.url("/").toString().trimEnd('/')
        relay = RelayClient(
            ConnectConfig("pk_test_x", relayUrl),
            session = { refresh ->
                sessionCalls.incrementAndGet()
                if (refresh) "clerk-jwt-2" else "clerk-jwt-1"
            },
            keys = InMemoryDpopKeyStore(key),
            deviceId = "device-1",
            now = { now },
        )
    }

    @After
    fun tearDown() = server.shutdown()

    private fun taken(): RecordedRequest = server.takeRequest(5, TimeUnit.SECONDS)!!

    private fun payload(proof: String) = WireJson.parseToJsonElement(String(Base64Url.decode(proof.split('.')[1])!!)).jsonObject

    private fun token(value: String = "relay-token") = json("""{"access_token":"$value","issued_token_type":"x","token_type":"DPoP","expires_in":1800}""")

    @Test
    fun exchangesTheClerkSessionForADpopToken() = runBlocking {
        server.enqueue(token())
        val (value, usedKey) = relay.accessToken(listOf(RelayClient.CONNECT_SCOPE), refresh = false)
        assertEquals("relay-token", value)
        assertEquals(key.thumbprint, usedKey.thumbprint)
        val request = taken()
        assertEquals("/v1/client/dpop-token", request.path)
        assertNull(request.getHeader("Authorization"))
        val proof = payload(request.getHeader("DPoP")!!)
        assertNull(proof["ath"])
        assertEquals("$relayUrl/v1/client/dpop-token", proof["htu"]!!.jsonPrimitive.content)
        assertEquals(
            "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange&subject_token=clerk-jwt-1" +
                "&subject_token_type=urn%3Aietf%3Aparams%3Aoauth%3Atoken-type%3Ajwt" +
                "&requested_token_type=urn%3Aietf%3Aparams%3Aoauth%3Atoken-type%3Aaccess_token" +
                "&resource=${FormQuery.encodeComponent(relayUrl)}&scope=environment%3Aconnect&client_id=studio-mobile&device_id=device-1",
            request.body.readUtf8(),
        )
        // Cached while it has time left.
        relay.accessToken(listOf(RelayClient.CONNECT_SCOPE), refresh = false)
        assertEquals(1, server.requestCount)
    }

    @Test
    fun listsEnvironmentsWithTheClerkJwt() = runBlocking {
        server.enqueue(
            json(
                """{"environments":[{"environmentId":"env-1","label":"M4","endpoint":{"httpBaseUrl":"https://m4.tunnels.example.com","wsBaseUrl":"wss://m4.tunnels.example.com","providerKind":"cloudflare"},"linkedAt":"2026-11-01T00:00:00.000Z"}]}""",
            ),
        )
        val environments = relay.environments()
        assertEquals("M4", environments.single().label)
        val route = ConnectAuthorizer.route(environments.single().endpoint)!!
        assertEquals(ConnectAuthorizer.ISSUER, route.issuer)
        assertEquals(RouteKind.PUBLIC, route.kind)
        val request = taken()
        assertEquals("/v1/environments", request.path)
        assertEquals("Bearer clerk-jwt-1", request.getHeader("Authorization"))
    }

    @Test
    fun aRejectedClerkSessionIsRefreshedOnce() = runBlocking {
        server.enqueue(json("""{"code":"auth_invalid","reason":"expired"}""", 401))
        server.enqueue(json("""{"environments":[]}"""))
        assertTrue(relay.environments().isEmpty())
        taken()
        assertEquals("Bearer clerk-jwt-2", taken().getHeader("Authorization"))
        server.enqueue(json("""{"code":"auth_invalid"}""", 401))
        server.enqueue(json("""{"code":"auth_invalid"}""", 401))
        assertIs<ConnectError.Relay>(assertFailsWith<ConnectError> { relay.environments() })
        Unit
    }

    @Test
    fun connectBootstrapIsDpopBoundWithAth() = runBlocking {
        server.enqueue(token())
        server.enqueue(
            json(
                """{"environmentId":"env 1","endpoint":{"httpBaseUrl":"https://m4.tunnels.example.com","wsBaseUrl":"wss://m4.tunnels.example.com"},"credential":"one-time","expiresAt":"2026-11-05T10:01:00.000Z"}""",
            ),
        )
        val bootstrap = relay.connect("env 1")
        assertEquals("one-time", bootstrap.credential)
        taken()
        val request = taken()
        assertEquals("/v1/environments/env%201/connect", request.path)
        assertEquals("DPoP relay-token", request.getHeader("Authorization"))
        val proof = payload(request.getHeader("DPoP")!!)
        assertEquals(DpopProof.accessTokenHash("relay-token"), proof["ath"]!!.jsonPrimitive.content)
        assertEquals("$relayUrl/v1/environments/env%201/connect", proof["htu"]!!.jsonPrimitive.content)
        assertEquals("""{"deviceId":"device-1","clientProofKeyThumbprint":"${key.thumbprint}"}""", request.body.readUtf8())
    }

    @Test
    fun aBootstrapForAnotherMachineIsRefused() = runBlocking {
        server.enqueue(token())
        server.enqueue(json("""{"environmentId":"other","endpoint":{"httpBaseUrl":"https://x","wsBaseUrl":"wss://x"},"credential":"c","expiresAt":"x"}"""))
        assertFailsWith<ConnectError.InvalidResponse> { relay.connect("env-1") }
        Unit
    }

    @Test
    fun relayErrorsMapToConnectErrors() = runBlocking {
        server.enqueue(token())
        server.enqueue(json("""{"code":"environment_endpoint_unavailable"}""", 503))
        val offline = assertFailsWith<ConnectError.Relay> { relay.connect("env-1") }
        assertTrue(offline.isOffline)
        assertEquals("The computer is offline.", offline.message)
        server.enqueue(json("""{"code":"environment_connect_not_authorized","reason":"environment_link_not_found"}""", 403))
        val unlinked = assertFailsWith<ConnectError.Relay> { relay.connect("env-1") }
        assertTrue(unlinked.isPermanent)
        assertEquals("This computer is no longer linked to your account.", unlinked.message)
        server.enqueue(json("""{"code":"auth_invalid","reason":"device_removed"}""", 401))
        val removed = assertFailsWith<ConnectError.Relay> { relay.connect("env-1") }
        assertTrue(removed.isDeviceRemoved && removed.isPermanent)
    }

    @Test
    fun signedOutMeansNoSession() = runBlocking {
        val signedOut = RelayClient(ConnectConfig("pk_test_x", relayUrl), session = { null }, keys = InMemoryDpopKeyStore())
        assertTrue(assertFailsWith<ConnectError.SignedOut> { signedOut.environments() }.isPermanent)
        assertEquals(0, server.requestCount)
    }

    @Test
    fun registersAnAndroidDevice() = runBlocking {
        server.enqueue(token())
        server.enqueue(json("{}"))
        relay.registerDevice(
            ConnectDeviceRegistration("device-1", "Pixel 9", androidApiLevel = 36, preferences = ConnectDeviceRegistration.Preferences(notificationsEnabled = true)),
        )
        assertTrue(taken().body.readUtf8().contains("scope=mobile%3Aregistration"))
        val body = WireJson.parseToJsonElement(taken().body.readUtf8()).jsonObject
        assertEquals("android", body["platform"]!!.jsonPrimitive.content)
        assertEquals(36, body["androidApiLevel"]!!.jsonPrimitive.content.toInt())
        assertNull(body["iosMajorVersion"])
        assertNull(body["pushToken"])
    }

    @Test
    fun theAuthorizerRedeemsTheCredentialAndCachesTheToken() = runBlocking {
        val machine = MockWebServer()
        machine.start()
        try {
            val machineBase = machine.url("/").toString()
            server.enqueue(token())
            server.enqueue(
                json(
                    """{"environmentId":"env-1","endpoint":{"httpBaseUrl":"$machineBase","wsBaseUrl":"${machineBase.replaceFirst("http", "ws")}"},"credential":"one-time","expiresAt":"x"}""",
                ),
            )
            machine.enqueue(json("""{"access_token":"env-token","token_type":"DPoP","expires_in":3600,"scope":"orchestration:read"}"""))
            val store = InMemoryCredentialStore()
            val authorizer = ConnectAuthorizer(relay, store, MachineHttp(now = { now }), clientLabel = "Pixel", now = { now })
            val route = MachineRoute(machineBase, machineBase.replaceFirst("http", "ws"), issuer = ConnectAuthorizer.ISSUER)
            val (credential, usedKey) = authorizer.credential("env-1", route, refresh = false)
            assertEquals("env-token", credential.token)
            assertEquals(key.thumbprint, usedKey.thumbprint)
            assertEquals("env-token", store.credential("env-1", ConnectAuthorizer.ISSUER)?.token)
            val redeem = machine.takeRequest(5, TimeUnit.SECONDS)!!
            assertEquals("/oauth/token", redeem.path)
            assertNull(payload(redeem.getHeader("DPoP")!!)["ath"])
            assertTrue(redeem.body.readUtf8().contains("subject_token=one-time"))
            // A second call uses the cached token.
            authorizer.credential("env-1", route, refresh = false)
            assertEquals(1, machine.requestCount)
        } finally {
            machine.shutdown()
        }
    }

    @Test
    fun configFallsBackToTheHostedService() {
        assertEquals(ConnectConfig.hosted, ConnectConfig.resolve(null, null))
        assertEquals(ConnectConfig.hosted, ConnectConfig.resolve("$(CLERK_KEY)", "https://relay.example.com"))
        assertEquals(ConnectConfig.hosted, ConnectConfig.resolve("pk_live_x", "http://relay.example.com"))
        val custom = ConnectConfig.resolve("pk_test_abc", "https://relay.example.com/", oauthProviders = "Google, github")
        assertEquals("https://relay.example.com", custom.relayUrl)
        assertEquals(listOf("google", "github"), custom.oauthProviders)
        assertEquals("studio-relay", custom.jwtTemplate)
        assertEquals("https://relay.spec-weave.com", ConnectConfig.hosted.relayUrl)
        assertEquals("pk_live_Y2xlcmsuc3BlYy13ZWF2ZS5jb20k", ConnectConfig.hosted.publishableKey)
    }
}
