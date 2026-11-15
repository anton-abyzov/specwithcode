package com.specwithcode.android.ui.chat

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.specwithcode.sync.AccessAnswer
import com.specwithcode.sync.AccessRequestRow
import com.specwithcode.sync.AppModel
import com.specwithcode.sync.ApprovalDecision
import com.specwithcode.sync.ChatSession
import com.specwithcode.sync.ChatState
import com.specwithcode.sync.ChatTarget
import com.specwithcode.android.app.InMemorySettingsStore
import com.specwithcode.android.app.TimelineDetailPrefs
import com.specwithcode.android.app.TimelineDetailState
import com.specwithcode.sync.ProjectReplyStyle
import com.specwithcode.sync.ReplyStyle
import com.specwithcode.sync.ThreadAction
import com.specwithcode.sync.TimelineDetail
import com.specwithcode.sync.TranscriptFolding
import com.specwithcode.sync.TranscriptRow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** What the chat screen draws. */
data class ChatUi(
    val chat: ChatState,
    val draft: String = "",
    /** Approval and access requests with an answer on its way. */
    val busyRequests: Set<String> = emptySet(),
    /** The last action that failed, shown above the composer. */
    val error: String? = null,
    val sending: Boolean = false,
    /** The rows drawn: [chat]'s rows folded to [detail]. */
    val rows: List<TranscriptRow> = chat.rows,
    /** The Show level this chat uses: its own, else this phone's default. */
    val detail: TimelineDetail = TimelineDetail.Default,
    /** This chat has its own Show level ("This thread"). */
    val ownDetail: Boolean = false,
    /** The level every other thread shows. */
    val defaultDetail: TimelineDetail = TimelineDetail.Default,
    /** How the project's agents reply; null when the chat has no project or its machine has not said. */
    val replyStyle: ProjectReplyStyle? = null,
    /** A reply style change is on its way. */
    val savingReplyStyle: Boolean = false,
) {
    /** Send is on when there is text and the chat takes messages. */
    val canSend: Boolean get() = draft.isNotBlank() && chat.sendBlockedReason == null && !sending && chat.loadError == null

    /** Stop shows while a run is active; it is off while the content is stale. */
    val showsStop: Boolean get() = chat.isRunning
    val canStop: Boolean get() = chat.isRunning && !chat.isStale

    /** The line above the composer: an error first, then why sending is blocked. */
    val notice: String? get() = error ?: chat.lastError ?: chat.sendBlockedReason

    val composerHint: String
        get() = when {
            chat.queuedCount > 0 -> "${chat.queuedCount} queued · add another message"
            chat.isRunning -> "Message (queues after this run)"
            else -> "Message"
        }
}

/**
 * One open conversation. Opens its [ChatSession] for as long as the screen lives and turns
 * composer and card actions into engine calls.
 */
class ChatViewModel(
    private val model: AppModel,
    val target: ChatTarget,
    /** The Show levels; tests pass their own, the app passes the one Settings uses. */
    private val detailPrefs: TimelineDetailPrefs = TimelineDetailPrefs(InMemorySettingsStore()),
) : ViewModel() {
    private val session: ChatSession = model.session(target)
    private val local = MutableStateFlow(Local())

    /** Where this chat's own Show level is saved. */
    val detailKey: String = TimelineDetailPrefs.key(target)

    private data class Local(
        val draft: String = "",
        val busy: Set<String> = emptySet(),
        val error: String? = null,
        val sending: Boolean = false,
        /** Fold rows the person opened. View state only. */
        val expandedFolds: Set<String> = emptySet(),
        val savingReplyStyle: Boolean = false,
    )

    private val replyStyle = model.state.map { it.projectOf(target)?.let(it::replyStyle) }.distinctUntilChanged()

    val ui: StateFlow<ChatUi> = combine(session.state, local, detailPrefs.state, replyStyle, ::build)
        .stateIn(viewModelScope, SharingStarted.Eagerly, current())

    private fun build(chat: ChatState, l: Local, details: TimelineDetailState, style: ProjectReplyStyle?): ChatUi {
        val detail = details.level(detailKey)
        // Content from the cache is not running, whatever its last run said.
        val running = chat.isRunning && !chat.isStale
        return ChatUi(
            chat = chat,
            draft = l.draft,
            busyRequests = l.busy,
            error = l.error,
            sending = l.sending,
            rows = TranscriptFolding.rows(chat.rows, detail, running, l.expandedFolds),
            detail = detail,
            ownDetail = details.hasOwn(detailKey),
            defaultDetail = details.default,
            replyStyle = style,
            savingReplyStyle = l.savingReplyStyle,
        )
    }

    /** The state right now, without waiting for [ui] to catch up. */
    private fun current(): ChatUi = build(session.value, local.value, detailPrefs.value, model.value.projectOf(target)?.let(model.value::replyStyle))

    /** Opens a fold row, or closes it when open. */
    fun toggleFold(id: String) = local.update {
        it.copy(expandedFolds = if (id in it.expandedFolds) it.expandedFolds - id else it.expandedFolds + id)
    }

    /**
     * Picks a Show level. With "This thread" chosen it becomes this chat's own level; with
     * "Every thread" it becomes the default and this chat follows it.
     */
    fun setDetail(detail: TimelineDetail) {
        if (detailPrefs.value.hasOwn(detailKey)) detailPrefs.setThread(detailKey, detail) else detailPrefs.setDefault(detail)
    }

    /** "This thread" pins the level shown now to this chat; "Every thread" drops its own level. */
    fun setDetailForThisThread(thisThread: Boolean) {
        if (thisThread) detailPrefs.setThread(detailKey, detailPrefs.value.level(detailKey)) else detailPrefs.setThread(detailKey, null)
    }

    /** Changes how the project's agents reply, on its machine. A refusal shows above the composer. */
    fun setReplyStyle(style: ReplyStyle) {
        val shown = current().replyStyle ?: return
        if (shown.style == style && shown.isProjectOwn) return
        if (local.value.savingReplyStyle) return
        if (!shown.canChange) {
            local.update { it.copy(error = shown.readOnlyReason ?: "How agents reply can't be changed from this phone.") }
            return
        }
        local.update { it.copy(savingReplyStyle = true, error = null) }
        viewModelScope.launch {
            try {
                model.engine.setReplyStyle(style, shown.project)
                local.update { it.copy(savingReplyStyle = false) }
            } catch (error: Exception) {
                local.update { it.copy(savingReplyStyle = false, error = error.readable()) }
            }
        }
    }

    init {
        model.openSession(session)
        addCloseable { model.closeSession(session) }
    }

    fun setDraft(text: String) = local.update { it.copy(draft = text, error = null) }

    fun dismissError() = local.update { it.copy(error = null) }

    /** Sends the draft. On failure the text comes back so nothing typed is lost. */
    fun send() {
        val current = current()
        if (!current.canSend) return
        val text = current.draft.trim()
        local.update { it.copy(draft = "", sending = true, error = null) }
        viewModelScope.launch {
            try {
                model.engine.send(text, target = target)
                local.update { it.copy(sending = false) }
            } catch (error: Exception) {
                local.update { it.copy(sending = false, error = error.readable(), draft = if (it.draft.isEmpty()) text else it.draft) }
            }
        }
    }

    fun stop() = run { model.engine.stop(target) }

    fun respond(requestId: String, decision: ApprovalDecision) = busy(requestId) {
        model.engine.respond(requestId, target, decision)
    }

    fun answerAccess(request: AccessRequestRow, answer: AccessAnswer) = busy(request.itemId) {
        model.engine.answerAccess(request, target, answer)
    }

    /** Pin, resolve, rename, archive or change the runtime mode of this thread. */
    fun perform(action: ThreadAction) {
        val thread = (target as? ChatTarget.Thread)?.thread ?: return
        run { model.engine.perform(action, thread) }
    }

    fun reload() = model.engine.reload(session)

    private fun run(block: suspend () -> Unit) {
        viewModelScope.launch {
            try {
                block()
            } catch (error: Exception) {
                local.update { it.copy(error = error.readable()) }
            }
        }
    }

    private fun busy(id: String, block: suspend () -> Unit) {
        if (id in local.value.busy) return
        local.update { it.copy(busy = it.busy + id, error = null) }
        viewModelScope.launch {
            try {
                block()
                local.update { it.copy(busy = it.busy - id) }
            } catch (error: Exception) {
                local.update { it.copy(busy = it.busy - id, error = error.readable()) }
            }
        }
    }
}

internal fun Throwable.readable(): String = message?.takeIf { it.isNotBlank() } ?: "Something went wrong. Try again."
