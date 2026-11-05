package com.specwithcode.sync

/**
 * Everything that talks to machines. Suspending methods throw [SyncError] or other
 * exceptions whose `message` the UI can show as is.
 *
 * Two engines fill the model:
 * - [FixtureEngine]: sample data for previews, tests and screenshots. Nothing leaves the phone.
 * - [LiveEngine]: the port of the iOS `LiveEngine`. It holds one `MachineConnection` per
 *   paired machine from `:transport`, runs the shell and thread reducers, and writes results
 *   into [AppModel] and open [ChatSession]s exactly as [FixtureEngine] does.
 *
 * Calls arrive on the main thread. Engines must update [AppModel] and [ChatSession] from that
 * thread too.
 */
interface AppEngine {
    /** Called once. The engine keeps [model] current from then on. */
    fun start(model: AppModel)

    /** The app came to the foreground or went to the background. */
    fun setActive(active: Boolean)

    /** The phone's network changed: try dropped connections again now. */
    fun networkChanged() {}

    suspend fun pair(link: String): MachineSummary = pair(link, expectedEnvironmentId = null)

    /** "Pair again" on a known machine: a link to another machine fails before its one-time code is spent. */
    suspend fun pair(link: String, expectedEnvironmentId: String?): MachineSummary

    fun removeMachine(id: String)

    /** Tries again now, closing a live connection first. */
    fun reconnect(machineId: String)

    suspend fun setConnectionEnabled(enabled: Boolean, machineId: String)

    /** Skips the rest of a dropped connection's backoff. */
    fun wake(machineId: String) = reconnect(machineId)

    /** Opens a live conversation. The engine fills and updates the session until [close]. */
    fun open(session: ChatSession)

    fun close(session: ChatSession)

    /** Loads an open conversation again after a load error. */
    fun reload(session: ChatSession) {
        close(session)
        open(session)
    }

    suspend fun send(text: String, images: List<OutgoingImage> = emptyList(), target: ChatTarget)

    /** Stops the active run and holds the queue. */
    suspend fun stop(target: ChatTarget)

    suspend fun respond(requestId: String, target: ChatTarget, decision: ApprovalDecision)

    /** Answers an access request card with `access.answerRequest`. */
    suspend fun answerAccess(request: AccessRequestRow, target: ChatTarget, answer: AccessAnswer)

    suspend fun perform(action: ThreadAction, thread: ThreadRef)

    /** Launches a thread with its first message (`thread.create`). Returns the new thread. */
    suspend fun startThread(request: NewThreadRequest): ThreadRef =
        throw SyncError.SendBlocked("Starting a thread from the phone isn't available yet.")

    suspend fun setupAide(): ProjectRef

    suspend fun loadProjectSettings(project: ProjectRef): ProjectSettingsDraft

    suspend fun saveProjectSettings(draft: ProjectSettingsDraft, project: ProjectRef)

    suspend fun loadMachineSettings(machineId: String): MachineSettings

    suspend fun saveMachineSettings(settings: MachineSettings, machineId: String)

    // Not ported yet from iOS (each keeps its iOS name so the port is a fill-in):
    // handoffOptions / checkHandoff / continueThread, incrementProgress, attachmentURL,
    // threadLinkMachines, connectSignIn / connectSignOut / connectPhones and the rest of
    // SpecWithCode Connect, deviceHubAccess.
}
