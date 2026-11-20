package com.specwithcode.sync

import com.specwithcode.sync.TranscriptRow.Kind
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertNull

class TranscriptFoldingTest {
    private fun user(id: String) = TranscriptRow(id, Kind.User("Do it"))
    private fun reply(id: String) = TranscriptRow(id, Kind.Assistant("Reply $id", streaming = false))
    private fun thought(id: String) = TranscriptRow(id, Kind.Reasoning("Thinking", streaming = false, seconds = 3))
    private fun command(id: String, status: ToolStatus = ToolStatus.Completed) =
        TranscriptRow(id, Kind.Tool("Ran pkcheck", "pkcheck: not authorized", "terminal", status))
    private fun edit(id: String) = TranscriptRow(id, Kind.Tool("Edited a.ts", "+1 −1", "pencil", ToolStatus.Completed))
    private fun search(id: String) = TranscriptRow(id, Kind.Tool("Searched for fold", null, "magnifyingglass", ToolStatus.Completed))
    private fun web(id: String) = TranscriptRow(id, Kind.Tool("Searched the web", null, "globe", ToolStatus.Completed))
    private fun tool(id: String) = TranscriptRow(id, Kind.Tool("Chrome snapshot", null, "wrench.and.screwdriver", ToolStatus.Completed))
    private fun agent(id: String, running: Boolean) = TranscriptRow(id, Kind.Subagent("Review the diff", ThreadRef("env", "child-$id"), isRunning = running))

    private fun fold(rows: List<TranscriptRow>, id: String) = rows.first { it.id == id }.kind as Kind.Fold

    private val settled = listOf(user("u1"), thought("t1"), reply("note"), command("c1"), command("c2", ToolStatus.Failed), edit("e1"), reply("final"))

    @Test fun everythingShowsEveryRow() {
        assertEquals(settled, TranscriptFolding.rows(settled, TimelineDetail.Verbose, isRunning = false))
    }

    @Test fun aFinishedTurnFoldsBehindOneRowWithItsFailures() {
        val rows = TranscriptFolding.rows(settled, TimelineDetail.Normal, isRunning = false)
        assertEquals(listOf("u1", "fold:u1", "final"), rows.map { it.id })
        assertEquals(Kind.Fold("Worked", "Ran 2 commands · Edited 1 file", failures = 1, expanded = false, running = false), rows[1].kind)
    }

    @Test fun theSummaryCountsEveryCategory() {
        val steps = listOf(command("c1"), command("c2"), command("c3"), edit("e1"), search("s1"), web("w1"), tool("m1"), agent("a1", running = false))
        assertEquals("Ran 3 commands · Edited 1 file · 2 searches · 1 tool call · 1 agent", TranscriptFolding.summary(steps))
        assertNull(TranscriptFolding.summary(listOf(thought("t1"), reply("n1"))))
    }

    @Test fun openingAFoldShowsItsStepsAndClosingHidesThem() {
        val opened = TranscriptFolding.rows(settled, TimelineDetail.Normal, isRunning = false, expandedFolds = setOf("fold:u1"))
        assertEquals(listOf("u1", "fold:u1", "t1", "note", "c1", "c2", "e1", "final"), opened.map { it.id })
        assertEquals(true, fold(opened, "fold:u1").expanded)
        // Results only never shows thinking, opened or not.
        val concise = TranscriptFolding.rows(settled, TimelineDetail.Concise, isRunning = false, expandedFolds = setOf("fold:u1"))
        assertEquals(listOf("u1", "fold:u1", "note", "c1", "c2", "e1", "final"), concise.map { it.id })
        val closed = TranscriptFolding.rows(settled, TimelineDetail.Normal, isRunning = false, expandedFolds = emptySet())
        assertEquals(listOf("u1", "fold:u1", "final"), closed.map { it.id })
    }

    @Test fun aFoldOpenedWhileRunningIsClosedOnceTheTurnSettles() {
        val running = listOf(user("u1"), thought("t1"), reply("note"), command("c1"), reply("latest"), command("c2", ToolStatus.Running))
        val live = TranscriptFolding.rows(running, TimelineDetail.Concise, isRunning = true)
        assertEquals(listOf("u1", "latest", "live:u1"), live.map { it.id })
        val liveId = live.last().id
        val opened = TranscriptFolding.rows(running, TimelineDetail.Concise, isRunning = true, expandedFolds = setOf(liveId))
        assertEquals(listOf("u1", "latest", "live:u1", "c1", "c2"), opened.map { it.id })
        // The turn settles with the same rows; the fold the person opened was the running one.
        val done = running.dropLast(1) + command("c2") + reply("final")
        val settledRows = TranscriptFolding.rows(done, TimelineDetail.Concise, isRunning = false, expandedFolds = setOf(liveId))
        assertEquals(listOf("u1", "fold:u1", "final"), settledRows.map { it.id })
        assertEquals(false, fold(settledRows, "fold:u1").expanded)
        assertNotEquals(TranscriptFolding.foldId(running.first()), TranscriptFolding.liveFoldId(running.first()))
    }

    @Test fun foldedStepsRunsCloseOnSettleToo() {
        val running = listOf(user("u1"), reply("note"), command("c1"), thought("t1"), command("c2", ToolStatus.Running))
        val rows = TranscriptFolding.rows(running, TimelineDetail.Normal, isRunning = true, expandedFolds = setOf("live:c1"))
        assertEquals(listOf("u1", "note", "live:c1", "c1", "t1", "c2"), rows.map { it.id })
        assertEquals(Kind.Fold("Working", "Ran 2 commands", failures = 0, expanded = true, running = true), rows[2].kind)
        val settledRows = TranscriptFolding.rows(running.dropLast(1) + command("c2") + reply("final"), TimelineDetail.Normal, isRunning = false, expandedFolds = setOf("live:c1"))
        assertEquals(listOf("u1", "fold:u1", "final"), settledRows.map { it.id })
    }

    @Test fun aSubagentAtWorkIsNeverHiddenInAFold() {
        val running = listOf(user("u1"), command("c1"), agent("a1", running = true), command("c2"), command("c3", ToolStatus.Running))
        assertEquals(listOf("u1", "c1", "a1", "live:c2"), TranscriptFolding.rows(running, TimelineDetail.Normal, isRunning = true).map { it.id })
        assertEquals(listOf("u1", "a1", "live:u1"), TranscriptFolding.rows(running, TimelineDetail.Concise, isRunning = true).map { it.id })
        // The turn ended while the agent still works: the agent stays next to the settled fold.
        val settledRows = listOf(user("u1"), command("c1"), agent("a1", running = true), agent("a2", running = false), reply("final"))
        val shown = TranscriptFolding.rows(settledRows, TimelineDetail.Normal, isRunning = false)
        assertEquals(listOf("u1", "fold:u1", "a1", "final"), shown.map { it.id })
        assertEquals("Ran 1 command · 1 agent", fold(shown, "fold:u1").summary)
    }

    @Test fun notRunningKeepsTheLastTurnSettled() {
        // Stale content passes isRunning = false: its last turn folds as settled, without a spinner.
        val rows = listOf(user("u1"), command("c1"), command("c2", ToolStatus.Running))
        val shown = TranscriptFolding.rows(rows, TimelineDetail.Normal, isRunning = false)
        assertEquals(listOf("u1", "fold:u1"), shown.map { it.id })
        assertEquals(false, fold(shown, "fold:u1").running)
    }

    @Test fun aTurnWaitingOnAnApprovalStaysInProgress() {
        val approval = TranscriptRow("a1", Kind.Approval(requestId = "r", prompt = "npm publish", resolved = false))
        val waiting = listOf(user("u1"), command("c1"), approval)
        assertEquals(waiting, TranscriptFolding.rows(waiting, TimelineDetail.Normal, isRunning = false))
        val twoSteps = listOf(user("u1"), command("c1"), edit("e1"), approval)
        assertEquals(listOf("u1", "live:c1", "a1"), TranscriptFolding.rows(twoSteps, TimelineDetail.Normal, isRunning = false).map { it.id })
        assertEquals(listOf("u1", "a1", "live:u1"), TranscriptFolding.rows(waiting, TimelineDetail.Concise, isRunning = false).map { it.id })
    }

    @Test fun turnsWithoutStepsNeverFold() {
        val plain = listOf(user("u1"), reply("final"), user("u2"), reply("final2"))
        assertEquals(plain, TranscriptFolding.rows(plain, TimelineDetail.Concise, isRunning = false))
        val onlyThought = listOf(user("u1"), thought("t1"), reply("final"))
        assertEquals(listOf("u1", "final"), TranscriptFolding.rows(onlyThought, TimelineDetail.Concise, isRunning = false).map { it.id })
        assertEquals(listOf("u1", "fold:u1", "final"), TranscriptFolding.rows(onlyThought, TimelineDetail.Normal, isRunning = false).map { it.id })
    }

    @Test fun stepsBeforeAnyMessageFoldToo() {
        val head = listOf(command("c0"), reply("r0"), user("u1"), reply("final"))
        assertEquals(listOf("fold:c0", "r0", "u1", "final"), TranscriptFolding.rows(head, TimelineDetail.Concise, isRunning = false).map { it.id })
    }

    @Test fun levelsReadFromTheirStoredName() {
        assertEquals(TimelineDetail.Normal, TimelineDetail.Default)
        assertEquals(TimelineDetail.Concise, TimelineDetail.fromRaw("concise"))
        assertNull(TimelineDetail.fromRaw("huge"))
        assertEquals(listOf("Results only", "Folded steps", "Everything"), TimelineDetail.entries.map { it.label })
    }
}
