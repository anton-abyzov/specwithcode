package com.specwithcode.android.ui.newthread

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.specwithcode.android.ui.chat.readable
import com.specwithcode.sync.AppModel
import com.specwithcode.sync.AppState
import com.specwithcode.sync.ModelChoice
import com.specwithcode.sync.NewThreadRequest
import com.specwithcode.sync.ProjectRef
import com.specwithcode.sync.ProjectSummary
import com.specwithcode.sync.RuntimeModeChoice
import com.specwithcode.sync.ThreadRef
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class NewThreadUi(
    val projects: List<ProjectSummary> = emptyList(),
    val project: ProjectSummary? = null,
    val models: List<ModelChoice> = emptyList(),
    /** Null is the machine's default model. */
    val model: ModelChoice? = null,
    val runtimeMode: RuntimeModeChoice = RuntimeModeChoice.ApprovalRequired,
    val text: String = "",
    val starting: Boolean = false,
    val error: String? = null,
    /** Set once the thread exists; the screen opens it. */
    val created: ThreadRef? = null,
) {
    val canStart: Boolean get() = project != null && project.machineOnline && text.isNotBlank() && !starting

    /** Why Start is off, when it is not just an empty message. */
    val blockedReason: String?
        get() = when {
            projects.isEmpty() -> "No projects yet. Create one in SpecWithCode on your computer."
            project != null && !project.machineOnline -> "${project.machineLabel} is offline. Pick a project on a connected computer."
            else -> null
        }
}

/** Starts a thread: pick a project, a model and how much it may do on its own, then the first message. */
class NewThreadViewModel(private val model: AppModel, initialProject: ProjectRef? = null) : ViewModel() {
    private data class Local(
        val project: ProjectRef?,
        val model: ModelChoice? = null,
        val runtimeMode: RuntimeModeChoice = RuntimeModeChoice.ApprovalRequired,
        val text: String = "",
        val starting: Boolean = false,
        val error: String? = null,
        val created: ThreadRef? = null,
    )

    private val local = MutableStateFlow(Local(initialProject))

    val ui: StateFlow<NewThreadUi> = combine(model.state, local, ::build)
        .stateIn(viewModelScope, SharingStarted.Eagerly, build(model.value, local.value))

    private fun build(state: AppState, l: Local): NewThreadUi {
        val projects = state.projects.filter { !it.archived && !it.isAutomated }
        val project = l.project?.let { ref -> projects.firstOrNull { it.contains(ref) } }
            ?: projects.firstOrNull { it.machineOnline }
            ?: projects.firstOrNull()
        val models = project?.let { state.modelChoices[it.ref.environmentId] }.orEmpty()
        return NewThreadUi(
            projects = projects,
            project = project,
            models = models,
            model = l.model?.takeIf { it in models },
            runtimeMode = l.runtimeMode,
            text = l.text,
            starting = l.starting,
            error = l.error,
            created = l.created,
        )
    }

    fun selectProject(ref: ProjectRef) = local.update { it.copy(project = ref, model = null, error = null) }
    fun selectModel(choice: ModelChoice?) = local.update { it.copy(model = choice) }
    fun selectRuntimeMode(mode: RuntimeModeChoice) = local.update { it.copy(runtimeMode = mode) }
    fun setText(text: String) = local.update { it.copy(text = text, error = null) }

    fun start() {
        val current = build(model.value, local.value)
        val project = current.project ?: return
        if (!current.canStart) return
        local.update { it.copy(starting = true, error = null) }
        viewModelScope.launch {
            try {
                val ref = model.engine.startThread(NewThreadRequest(project.ref, current.text.trim(), current.model, current.runtimeMode))
                local.update { it.copy(starting = false, created = ref) }
            } catch (error: Exception) {
                local.update { it.copy(starting = false, error = error.readable()) }
            }
        }
    }
}
