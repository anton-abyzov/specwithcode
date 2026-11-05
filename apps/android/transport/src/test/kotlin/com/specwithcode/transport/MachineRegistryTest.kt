package com.specwithcode.transport

import kotlinx.coroutines.runBlocking
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.time.Instant
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class MachineRegistryTest {
    private fun route(address: String, learned: Boolean = false, issuer: String? = null) =
        MachineRoute.fromHttpBase(address, learned, issuer)!!

    @Test
    fun ranksFastestKindFirstAndSavedBeforeLearned() {
        val record = MachineRecord(
            "env-1", "M4",
            listOf(
                route("https://m4.example.com"),
                route("http://100.64.1.2:8319"),
                route("http://192.168.1.21:8319", learned = true, issuer = "http://192.168.1.20:8319"),
                route("http://192.168.1.20:8319"),
            ),
        )
        assertEquals(
            listOf("http://192.168.1.20:8319", "http://192.168.1.21:8319", "http://100.64.1.2:8319", "https://m4.example.com"),
            record.rankedRoutes.map { it.address },
        )
    }

    @Test
    fun mergesLearnedRoutesPerIssuer() {
        val lan = route("http://192.168.1.20:8319")
        val record = MachineRecord(
            "env-1", "M4",
            listOf(
                lan,
                route("http://10.0.0.5:8319", learned = true, issuer = lan.address),
                route("http://10.0.0.9:8319", learned = true, issuer = "https://other.example.com"),
            ),
        )
        val merged = record.mergeLearnedRoutes(
            listOf("http://100.64.1.2:8319/", "http://127.0.0.1:8319", "ftp://x", "http://192.168.1.20:8319", "http://100.64.1.2:8319"),
            issuer = lan.address,
        )
        assertEquals(
            listOf("http://192.168.1.20:8319", "http://10.0.0.9:8319", "http://100.64.1.2:8319"),
            merged.routes.map { it.address },
        )
        val learned = merged.routes.last()
        assertTrue(learned.learned)
        assertEquals(lan.address, learned.issuer)
        assertEquals(RouteKind.TAILNET, learned.kind)
    }

    @Test
    fun bestCredentialPrefersAnUnexpiredToken() {
        val now = Instant.parse("2026-11-05T10:00:00Z")
        val lan = route("http://192.168.1.20:8319")
        val tail = route("http://100.64.1.2:8319")
        val store = InMemoryCredentialStore().apply {
            save(MachineCredential("old", now.minusSeconds(1)), "env-1", lan.address)
            save(MachineCredential("new", now.plusSeconds(86_400 * 3)), "env-1", tail.address)
        }
        val record = MachineRecord("env-1", "M4", listOf(lan, tail))
        assertEquals("new", store.bestCredential(record, now)?.token)
        assertEquals(3, store.bestCredential(record, now)?.daysLeft(now))
        store.remove("env-1")
        assertNull(store.bestCredential(record, now))
    }

    @Test
    fun persistsAtomicallyAndReadsOldRecords() = runBlocking {
        val dir = Files.createTempDirectory("registry").toFile()
        try {
            val file = File(dir, "machines.json")
            // A record saved before routes carried an issuer.
            file.writeText("""[{"environmentId":"env-1","label":"M4","routes":[{"httpBase":"http://192.168.1.20:8319/","wsBase":"ws://192.168.1.20:8319/","kind":"lan","learned":false}],"enabled":true,"future":1}]""")
            val registry = MachineRegistry(file)
            val old = registry.machine("env-1")!!
            assertEquals("http://192.168.1.20:8319", old.routes.single().issuer)
            registry.recordPairing("env-1", "M4 Max", route("https://m4.tail1234.ts.net"))
            registry.setLastShellSequence(17, "env-1")
            registry.recordConnect("env-2", "Box", ConnectAuthorizer.route(ConnectEndpoint("https://box.example.com", "wss://box.example.com"))!!)
            val reread = MachineRegistry(file).all()
            assertEquals(listOf("env-1", "env-2"), reread.map { it.environmentId })
            assertEquals("M4 Max", reread[0].label)
            assertEquals(17, reread[0].lastShellSequence)
            assertEquals(2, reread[0].routes.size)
            assertEquals(ConnectAuthorizer.ISSUER, reread[1].connectRoute?.issuer)
            registry.remove("env-2")
            assertEquals(1, MachineRegistry(file).all().size)
            assertTrue(dir.listFiles()!!.none { it.name.endsWith(".tmp") })
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun anUnreadableFileIsAnEmptyList() = runBlocking {
        val file = File.createTempFile("machines", ".json").apply { writeText("{not json"); deleteOnExit() }
        assertTrue(MachineRegistry(file).all().isEmpty())
    }
}
