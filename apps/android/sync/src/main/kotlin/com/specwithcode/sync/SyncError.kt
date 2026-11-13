package com.specwithcode.sync

import com.specwithcode.transport.TransportException
import com.specwithcode.wire.ServerError
import kotlinx.serialization.SerializationException
import kotlin.coroutines.cancellation.CancellationException

/** Failures the engine reports. Each has a sentence the UI can show as is. */
sealed class SyncError(message: String) : Exception(message) {
    data object UnknownMachine : SyncError("That computer is no longer paired.")

    data class MachineOffline(val label: String) :
        SyncError("${label.ifEmpty { "That computer" }} is offline. Try again when it reconnects.")

    data object NoMachineConnected :
        SyncError("No computer is connected. Open SpecWithCode on one of your computers and try again.")

    /** A paired machine is offline or has not listed its projects yet. */
    data object MachinesNotLoaded :
        SyncError("Percy may already be on a computer that hasn't connected yet. Reconnect your computers, then try again.")

    /** Percy is turned off in the desktop's settings. */
    data object AideDisabled : SyncError("Percy is turned off. Turn it on in SpecWithCode's settings on your computer.")

    /** Percy is on elsewhere but turned off on the machine that would create it. */
    data class AideDisabledOn(val label: String) :
        SyncError("Percy is turned off on ${label.ifEmpty { "that computer" }}. Turn it on in SpecWithCode's settings there.")

    data object ProjectNotFound : SyncError("This project no longer exists on that computer.")
    data object NothingRunning : SyncError("Nothing is running.")
    data object EmptyMessage : SyncError("Type a message first.")
    data object EmptyTitle : SyncError("A name can't be empty.")
    data object RequestGone : SyncError("That request is no longer waiting for an answer.")
    data class SendBlocked(val reason: String) : SyncError(reason)

    /** The project changed since it was read. [latest] is the fresh copy, when it loaded. */
    data class ProjectConflict(val latest: ProjectSettingsDraft?) :
        SyncError("Someone else changed this project. The latest settings are loaded; make your change again.")

    /** A typed failure from the machine. */
    data class Server(val error: ServerError) : SyncError(error.message)
    data object UnreadableAnswer : SyncError("The computer sent an answer the app could not read.")
    data class Storage(val detail: String) : SyncError("The app could not save the computer's sign-in ($detail).")

    /** The machine's typed error, when there is one. */
    val serverError: ServerError? get() = (this as? Server)?.error

    companion object {
        /**
         * Makes any error readable: server and decoding failures are wrapped, errors that
         * already explain themselves pass through.
         */
        fun wrap(error: Throwable): Throwable = when (error) {
            is SyncError -> error
            is ServerError -> Server(error)
            is TransportException, is CancellationException -> error
            is SerializationException -> UnreadableAnswer
            else -> error
        }
    }
}
