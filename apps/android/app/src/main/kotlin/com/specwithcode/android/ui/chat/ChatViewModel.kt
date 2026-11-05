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
import com.specwithcode.sync.ThreadAction
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
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
class ChatViewModel(private val model: AppModel, val target: ChatTarget) : ViewModel() {
    private val session: ChatSession = model.session(target)
    private val local = MutableStateFlow(Local())

    private data class Local(val draft: String = "", val busy: Set<String> = emptySet(), val error: String? = null, val sending: Boolean = false)

    val ui: StateFlow<ChatUi> = combine(session.state, local, ::build)
        .stateIn(viewModelScope, SharingStarted.Eagerly, ChatUi(session.value))

    private fun build(chat: ChatState, l: Local) = ChatUi(chat, l.draft, l.busy, l.error, l.sending)

    /** The state right now, without waiting for [ui] to catch up. */
    private fun current(): ChatUi = build(session.value, local.value)

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
