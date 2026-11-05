package com.specwithcode.sync

import com.specwithcode.wire.ProjectShell
import com.specwithcode.wire.ShellSnapshot
import com.specwithcode.wire.ShellStreamItem
import com.specwithcode.wire.ThreadLocation

// Port of packages/client-runtime/src/state/shellReducer.ts.

object ShellReducer {
    /**
     * Merges a full shell snapshot into prior state.
     *
     * An authoritative snapshot (no [resolvedRepositoryIdentityRoots]) replaces structure and
     * sequence, even when lower than what is held, but keeps a prior repository identity while
     * the new one is still unresolved for the same workspace root.
     *
     * An enrichment snapshot (roots present) only patches `repositoryIdentity` on current
     * projects. It never replaces projects, threads, archives or the sequence.
     */
    fun merge(previous: ShellSnapshot?, next: ShellSnapshot, resolvedRepositoryIdentityRoots: List<String>? = null): ShellSnapshot {
        if (previous == null) return next
        val roots = resolvedRepositoryIdentityRoots
        if (roots != null) {
            val resolved = roots.toSet()
            val byId = LinkedHashMap<String, ProjectShell>()
            for (project in next.projects) byId.putIfAbsent(project.id, project)
            return previous.copy(
                projects = previous.projects.map { project ->
                    val candidate = byId[project.id]
                    when {
                        candidate == null || candidate.workspaceRoot != project.workspaceRoot -> project
                        project.workspaceRoot in resolved -> project.copy(repositoryIdentity = candidate.repositoryIdentity)
                        project.repositoryIdentity == null && candidate.repositoryIdentity != null ->
                            project.copy(repositoryIdentity = candidate.repositoryIdentity)
                        else -> project
                    }
                },
            )
        }
        val priorById = LinkedHashMap<String, ProjectShell>()
        for (project in previous.projects) priorById.putIfAbsent(project.id, project)
        return next.copy(projects = next.projects.map { retainRepositoryIdentity(priorById[it.id], it) })
    }

    /**
     * Applies one committed delta, keeping a thread in at most one of the active and archived
     * lists. Snapshots, `synchronized`, unknown kinds and items at or below the snapshot sequence
     * leave the snapshot unchanged.
     */
    fun apply(item: ShellStreamItem, snapshot: ShellSnapshot): ShellSnapshot = when (item) {
        ShellStreamItem.Synchronized, is ShellStreamItem.Snapshot, is ShellStreamItem.Unknown -> snapshot

        is ShellStreamItem.ProjectUpdated -> if (item.sequence <= snapshot.snapshotSequence) snapshot else {
            // Enrichment is async: a mutation can land with a null identity after an earlier
            // snapshot resolved it. Keep it for the same workspace root.
            val previous = snapshot.projects.firstOrNull { it.id == item.project.id }
            snapshot.copy(
                projects = upsert(snapshot.projects, retainRepositoryIdentity(previous, item.project)) { it.id },
                snapshotSequence = item.sequence,
            )
        }

        is ShellStreamItem.ProjectRemoved -> if (item.sequence <= snapshot.snapshotSequence) snapshot else {
            snapshot.copy(projects = snapshot.projects.filter { it.id != item.projectId }, snapshotSequence = item.sequence)
        }

        is ShellStreamItem.ThreadUpdated -> if (item.sequence <= snapshot.snapshotSequence) snapshot else {
            val thread = item.thread
            val existing = snapshot.threads.firstOrNull { it.id == thread.id }
            if (item.location == ThreadLocation.Active && existing == thread) {
                snapshot.copy(snapshotSequence = item.sequence)
            } else {
                val threads = if (item.location == ThreadLocation.Active) {
                    upsert(snapshot.threads, thread) { it.id }
                } else {
                    snapshot.threads.filter { it.id != thread.id }
                }
                // The archive has its own bounded query. Archive-located deltas are dropped from
                // the normal shell instead of growing it.
                snapshot.copy(
                    snapshotSequence = item.sequence,
                    threads = threads,
                    archivedThreads = snapshot.archivedThreads.filter { it.id != thread.id },
                )
            }
        }

        is ShellStreamItem.ThreadRemoved -> if (item.sequence <= snapshot.snapshotSequence) snapshot else {
            snapshot.copy(
                threads = snapshot.threads.filter { it.id != item.threadId },
                archivedThreads = snapshot.archivedThreads.filter { it.id != item.threadId },
                snapshotSequence = item.sequence,
            )
        }
    }

    internal fun retainRepositoryIdentity(previous: ProjectShell?, next: ProjectShell): ProjectShell {
        val identity = previous?.repositoryIdentity
        if (next.repositoryIdentity != null || identity == null || previous.workspaceRoot != next.workspaceRoot) return next
        return next.copy(repositoryIdentity = identity)
    }
}

/** Replaces the item with the same id in place, or appends it. */
internal inline fun <T, K> upsert(items: List<T>, item: T, id: (T) -> K): List<T> {
    val key = id(item)
    val index = items.indexOfFirst { id(it) == key }
    if (index < 0) return items + item
    return items.toMutableList().also { it[index] = item }
}

/** One machine's shell as the stream builds it. */
class ShellState(snapshot: ShellSnapshot? = null) {
    var snapshot: ShellSnapshot? = snapshot
        private set

    /** Catch-up finished on the current subscription. */
    var isSynchronized: Boolean = false
        private set

    /** False after a known item could not be read: the next subscription takes a fresh snapshot. */
    private var cursorValid = true

    /** Whether this subscription waits for a `synchronized` marker before it counts as live. */
    private var awaitsMarker = true

    /** The sequence to resume from, when a snapshot is held and nothing was lost since. */
    val resumeSequence: Int? get() = if (cursorValid) snapshot?.snapshotSequence else null

    /**
     * Call before subscribing again. Without the completion marker ([awaitsMarker] false) a
     * resumed subscription counts as live at once, and a fresh one once its snapshot lands,
     * as client-runtime shell.ts does.
     */
    fun beginSubscription(awaitsMarker: Boolean = true) {
        this.awaitsMarker = awaitsMarker
        isSynchronized = !awaitsMarker && resumeSequence != null
    }

    /** Forgets the cursor so the next subscription starts from a full snapshot. */
    fun invalidateCursor() {
        cursorValid = false
    }

    /** Applies one stream item. Returns true when the snapshot or the synchronized flag changed. */
    fun apply(item: ShellStreamItem): Boolean = when (item) {
        ShellStreamItem.Synchronized -> {
            val changed = !isSynchronized
            isSynchronized = true
            changed
        }
        is ShellStreamItem.Snapshot -> {
            val merged = ShellReducer.merge(snapshot, item.snapshot, item.resolvedRepositoryIdentityRoots)
            var changed = merged != snapshot
            snapshot = merged
            if (item.resolvedRepositoryIdentityRoots == null) {
                cursorValid = true
                if (!awaitsMarker && !isSynchronized) {
                    isSynchronized = true
                    changed = true
                }
            }
            changed
        }
        is ShellStreamItem.Unknown -> false
        else -> {
            // Deltas before the first snapshot have nothing to apply to.
            val current = snapshot
            if (current == null) {
                false
            } else {
                val next = ShellReducer.apply(item, current)
                snapshot = next
                next != current
            }
        }
    }

    /** Seeds the state from `GET /api/orchestration/shell`, as an authoritative snapshot. */
    fun seed(next: ShellSnapshot): Boolean = apply(ShellStreamItem.Snapshot(next))
}
