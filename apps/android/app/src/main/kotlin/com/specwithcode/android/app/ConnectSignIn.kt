package com.specwithcode.android.app

import com.specwithcode.sync.ConnectAccount
import com.specwithcode.sync.LiveEngine
import com.specwithcode.sync.SyncError
import com.specwithcode.sync.connectSignIn
import com.specwithcode.sync.connectSignOut
import kotlin.coroutines.cancellation.CancellationException

/**
 * Signs in to SpecWithCode Connect. Screens only see this interface, injected through
 * [com.specwithcode.android.AppGraph]: [EngineConnectSignIn] in the app, fakes in tests.
 */
interface ConnectSignIn {
    /** Whether an account is signed in on this phone. */
    val isSignedIn: Boolean

    /** Runs the sign-in flow. Fails with a message the UI shows as is. */
    suspend fun signIn(): Result<Unit>

    suspend fun signOut()
}

/** Signs in with the account service, then lists the account's computers and connects to them. */
class EngineConnectSignIn(private val account: ConnectAccount, private val engine: () -> LiveEngine) : ConnectSignIn {
    override val isSignedIn: Boolean get() = account.isSignedIn()

    override suspend fun signIn(): Result<Unit> = try {
        engine().connectSignIn()
        Result.success(Unit)
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        Result.failure(SyncError.wrap(e))
    }

    override suspend fun signOut() = engine().connectSignOut()
}

/** For builds and tests without SpecWithCode Connect. */
class ConnectSignInUnavailable : ConnectSignIn {
    override val isSignedIn: Boolean = false

    override suspend fun signIn(): Result<Unit> = Result.failure(
        IllegalStateException("Signing in with SpecWithCode Connect isn't available yet. Pair with a QR code or link instead."),
    )

    override suspend fun signOut() = Unit
}
