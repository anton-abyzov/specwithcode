package com.specwithcode.sync

import com.specwithcode.wire.BackgroundTaskKind
import com.specwithcode.wire.CreationSource
import com.specwithcode.wire.ThreadShell
import com.specwithcode.wire.ThreadStatus

/** "1 needs you", "2 need you": the one way a count of attention is said. */
fun needsYouLabel(count: Int): String = "$count ${if (count == 1) "needs" else "need"} you"

/**
 * The desktop's rules for what a quiet thread is waiting on, from `reportWaitReason` and
 * `threadDependencyWait`, so every app sorts a thread the same way.
 */
object ThreadAttention {
    private val fence = Regex("```[\\s\\S]*?```")
    private val paragraph = Regex("\\n\\s*\\n")
    private val asksPerson = Regex("(?i)\\b(?:you|your|anton|approve|approval|permission|decision|sign[ -]?in|license|credential)\\b")
    private val markup = Regex("[*_`]")
    private val wait = Regex("(?i)(?:^|[.!]\\s+)(?:(?:blockers?|blocked)\\s*:\\s*)?(?:now\\s+)?(?:waiting (?:on|for)|wait for|blocked (?:on|by))\\s+(.+)")
    private val ci = Regex("(?i)^(?:the\\s+)?(?:CI|checks?|builds?|tests?)(?:\\b|$)")
    private val review = Regex("(?i)^(?:a\\s+|the\\s+|fresh\\s+)*(?:review|reviewer)(?:\\b|$)")
    private val merge = Regex("(?i)^(?:(?:(?:the|a)\\s+)?(?:PRs?|pull requests?)(?:\\b|$)|(?:the\\s+)?merge\\b|#[0-9]+.*\\bmerg)")
    private val agents = Regex("(?i)^(?:the\\s+|my\\s+)?(?:subagents?|agents?|workers?)(?:\\b|$)")

    /**
     * An explicit dependency wait in a blocker's final prose paragraph, which is never a request
     * for the reader; null when it asks the person anything.
     */
    fun reportWaitReason(text: String): String? {
        val unfenced = text.replace(fence, "")
        val prose = unfenced.split(paragraph).last().trim()
        if (prose.startsWith(">") || prose.contains("?")) return null
        if (asksPerson.containsMatchIn(prose)) return null
        val plain = prose.replace(markup, "")
        val dependency = wait.find(plain)?.groupValues?.get(1) ?: return null
        return when {
            ci.containsMatchIn(dependency) -> "Waiting for CI"
            review.containsMatchIn(dependency) -> "Waiting for review"
            merge.containsMatchIn(dependency) -> "Waiting for PR merge"
            agents.containsMatchIn(dependency) -> "Waiting for subagents"
            else -> null
        }
    }

    /** A child's report is read by an agent, not the person: a provider's subagent, or a delegated child of anything but a coordinator. */
    fun reportsToParentAgent(thread: ThreadShell): Boolean {
        if (!thread.isSubagent) return false
        if (thread.creationSource == CreationSource.Provider) return true
        return thread.lineage.parentThreadId?.let { !it.startsWith("project-coordinator:") } ?: false
    }

    private fun isActive(thread: ThreadShell): Boolean = thread.status.isWorking || thread.activityRunStatus?.isWorking == true

    /** The ask lives only in the thread's last message; a resumed turn supersedes it. */
    fun needsReply(thread: ThreadShell): Boolean {
        if (thread.isSettled || thread.pendingRuntimeRequest != null || isActive(thread)) return false
        val blocker = thread.reportedBlocker?.trim()
        if (blocker.isNullOrEmpty()) return false
        return !reportsToParentAgent(thread) && reportWaitReason(blocker) == null
    }

    private fun backgroundWait(thread: ThreadShell): String? {
        val tasks = thread.pendingBackgroundTasks
        if (tasks.isEmpty() || thread.status == ThreadStatus.Failed || (thread.heldQueuedCount ?: 0) > 0 ||
            thread.hasActionableProposedPlan || needsReply(thread)
        ) {
            return null
        }
        if (isActive(thread)) return null
        if (tasks.all { it.kind == BackgroundTaskKind.Command }) return "Background command running"
        return if (tasks.all { it.kind == BackgroundTaskKind.Subagent }) "Waiting for subagents" else "Waiting for background work"
    }

    /** What a thread is waiting on other than the person. Words for its row; the thread itself counts as working. */
    fun dependencyWait(thread: ThreadShell): String? {
        // A failed run waits on nothing; here it needs the person, whatever its last report said.
        if (thread.isSettled || thread.archivedAt != null || thread.status == ThreadStatus.Failed) return null
        backgroundWait(thread)?.let { return it }
        if (thread.isSubagent && thread.status in setOf(ThreadStatus.Completed, ThreadStatus.Cancelled, ThreadStatus.Failed, ThreadStatus.Interrupted)) {
            return null
        }
        if (thread.status == ThreadStatus.Waiting) {
            if (thread.activeWork?.waitThreadId != null) return "Waiting for subagents"
            return reportWaitReason(thread.activeWork?.label ?: "") ?: "Waiting for background work"
        }
        if (isActive(thread) || reportsToParentAgent(thread)) return null
        val blocker = thread.reportedBlocker
        if (!blocker.isNullOrEmpty() && reportWaitReason(blocker) == null) return null
        return thread.reportedWait ?: reportWaitReason(thread.reportedBlocker ?: "")
    }
}
