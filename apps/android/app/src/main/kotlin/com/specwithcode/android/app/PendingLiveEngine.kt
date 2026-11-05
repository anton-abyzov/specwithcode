package com.specwithcode.android.app

import com.specwithcode.sync.AccessAnswer
import com.specwithcode.sync.AccessRequestRow
import com.specwithcode.sync.AppEngine
import com.specwithcode.sync.AppModel
import com.specwithcode.sync.ApprovalDecision
import com.specwithcode.sync.ChatSession
import com.specwithcode.sync.ChatTarget
import com.specwithcode.sync.MachineSettings
import com.specwithcode.sync.MachineSummary
import com.specwithcode.sync.OutgoingImage
import com.specwithcode.sync.ProjectRef
import com.specwithcode.sync.ProjectSettingsDraft
import com.specwithcode.sync.SyncError
import com.specwithcode.sync.ThreadAction
import com.specwithcode.sync.ThreadRef

/**
 * Stands in for the live engine until it is wired: no machines, and every call that would
 * reach one says plainly that it isn't available in this build. Screens are the same either way.
 */
class PendingLiveEngine : AppEngine {
    private var model: AppModel? = null

    private fun unavailable(): Nothing =
        throw SyncError.SendBlocked("Connecting to your computers isn't available in this build yet. Try the sample data for now.")

    override fun start(model: AppModel) {
        this.model = model
        model.update { it.copy(isLoading = false) }
    }

    override fun setActive(active: Boolean) = Unit
    override suspend fun pair(link: String, expectedEnvironmentId: String?): MachineSummary = unavailable()
    override fun removeMachine(id: String) {
        model?.update { state -> state.copy(machines = state.machines.filter { it.id != id }) }
    }

    override fun reconnect(machineId: String) = Unit
    override suspend fun setConnectionEnabled(enabled: Boolean, machineId: String) = unavailable()
    override fun open(session: ChatSession) {
        session.update { it.copy(isLoaded = true, loadError = "This conversation isn't available in this build yet.") }
    }

    override fun close(session: ChatSession) = Unit
    override suspend fun send(text: String, images: List<OutgoingImage>, target: ChatTarget) = unavailable()
    override suspend fun stop(target: ChatTarget) = unavailable()
    override suspend fun respond(requestId: String, target: ChatTarget, decision: ApprovalDecision) = unavailable()
    override suspend fun answerAccess(request: AccessRequestRow, target: ChatTarget, answer: AccessAnswer) = unavailable()
    override suspend fun perform(action: ThreadAction, thread: ThreadRef) = unavailable()
    override suspend fun setupAide(): ProjectRef = unavailable()
    override suspend fun loadProjectSettings(project: ProjectRef): ProjectSettingsDraft = unavailable()
    override suspend fun saveProjectSettings(draft: ProjectSettingsDraft, project: ProjectRef) = unavailable()
    override suspend fun loadMachineSettings(machineId: String): MachineSettings = unavailable()
    override suspend fun saveMachineSettings(settings: MachineSettings, machineId: String) = unavailable()
}
