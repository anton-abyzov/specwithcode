package com.specwithcode.wire

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Who a project is for, as the web's `@specweave-studio/shared/projectOrigin`. Release
 * checks, acceptance runs and handoff proofs make real projects; the person never works in
 * them, so the drawer lists them apart under "Automated". A saved choice wins; any other
 * project is judged by its folder each time.
 */
@Serializable
enum class ProjectOrigin {
    @SerialName("user") User,
    @SerialName("automated") Automated,
    ;

    companion object {
        /** Folder-name words that only checks and fixtures use. */
        private val automatedFolderWords = setOf("scratch", "verification", "acceptance", "fixture", "fixtures")

        /** The app's own data folders; a project inside one was made by the app or an agent. */
        private val appDataFolders = listOf(
            listOf(".specwithcode"),
            listOf(".specweave-studio"),
            listOf(".local", "share", "specweave"),
            listOf(".local", "share", "specweave-studio"),
        )

        /** A word only a recorded demo's own folder uses. */
        private const val DEMO_FOLDER_WORD = "demo"

        private val tempPrefixes = listOf("/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/")

        private fun words(segment: String): List<String> = segment.split('-', '_', '.', ' ').filter { it.isNotEmpty() }

        /**
         * True when a folder is plainly a check's workspace. The app's projects folder
         * (`<data>/<machine>/projects`) is always the person's, whatever the project is called.
         */
        fun isAutomatedWorkspaceRoot(workspaceRoot: String): Boolean {
            val normalized = workspaceRoot.replace('\\', '/')
            val lower = normalized.lowercase()
            if (tempPrefixes.any { lower.startsWith(it) } || lower.contains("/appdata/local/temp/")) return true
            val lowered = normalized.split('/').filter { it.isNotEmpty() }.map { it.lowercase() }
            var inAppData = false
            for (index in lowered.indices) {
                val data = appDataFolders.firstOrNull { sequence ->
                    sequence.withIndex().all { (offset, part) -> index + offset < lowered.size && lowered[index + offset] == part }
                } ?: continue
                val rest = lowered.drop(index + data.size)
                if (rest.firstOrNull() == "projects" || (rest.size > 1 && rest[1] == "projects")) return false
                inAppData = true
            }
            if (inAppData) return true
            val segments = lowered.filter { it.isNotEmpty() }
            if (segments.lastOrNull()?.let { DEMO_FOLDER_WORD in words(it) } == true) return true
            return segments.any { segment -> words(segment).any { it in automatedFolderWords } }
        }
    }
}

/** The saved origin, else a temporary agent session, else the folder. */
val ProjectShell.origin: ProjectOrigin
    get() {
        workspaceSettings?.origin?.let { return it }
        if (workspaceSettings?.temporarySessionId != null) return ProjectOrigin.Automated
        // The personal assistant is the person's own wherever its folder is.
        if (isPersonal) return ProjectOrigin.User
        return if (ProjectOrigin.isAutomatedWorkspaceRoot(workspaceRoot)) ProjectOrigin.Automated else ProjectOrigin.User
    }

val ProjectShell.isAutomated: Boolean get() = origin == ProjectOrigin.Automated
