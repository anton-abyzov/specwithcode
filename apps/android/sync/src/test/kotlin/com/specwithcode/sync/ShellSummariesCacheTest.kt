package com.specwithcode.sync

import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotSame
import kotlin.test.assertSame

/** The per-machine cache gives exactly what a full rebuild gives, and reuses unchanged machines. */
class ShellSummariesCacheTest {
    private fun machine(id: String, label: String, threads: Int, online: Boolean = true, titleSuffix: String = "") = ShellSummaries.Machine(
        environmentId = id,
        label = label,
        online = online,
        snapshot = TestData.shell(
            threads = (1..threads).map { TestData.thread(id = "thr_$it", title = "Thread $it$titleSuffix") }
                // One thread runs on the other machine, so placement reads the directory.
                .mapIndexed { i, t -> if (i == 0) t.copy(executionMachineId = if (id == "env-a") "env-b" else "env-a") else t },
        ),
        lastSeenAt = Instant.parse("2026-11-01T00:00:00Z"),
    )

    @Test fun cachedBuildsMatchFullBuildsAcrossChanges() {
        val cache = ShellSummaries.Cache()
        var a = machine("env-a", "Mac Studio", 3)
        var b = machine("env-b", "MacBook", 2)
        fun check(includeAide: Boolean = true) =
            assertEquals(ShellSummaries.build(listOf(a, b), includeAide), ShellSummaries.build(listOf(a, b), includeAide, cache))

        check()
        // A chunk on one machine.
        b = machine("env-b", "MacBook", 2, titleSuffix = " (edited)")
        check()
        // The other machine goes offline: placements on the first change too.
        b = b.copy(online = false)
        check()
        a = a.copy(label = "Studio")
        check()
        check(includeAide = false)
        b = machine("env-b", "MacBook", 3)
        check()
        // A machine removed.
        assertEquals(ShellSummaries.build(listOf(a)), ShellSummaries.build(listOf(a), cache = cache))
    }

    @Test fun anUnchangedMachineKeepsItsRowsWhenAnotherOneChanges() {
        val cache = ShellSummaries.Cache()
        val a = machine("env-a", "Mac Studio", 3)
        val first = ShellSummaries.build(listOf(a, machine("env-b", "MacBook", 2)), cache = cache)
        val second = ShellSummaries.build(listOf(a, machine("env-b", "MacBook", 2, titleSuffix = " (edited)")), cache = cache)
        val rowA = { out: ShellSummaries.Output -> out.recentThreads.first { it.ref.environmentId == "env-a" && it.ref.threadId == "thr_2" } }
        val rowB = { out: ShellSummaries.Output -> out.recentThreads.first { it.ref.environmentId == "env-b" && it.ref.threadId == "thr_2" } }
        assertSame(rowA(first), rowA(second))
        assertNotSame(rowB(first), rowB(second))
        assertEquals("Thread 2 (edited)", rowB(second).title)
    }
}
