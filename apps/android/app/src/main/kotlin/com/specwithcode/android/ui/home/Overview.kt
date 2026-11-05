package com.specwithcode.android.ui.home

import com.specwithcode.sync.AppState
import com.specwithcode.sync.ProjectSummary
import com.specwithcode.sync.ThreadActivity
import com.specwithcode.sync.ThreadSummary

/** A project row in the drawer, with its threads and badge counts. */
data class ProjectSection(
    val project: ProjectSummary,
    val threads: List<ThreadSummary>,
    /** Threads waiting on an approval, an answer or access. */
    val pendingCount: Int,
    val workingCount: Int,
)

/** What the overview and drawer show, derived from [AppState] only. */
data class OverviewUi(
    val aide: ProjectSection?,
    val pinned: List<ProjectSection>,
    val others: List<ProjectSection>,
    val automated: List<ProjectSection>,
    val needsYou: List<ThreadSummary>,
    val recent: List<ThreadSummary>,
    val totalPending: Int,
) {
    val isEmpty: Boolean get() = aide == null && pinned.isEmpty() && others.isEmpty() && automated.isEmpty()

    companion object {
        fun from(state: AppState): OverviewUi {
            fun section(project: ProjectSummary): ProjectSection {
                val threads = state.threads(project.ref).filter { !it.isResolved || it.isPinned }
                return ProjectSection(
                    project = project,
                    threads = threads.sortedWith(compareBy<ThreadSummary> { !it.isPinned }.thenByDescending { it.updatedAt }),
                    pendingCount = state.threads(project.ref).count { it.needsAttention },
                    workingCount = threads.count { it.activity == ThreadActivity.Working && !it.isUnknown },
                )
            }
            val all = state.threadsByProject.values.flatten().distinctBy { it.ref }
            val needs = all.filter { it.needsAttention }.sortedByDescending { it.updatedAt }
            return OverviewUi(
                aide = state.aide?.let(::section),
                pinned = state.pinnedProjects.map(::section),
                others = state.otherProjects.map(::section),
                automated = state.automatedProjects.map(::section),
                needsYou = needs,
                recent = state.recentThreads.filter { !it.needsAttention },
                totalPending = needs.size,
            )
        }
    }
}

/** Waiting on the person: an approval, a question or an access request. */
val ThreadSummary.needsAttention: Boolean
    get() = !isResolved && !isUnknown && (activity == ThreadActivity.NeedsYou || waitsOnUser || asksForAccess)
