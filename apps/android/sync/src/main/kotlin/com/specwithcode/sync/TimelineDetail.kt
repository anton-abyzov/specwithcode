package com.specwithcode.sync

import com.specwithcode.sync.TranscriptRow.Kind

/**
 * How much of an agent's work a conversation shows. The same three levels as the desktop
 * app's Show setting; the phone keeps its own choice. The rule is docs/transcript-detail.md.
 */
enum class TimelineDetail(val rawValue: String, val label: String, val summary: String) {
    /** Results only: your messages, each turn's reply and one fold per turn. */
    Concise("concise", "Results only", "Hide thinking, tool runs and in-between messages; one line per turn, opened on tap"),

    /** Folded steps: finished turns fold; the running turn folds each run of steps. */
    Normal("normal", "Folded steps", "Fold finished turns and tool groups"),

    /** Everything: every step, thought and message. */
    Verbose("verbose", "Everything", "Show every step, thought and message"),
    ;

    companion object {
        val Default: TimelineDetail = Normal

        fun fromRaw(raw: String?): TimelineDetail? = entries.firstOrNull { it.rawValue == raw }
    }
}

/**
 * Folds a transcript's steps to the chosen detail level. Pure, so every engine (live, cached
 * and sample) shows the same thing. Ported from the iOS `TranscriptFolding`, with three
 * differences: folds of a turn in progress have their own ids, so a fold opened while the turn
 * runs is closed once it settles; a subagent still at work is never hidden inside a fold; and
 * callers pass `isRunning` false for stale content.
 */
object TranscriptFolding {
    /**
     * The rows the chat shows. Turns are the rows after each of your messages. [isRunning]
     * keeps the last turn open as the running one; a turn waiting on your approval or answer
     * counts as in progress too. [expandedFolds] holds the fold row ids the person opened.
     */
    fun rows(
        rows: List<TranscriptRow>,
        detail: TimelineDetail,
        isRunning: Boolean,
        expandedFolds: Set<String> = emptySet(),
    ): List<TranscriptRow> {
        if (detail == TimelineDetail.Verbose) return rows
        val segments = mutableListOf(mutableListOf<TranscriptRow>())
        for (row in rows) {
            if (row.isUser) segments += mutableListOf(row) else segments.last() += row
        }
        val result = ArrayList<TranscriptRow>(rows.size)
        segments.forEachIndexed { index, segment ->
            if (segment.isEmpty()) return@forEachIndexed
            // Only the last turn runs; right after you send, the earlier turn is done.
            val running = isRunning && index == segments.lastIndex
            val active = running || segment.any { it.awaitsAnswer }
            result += fold(segment, detail, active, running, expandedFolds)
        }
        return result
    }

    /** The id of the settled fold that stands for the turn starting at [firstRow]. */
    fun foldId(firstRow: TranscriptRow?): String = "fold:${firstRow?.id ?: "head"}"

    /** The id of a fold in a turn still in progress, starting at [firstRow]. Never a settled fold's id. */
    fun liveFoldId(firstRow: TranscriptRow?): String = "live:${firstRow?.id ?: "head"}"

    private fun fold(
        segment: List<TranscriptRow>,
        detail: TimelineDetail,
        active: Boolean,
        running: Boolean,
        expandedFolds: Set<String>,
    ): List<TranscriptRow> {
        if (active && detail == TimelineDetail.Normal) return foldStepRuns(segment, running, expandedFolds)
        // Results only never shows thinking, opened or not.
        val rows = if (detail == TimelineDetail.Concise) segment.filter { !it.isReasoning } else segment
        val lastReply = rows.indexOfLast { (it.kind as? Kind.Assistant)?.markdown?.isNotEmpty() == true }
        val stepIds = HashSet<String>()
        val steps = rows.filterIndexed { index, row ->
            val step = when (row.kind) {
                is Kind.Reasoning, is Kind.Tool -> true
                // An agent still at work stays visible: its row links to the worker.
                is Kind.Subagent -> !row.isRunningSubagent
                is Kind.Assistant -> index != lastReply
                else -> false
            }
            if (step) stepIds += row.id
            step
        }
        val firstStep = rows.indexOfFirst { it.id in stepIds }
        if (steps.isEmpty() || firstStep < 0) return rows
        val id = if (active) liveFoldId(segment.firstOrNull()) else foldId(segment.firstOrNull())
        val expanded = id in expandedFolds
        val foldRow = TranscriptRow(
            id,
            Kind.Fold(
                label = if (running) "Working" else "Worked",
                summary = summary(steps),
                failures = steps.count { it.isFailedTool },
                expanded = expanded,
                running = running,
            ),
        )
        if (active) {
            // A turn in progress in Results only: its latest reply, then its live work.
            val kept = rows.filter { it.id !in stepIds }
            val tools = steps.filter { !it.isAssistant }
            if (tools.isEmpty()) return kept
            return kept + foldRow + (if (expanded) tools else emptyList())
        }
        if (expanded) return rows.toMutableList().apply { add(firstStep, foldRow) }
        val folded = rows.filter { it.id !in stepIds }.toMutableList()
        val at = rows.subList(0, firstStep).count { it.id !in stepIds }
        folded.add(at, foldRow)
        return folded
    }

    /**
     * Folded steps on a turn still in progress (running, or waiting on you): notes, agents at work
     * and requests stay; each run of two or more steps folds into one row, and the run the turn is
     * still working on is the live row. A failed step stays on its own only while it is the turn's
     * latest row: once the agent has moved on, it folds with the steps around it and the fold
     * counts it. The rule is docs/transcript-detail.md.
     */
    private fun foldStepRuns(segment: List<TranscriptRow>, running: Boolean, expandedFolds: Set<String>): List<TranscriptRow> {
        val result = ArrayList<TranscriptRow>(segment.size)
        val run = mutableListOf<TranscriptRow>()
        fun flush(trailing: Boolean) {
            val first = run.firstOrNull() ?: return
            val live = running && trailing
            if (run.size == 1 && !live) {
                result += first
            } else {
                val id = liveFoldId(first)
                val expanded = id in expandedFolds
                result += TranscriptRow(
                    id,
                    Kind.Fold(
                        label = if (live) "Working" else "Worked",
                        summary = summary(run),
                        failures = run.count { it.isFailedTool },
                        expanded = expanded,
                        running = live,
                    ),
                )
                if (expanded) result += run
            }
            run.clear()
        }
        for ((index, row) in segment.withIndex()) {
            val latest = index == segment.lastIndex
            if (row.isFoldableStep || (row.isFailedTool && !latest)) {
                run += row
            } else {
                flush(trailing = false)
                result += row
            }
        }
        flush(trailing = true)
        return result
    }

    /** "Ran 3 commands · Edited 1 file · 2 searches · 1 tool call · 1 agent", or null for thoughts and notes alone. */
    fun summary(steps: List<TranscriptRow>): String? {
        var commands = 0
        var edits = 0
        var searches = 0
        var tools = 0
        var agents = 0
        for (step in steps) {
            when (val kind = step.kind) {
                is Kind.Tool -> when (kind.symbol) {
                    "terminal" -> commands += 1
                    "pencil" -> edits += 1
                    "magnifyingglass", "globe" -> searches += 1
                    else -> tools += 1
                }
                is Kind.Subagent -> agents += 1
                else -> Unit
            }
        }
        fun plural(count: Int, one: String, many: String) = if (count == 1) "1 $one" else "$count $many"
        val parts = buildList {
            if (commands > 0) add("Ran " + plural(commands, "command", "commands"))
            if (edits > 0) add("Edited " + plural(edits, "file", "files"))
            if (searches > 0) add(plural(searches, "search", "searches"))
            if (tools > 0) add(plural(tools, "tool call", "tool calls"))
            if (agents > 0) add(plural(agents, "agent", "agents"))
        }
        return if (parts.isEmpty()) null else parts.joinToString(" · ")
    }

    private val TranscriptRow.isUser: Boolean get() = kind is Kind.User
    private val TranscriptRow.isAssistant: Boolean get() = kind is Kind.Assistant
    private val TranscriptRow.isReasoning: Boolean get() = kind is Kind.Reasoning

    /** Thinking, a tool call, a command or a finished agent that did not fail. */
    private val TranscriptRow.isFoldableStep: Boolean
        get() = when (val kind = kind) {
            is Kind.Reasoning -> true
            is Kind.Subagent -> !kind.isRunning
            is Kind.Tool -> kind.status != ToolStatus.Failed
            else -> false
        }

    private val TranscriptRow.isFailedTool: Boolean get() = (kind as? Kind.Tool)?.status == ToolStatus.Failed

    /** An approval, question or access request still waiting for the person. */
    private val TranscriptRow.awaitsAnswer: Boolean
        get() = when (val kind = kind) {
            is Kind.Approval -> !kind.resolved
            is Kind.Question -> !kind.resolved
            is Kind.Access -> kind.request.awaitsAnswerHere
            else -> false
        }
}
