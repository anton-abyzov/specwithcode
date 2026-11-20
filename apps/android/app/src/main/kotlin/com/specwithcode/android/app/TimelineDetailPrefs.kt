package com.specwithcode.android.app

import com.specwithcode.sync.ChatTarget
import com.specwithcode.sync.TimelineDetail
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** This phone's Show levels: the default for every thread, and each thread's own. */
data class TimelineDetailState(
    val default: TimelineDetail = TimelineDetail.Default,
    /** Chat key to the chat's own level, oldest first. */
    val threads: Map<String, TimelineDetail> = emptyMap(),
) {
    /** The level a chat shows: its own, else the default. */
    fun level(key: String): TimelineDetail = threads[key] ?: default

    fun hasOwn(key: String): Boolean = key in threads
}

/**
 * Keeps the Show levels in [SettingsStore] and publishes them, so an open chat and Settings
 * follow each other. At most [MAX_THREADS] chats keep their own level; the oldest choice goes first.
 */
class TimelineDetailPrefs(private val store: SettingsStore) {
    private val mutableState = MutableStateFlow(TimelineDetailState(store.timelineDetail, LinkedHashMap(store.threadTimelineDetails.toMap())))
    val state: StateFlow<TimelineDetailState> = mutableState.asStateFlow()

    val value: TimelineDetailState get() = mutableState.value

    fun setDefault(detail: TimelineDetail) {
        store.timelineDetail = detail
        mutableState.value = value.copy(default = detail)
    }

    /** Gives a chat its own level, or with null lets it follow the default again. */
    fun setThread(key: String, detail: TimelineDetail?) {
        val threads = LinkedHashMap(value.threads)
        threads.remove(key)
        if (detail != null) threads[key] = detail
        while (threads.size > MAX_THREADS) threads.remove(threads.keys.first())
        store.threadTimelineDetails = threads.toList()
        mutableState.value = value.copy(threads = threads)
    }

    companion object {
        const val MAX_THREADS = 300

        /** The key a chat's own level is saved under: its machine and thread, or the project for a coordinator or Percy. */
        fun key(target: ChatTarget): String = when (target) {
            is ChatTarget.Thread -> "${target.thread.environmentId}:${target.thread.threadId}"
            is ChatTarget.Project -> "${target.project.environmentId}:coordinator:${target.project.projectId}"
            is ChatTarget.Aide -> "${target.project.environmentId}:aide:${target.project.projectId}"
        }

        /** One `key<TAB>level` line per chat, oldest first. Keys hold no tabs or line breaks. */
        fun encode(threads: List<Pair<String, TimelineDetail>>): String =
            threads.filter { (key, _) -> '\t' !in key && '\n' !in key }.joinToString("\n") { (key, detail) -> "$key\t${detail.rawValue}" }

        /** Reads [encode]'s lines; unreadable lines are skipped. */
        fun decode(raw: String?): List<Pair<String, TimelineDetail>> = raw.orEmpty().lineSequence().mapNotNull { line ->
            val tab = line.lastIndexOf('\t')
            if (tab <= 0) return@mapNotNull null
            TimelineDetail.fromRaw(line.substring(tab + 1))?.let { line.substring(0, tab) to it }
        }.toList()
    }
}
