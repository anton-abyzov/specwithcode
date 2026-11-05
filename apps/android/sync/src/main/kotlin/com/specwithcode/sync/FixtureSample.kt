package com.specwithcode.sync

import com.specwithcode.sync.TranscriptRow.Kind
import java.time.Instant

/** Sample machines, projects, threads and transcripts for [FixtureEngine]. Shared with the iOS app. */
internal object FixtureSample {
    val modelChoices: List<ModelChoice> = listOf(
        ModelChoice("claudeAgent", "claude-opus-4-5", "Claude Opus 4.5"),
        ModelChoice("claudeAgent", "claude-sonnet-4-5", "Claude Sonnet 4.5"),
        ModelChoice("codex", "gpt-5-codex", "GPT-5 Codex"),
    )

    const val STUDIO = "env-studio-mac"
    const val BUILD_BOX = "env-build-box"
    const val TRAVEL = "env-travel-laptop"

    val specweave = ProjectRef(STUDIO, "specweave")
    val verified = ProjectRef(STUDIO, "verified-skill")
    val recipes = ProjectRef(BUILD_BOX, "recipe-app")
    val docs = ProjectRef(TRAVEL, "docs-site")

    val machines: List<MachineSummary> = listOf(
        MachineSummary(STUDIO, "Office Mac", MachineStatus.Connected, "macOS · arm64", "0.42.1", "https://studio-mac.local:3773", 24),
        MachineSummary(BUILD_BOX, "Build box", MachineStatus.Connected, "Linux · x64", "0.42.1", "https://build-box.local:3773", 3),
        MachineSummary(TRAVEL, "Travel laptop", MachineStatus.Offline, "macOS · arm64", "0.41.0", "http://192.168.1.24:3773", 12),
    )

    val aide = ProjectSummary(
        ref = ProjectRef(STUDIO, "aide"),
        title = "Aide",
        icon = ProjectIcon.Symbol("concierge-bell", "violet"),
        kind = ProjectKind.Personal,
        machineLabel = "Office Mac",
        machineOnline = true,
    )

    val projects: List<ProjectSummary> = listOf(
        ProjectSummary(specweave, "SpecWeave", ProjectIcon.Symbol("dna", "amber"), machineLabel = "Office Mac", machineOnline = true, isPinned = true),
        // Linked across three machines, so rows show more than one.
        ProjectSummary(
            verified, "Verified Skill", ProjectIcon.Symbol("shield-check", "green"), machineLabel = "Office Mac", machineOnline = true, isPinned = true,
            members = listOf(
                ProjectMember(verified, "Office Mac", machineOnline = true, isCoordinator = true),
                ProjectMember(ProjectRef(BUILD_BOX, "verified-skill"), "Build box", machineOnline = true),
                ProjectMember(ProjectRef(TRAVEL, "verified-skill"), "Travel laptop", machineOnline = false),
            ),
        ),
        ProjectSummary(recipes, "Recipe app", ProjectIcon.Symbol("utensils", "orange"), machineLabel = "Build box", machineOnline = true),
        ProjectSummary(docs, "Docs site", ProjectIcon.Symbol("book-open", "blue"), machineLabel = "Travel laptop", machineOnline = false),
    )

    private val claude = ThreadIdentity("Claude Code", "Opus 5.5", "claude", "claude")

    fun threads(now: Instant): List<ThreadSummary> {
        fun ago(minutes: Double): Instant = now.minusMillis((minutes * 60_000).toLong())
        fun thread(
            id: String, project: ProjectRef, projectTitle: String, machine: String, title: String, activity: ThreadActivity, preview: String,
            updated: Double, started: Double? = null, pinned: Boolean = false, resolved: Boolean = false, unread: Boolean = false,
            plan: Pair<Int, Int>? = null,
        ): ThreadSummary {
            val identity = when (id) {
                "t-handoff" -> ThreadIdentity("Codex", "GPT-6.1 Sol", "openai", "openai")
                "t-ledger" -> ThreadIdentity("GitHub Copilot", "Opus 5.5", "copilot", "claude")
                else -> claude
            }
            val summary = ThreadSummary(
                ref = ThreadRef(project.environmentId, id),
                projectRef = project,
                projectTitle = projectTitle,
                title = title,
                activity = activity,
                preview = preview,
                updatedAt = ago(updated),
                workStartedAt = started?.let(::ago),
                isPinned = pinned,
                isResolved = resolved,
                isUnread = unread,
                machineLabel = machine,
                machineOnline = project.environmentId != TRAVEL,
                planProgress = plan?.let { PlanProgress(it.first, it.second) },
                identity = identity,
                isDone = activity == ThreadActivity.Idle,
            )
            // Handed to the build box, so the project's threads span two machines.
            return if (id == "t-flaky") summary.copy(placement = summary.placement.copy(runsOn = "Build box")) else summary
        }
        val sw = "SpecWeave"
        val vs = "Verified Skill"
        val ra = "Recipe app"
        val ds = "Docs site"
        return listOf(
            thread("t-release", specweave, sw, "Office Mac", "Release 3.1 checklist", ThreadActivity.NeedsYou, "Wants to run npm publish --tag next", 1.0, 9.0, unread = true, plan = 3 to 5),
            thread("t-handoff", specweave, sw, "Office Mac", "Write handoff docs for cross-tool pickup", ThreadActivity.Working, "Editing docs/handoff.md", 0.5, 2.0, plan = 2 to 5),
            thread("t-ledger", specweave, sw, "Office Mac", "Fix ledger merge conflicts", ThreadActivity.Working, "Running the ledger tests", 3.0, 14.0, plan = 3 to 4),
            thread("t-flaky", specweave, sw, "Office Mac", "Investigate flaky end-to-end run", ThreadActivity.Failed, "npm test exited with code 1 in 3 files", 40.0),
            thread("t-verify-gate", specweave, sw, "Office Mac", "Add verify gate to CI", ThreadActivity.Idle, "PR #42 open; waiting for checks", 120.0, pinned = true),
            thread("t-changelog", specweave, sw, "Office Mac", "Draft changelog for 3.0.24", ThreadActivity.Idle, "Changelog merged in #39", 1440.0, resolved = true),
            thread("t-ranking", verified, vs, "Office Mac", "Improve skill search ranking", ThreadActivity.Working, "Comparing ranking results", 2.0, 6.0, plan = 1 to 3),
            thread("t-dedupe", verified, vs, "Office Mac", "Deduplicate skill imports", ThreadActivity.Idle, "Tests pass; ready to merge", 25.0, unread = true),
            thread("t-crawler", verified, vs, "Office Mac", "Crawler retry backoff", ThreadActivity.Idle, "Shipped in 1.4.2", 4320.0, resolved = true),
            thread("t-offline", recipes, ra, "Build box", "Offline mode for saved recipes", ThreadActivity.Working, "Writing the sync queue", 4.0, 48.0, plan = 4 to 6),
            thread("t-onboarding", recipes, ra, "Build box", "Polish onboarding screens", ThreadActivity.Idle, "Screenshots attached for review", 300.0),
            thread("t-images", recipes, ra, "Build box", "Shrink the image cache", ThreadActivity.Idle, "Cache now capped at 200 MB", 1500.0),
            thread("t-search-index", docs, ds, "Travel laptop", "Rebuild the search index", ThreadActivity.Idle, "Index rebuilt; 1,284 pages", 2880.0),
            thread("t-links", docs, ds, "Travel laptop", "Fix broken links after the move", ThreadActivity.Idle, "12 links fixed; 3 need a decision", 5760.0),
        )
    }

    fun goal(projectId: String): String = when (projectId) {
        "specweave" -> "Plan work in a spec, let any tool do it, and keep the record in git. Ship small releases often and keep the docs current."
        "verified-skill" -> "Make it easy to find skills that are safe to install, and show why each one can be trusted."
        "recipe-app" -> "A recipe app that works offline and makes weekly meal planning quick."
        "docs-site" -> "Clear, searchable docs for every release."
        "aide" -> "Help with anything across my machines, and start work in the right project."
        else -> ""
    }

    fun steps(progress: PlanProgress): List<TodoStep> {
        val names = listOf(
            "Read the open increment", "Write the failing test", "Make the change", "Run the full test suite", "Update the docs", "Open a pull request",
        )
        return (0 until progress.total).map { i ->
            val status = when {
                i < progress.completed -> TodoStep.Status.Completed
                i == progress.completed -> TodoStep.Status.Running
                else -> TodoStep.Status.Pending
            }
            TodoStep("s$i", names[i % names.size], status)
        }
    }

    val aideTranscript: List<Kind> = listOf(
        Kind.User("Good morning. What needs me today?"),
        Kind.Assistant(
            """
            Good morning. Here's where things stand across your machines.

            **Needs you**
            - *Release 3.1 checklist* in SpecWeave wants approval to publish to npm.

            **Working**
            - *Write handoff docs for cross-tool pickup* (2 of 5 tasks)
            - *Fix ledger merge conflicts* (3 of 4 tasks)
            - *Offline mode for saved recipes* on Build box

            **Heads up**
            - The pairing for Build box expires in 3 days.
            - Travel laptop has been offline since yesterday.
            """.trimIndent(),
            streaming = false,
        ),
        Kind.User("Remind me to check the release after lunch."),
        Kind.Assistant("Done. I'll bring it up at 1:00 PM.", streaming = false),
    )

    /** Sixty check-ins, oldest first: the oldest message is "Start of history" and every tenth reply links to the release notes. */
    val longAideTranscript: List<Kind> by lazy {
        val rows = mutableListOf<Kind>(Kind.User("Start of history"), Kind.Assistant("Noted. This is where our chat begins.", streaming = false))
        for (day in 1..60) {
            rows += Kind.User("Check-in $day: anything new?")
            var reply = "Check-in $day: two threads moved forward and nothing needs you."
            if (day % 10 == 0) reply += "\n\nThe [release notes](https://spec-weave.com/docs/whats-new) list what shipped this week."
            rows += Kind.Assistant(reply, streaming = false)
        }
        // A long report from another machine, collapsed behind Show more.
        rows += Kind.User("What did ministorm report?")
        val report = StringBuilder("## Ministorm report\n\n")
        for (section in 1..24) {
            report.append("### Step $section\n\nRoot `/home/dev/projects/fleet` on branch `feature/handoff`, HEAD `73b0efcc9a873ff24ad2490b5dfe20810d8929f3`. ")
            report.append("Nested package `console-ui` verified with `npm run i18n-audit && vitest run`.\n\n- Checkpoint marker M4-CONTEXT-$section\n- No installs, builds or writes\n\n")
        }
        rows += Kind.Assistant(report.toString(), streaming = false)
        rows
    }

    val releaseTranscript: List<Kind> = listOf(
        Kind.User("Prepare the 3.1 release. Run the full checks, update the changelog and publish to the next tag when everything passes."),
        Kind.Reasoning(
            "The release script lives in scripts/release. Run the checks first, then bump the version and build the changelog from merged pull requests.",
            streaming = false,
            seconds = 14,
        ),
        Kind.Plan(
            listOf(
                TodoStep("r1", "Run the full test suite", TodoStep.Status.Completed),
                TodoStep("r2", "Update CHANGELOG.md", TodoStep.Status.Completed),
                TodoStep("r3", "Bump the version to 3.1.0", TodoStep.Status.Completed),
                TodoStep("r4", "Publish to npm with the next tag", TodoStep.Status.Running),
                TodoStep("r5", "Open the release pull request", TodoStep.Status.Pending),
            ),
        ),
        Kind.Tool("Ran npm test", "1,482 passed · 0 failed · 41.2s", "terminal", ToolStatus.Completed),
        Kind.Tool("Edited CHANGELOG.md", "+38 −2", "pencil", ToolStatus.Completed),
        Kind.Tool("Ran npm version 3.1.0", "--no-git-tag-version", "terminal", ToolStatus.Completed),
        Kind.Subagent("Checked the docs for old version numbers", ThreadRef(STUDIO, "t-changelog")),
        Kind.Assistant(
            """
            ## Release 3.1 is ready to publish

            All checks passed on Office Mac. Here's what changed since 3.0.24.

            ### Highlights
            - **Verify gate.** `specweave verify` runs the project's build, test and lint commands and blocks completion when one fails.
            - **Cross-tool handoff.** `specweave handoff` writes a short note that any tool can pick up later.
            - **Faster pickup.** Starting a session reads only the open increment, so large projects start in under a second.

            ### Fixes
            1. Ledger merges keep every line from both sides.
            2. Task counters agree when fields share a line.
            3. The docs build no longer breaks on a bare `<digit` in MDX.

            ### Publish step
            This is what runs next:

            ```bash
            npm publish --tag next
            git tag v3.1.0
            git push origin v3.1.0
            ```

            The package is 1.8 MB with 214 files. Nothing from `.env` files or `.specweave/state` is included; I checked the tarball list.

            ### Checks
            | Check | Result | Time |
            | --- | --- | --- |
            | Unit tests | 1,482 passed | 41s |
            | Lint | Clean | 6s |
            | Docs build | Clean | 18s |
            | Package size | 1.8 MB | — |

            ### After publishing
            - Watch the release workflow until it's green.
            - Move the `latest` tag after a day on `next`.
            - Post the changelog link in the project notes.

            Say the word if you'd like a dry run first.
            """.trimIndent(),
            streaming = false,
        ),
        Kind.Approval("req-publish", "npm publish --tag next", resolved = false),
    )
}
