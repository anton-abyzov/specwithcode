package com.specwithcode.transport

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption

/** One address of a machine. */
@Serializable
data class MachineRoute(
    /** Origin with a trailing slash, e.g. `http://192.168.1.20:8319/`. */
    val httpBase: String,
    val wsBase: String,
    val kind: RouteKind = RouteKind.classify(httpBase.toHttpUrlOrNull()?.host.orEmpty()),
    /** Reported by the server in `directEndpoints` rather than paired by the user. */
    val learned: Boolean = false,
    /**
     * Address of the route whose pairing issued the token this route uses: its own address
     * for a saved route, the reporting socket's issuer for a learned one. A token never goes
     * to a route with another issuer. Records saved without it are their own issuer.
     */
    val issuer: String = addressOf(httpBase),
) {
    /** The address without a trailing slash, for comparisons and display. */
    val address: String get() = addressOf(httpBase)

    companion object {
        fun addressOf(httpBase: String): String = httpBase.trimEnd('/')

        /** A route for an http(s) origin; the ws form is derived. Null when it is not one. */
        fun fromHttpBase(address: String, learned: Boolean = false, issuer: String? = null): MachineRoute? {
            val (http, ws) = try {
                PairingLink.origin(address)
            } catch (_: PairingLinkException) {
                return null
            }
            return MachineRoute(http, ws, learned = learned, issuer = issuer ?: addressOf(http))
        }
    }
}

/** A paired machine as the app remembers it. The token lives in the [CredentialStore]. */
@Serializable
data class MachineRecord(
    val environmentId: String,
    val label: String,
    val routes: List<MachineRoute>,
    val enabled: Boolean = true,
    /** Last shell sequence applied, for `subscribeShell{afterSequence}` on resume. */
    val lastShellSequence: Int? = null,
    /** The machine's SpecWithCode Connect tunnel, when it came from the signed-in account. */
    val connectRoute: MachineRoute? = null,
) {
    /** Routes fastest kind first; saved order holds within a kind, learned routes after saved ones. */
    val rankedRoutes: List<MachineRoute>
        get() = routes.withIndex().sortedWith(
            compareBy<IndexedValue<MachineRoute>>({ it.value.kind.rank }, { it.value.learned }, { it.index }),
        ).map { it.value }

    /** Adds a route, or replaces the one with the same address. */
    fun upsertRoute(route: MachineRoute): MachineRecord {
        val i = routes.indexOfFirst { it.address == route.address }
        return copy(routes = if (i >= 0) routes.toMutableList().also { it[i] = route } else routes + route)
    }

    /**
     * Applies the addresses a socket reported (`ServerConfig.directEndpoints[].httpBaseUrl`).
     * `issuer` is the issuer of the route that socket was opened on. Learned routes of that
     * issuer it no longer reports are dropped; other issuers' learned routes and saved routes
     * are kept; loopback and non-http addresses are ignored.
     */
    fun mergeLearnedRoutes(reported: List<String>, issuer: String): MachineRecord {
        val reportedRoutes = LinkedHashMap<String, MachineRoute>()
        for (raw in reported) {
            val trimmed = raw.trim()
            val scheme = PairingLink.schemePrefix(trimmed)
            if (scheme != "http" && scheme != "https") continue
            val route = MachineRoute.fromHttpBase(trimmed, learned = true, issuer = issuer) ?: continue
            if (route.kind == RouteKind.LOOPBACK) continue
            reportedRoutes[route.address] = route
        }
        val seen = routes.filter { !it.learned }.map { it.address }.toMutableSet()
        val next = mutableListOf<MachineRoute>()
        for (route in routes) {
            if (!route.learned) {
                next += route
                continue
            }
            if (route.address in seen) continue
            val reportedRoute = reportedRoutes[route.address]
            if (reportedRoute != null) {
                seen += route.address
                next += reportedRoute
            } else if (route.issuer != issuer) {
                seen += route.address
                next += route
            }
        }
        for ((address, route) in reportedRoutes) {
            if (seen.add(address)) next += route
        }
        return copy(routes = next)
    }
}

/** The list of paired machines, persisted atomically as a JSON array. */
class MachineRegistry(val file: File) {
    private val mutex = Mutex()
    private var cache: List<MachineRecord>? = null

    private val json = Json {
        ignoreUnknownKeys = true
        prettyPrint = true
        encodeDefaults = true
        explicitNulls = false
    }

    /** All machines in the order they were paired. A missing or unreadable file is an empty list. */
    suspend fun all(): List<MachineRecord> = mutex.withLock { loadLocked() }

    suspend fun machine(environmentId: String): MachineRecord? = all().firstOrNull { it.environmentId == environmentId }

    /** Inserts or replaces the record with the same environment id. */
    suspend fun upsert(record: MachineRecord) = mutex.withLock {
        val list = loadLocked().toMutableList()
        val i = list.indexOfFirst { it.environmentId == record.environmentId }
        if (i >= 0) list[i] = record else list += record
        saveLocked(list)
    }

    /** Records a pairing: adds the route to an existing machine, or adds the machine. */
    suspend fun recordPairing(environmentId: String, label: String, route: MachineRoute, resumeConnection: Boolean = true): MachineRecord =
        mutex.withLock {
            val list = loadLocked().toMutableList()
            val i = list.indexOfFirst { it.environmentId == environmentId }
            var record = if (i >= 0) list[i] else MachineRecord(environmentId, label, emptyList())
            record = record.copy(label = label, enabled = if (resumeConnection) true else record.enabled)
            // A paired route is saved and uses the token its own pairing issued.
            record = record.upsertRoute(route.copy(learned = false, issuer = route.address))
            if (i >= 0) list[i] = record else list += record
            saveLocked(list)
            record
        }

    /** Merges account discovery. Never overwrites a local pause. */
    suspend fun recordConnect(environmentId: String, label: String, route: MachineRoute): MachineRecord = mutex.withLock {
        val list = loadLocked().toMutableList()
        val i = list.indexOfFirst { it.environmentId == environmentId }
        var record = (if (i >= 0) list[i] else MachineRecord(environmentId, label, emptyList())).copy(connectRoute = route)
        if (record.routes.isEmpty() && label.isNotEmpty()) record = record.copy(label = label)
        if (i >= 0) list[i] = record else list += record
        saveLocked(list)
        record
    }

    /** Applies a change to one machine; returns the updated record, or null when it is unknown. */
    suspend fun update(environmentId: String, change: (MachineRecord) -> MachineRecord): MachineRecord? = mutex.withLock {
        val list = loadLocked().toMutableList()
        val i = list.indexOfFirst { it.environmentId == environmentId }
        if (i < 0) return@withLock null
        val next = change(list[i])
        if (next != list[i]) {
            list[i] = next
            saveLocked(list)
        }
        next
    }

    suspend fun mergeLearnedRoutes(reported: List<String>, issuer: String, environmentId: String): MachineRecord? =
        update(environmentId) { it.mergeLearnedRoutes(reported, issuer) }

    suspend fun setEnabled(enabled: Boolean, environmentId: String) {
        update(environmentId) { it.copy(enabled = enabled) }
    }

    suspend fun setLastShellSequence(sequence: Int?, environmentId: String) {
        update(environmentId) { it.copy(lastShellSequence = sequence) }
    }

    suspend fun remove(environmentId: String) = mutex.withLock {
        val list = loadLocked()
        val next = list.filter { it.environmentId != environmentId }
        if (next.size != list.size) saveLocked(next)
    }

    private suspend fun loadLocked(): List<MachineRecord> {
        cache?.let { return it }
        val loaded = withContext(Dispatchers.IO) {
            try {
                json.decodeFromString(ListSerializer(MachineRecord.serializer()), file.readText())
            } catch (_: Exception) {
                emptyList()
            }
        }
        cache = loaded
        return loaded
    }

    private suspend fun saveLocked(list: List<MachineRecord>) {
        val text = json.encodeToString(ListSerializer(MachineRecord.serializer()), list)
        withContext(Dispatchers.IO) {
            file.parentFile?.mkdirs()
            val tmp = File(file.parentFile, "${file.name}.tmp")
            tmp.writeText(text)
            Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
        }
        cache = list
    }
}
