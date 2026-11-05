package com.specwithcode.sync

import com.specwithcode.wire.DomainEvent
import com.specwithcode.wire.ProjectShell
import com.specwithcode.wire.RepositoryIdentity
import com.specwithcode.wire.ShellSnapshot
import com.specwithcode.wire.ThreadShell
import com.specwithcode.wire.ThreadStreamItem
import com.specwithcode.wire.ThreadStreamItemSerializer
import com.specwithcode.wire.TurnItem
import com.specwithcode.wire.WireDates
import com.specwithcode.wire.WireJson
import kotlinx.serialization.KSerializer
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonElement
import java.time.Instant

/** Recorded fixtures shared with the wire tests (`wire/src/test/resources/fixtures`), as the Swift `TestData`. */
object TestData {
    fun text(name: String): String {
        val stream = TestData::class.java.getResourceAsStream("/fixtures/$name") ?: error("Missing fixture $name")
        return stream.use { it.readBytes().toString(Charsets.UTF_8) }
    }

    fun json(name: String): JsonElement = WireJson.parseToJsonElement(text(name))

    fun <T> decode(serializer: KSerializer<T>, name: String): T = WireJson.decodeFromString(serializer, text(name))

    fun date(iso: String): Instant = WireDates.parse(iso) ?: error("Bad date $iso")

    /** `v2Project` in the TypeScript tests. */
    fun project(id: String = "proj_1", title: String? = null, root: String? = null, identity: RepositoryIdentity? = null): ProjectShell {
        val base = decode(ProjectShell.serializer(), "projectShell.json")
        return base.copy(id = id, title = title ?: base.title, workspaceRoot = root ?: base.workspaceRoot, repositoryIdentity = identity)
    }

    /** `v2ThreadShell` in the TypeScript tests. */
    fun thread(id: String = "thr_1", projectId: String = "proj_1", title: String? = null, updatedAt: String? = null): ThreadShell {
        val base = decode(ThreadShell.serializer(), "threadShell.min.json")
        return base.copy(id = id, projectId = projectId, title = title ?: base.title, updatedAt = updatedAt?.let(::date) ?: base.updatedAt)
    }

    /** `v2ShellSnapshot` in the TypeScript tests: one project and one thread at sequence 0. */
    fun shell(sequence: Int = 0, threads: List<ThreadShell>? = null, projects: List<ProjectShell>? = null): ShellSnapshot =
        ShellSnapshot(snapshotSequence = sequence, threads = threads ?: listOf(thread()), projects = projects ?: listOf(project()))

    val identity = RepositoryIdentity(canonicalKey = "github.com/example/repo")
    val otherIdentity = RepositoryIdentity(canonicalKey = "github.com/example/other")

    fun threadSnapshot(): ThreadStreamItem = decode(ThreadStreamItemSerializer, "threadStreamItem.snapshot.json")

    fun threadEvents(): List<ThreadStreamItem> = decode(ListSerializer(ThreadStreamItemSerializer), "threadEvents.json")

    /** The event at [index] of threadEvents.json. */
    fun event(index: Int): Pair<Int, DomainEvent> {
        val item = threadEvents()[index] as? ThreadStreamItem.Event ?: error("Item $index is not an event")
        return item.sequence to item.event
    }

    fun turnItems(): List<TurnItem> = decode(ListSerializer(TurnItem.serializer()), "turnItems.json")

    fun turnItem(id: String): TurnItem = turnItems().firstOrNull { it.id == id } ?: error("No item $id")

    /** A state holding the thread snapshot fixture. */
    fun threadState(): ThreadState = ThreadState().also { it.apply(threadSnapshot()) }
}
