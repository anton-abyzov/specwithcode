package com.specwithcode.android.app

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.specwithcode.sync.AppState
import com.specwithcode.sync.AppearancePreference
import com.specwithcode.sync.FixtureScenario
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

data class DisplayPrefs(val appearance: AppearancePreference, val dynamicColor: Boolean)

data class SignInState(
    val signedIn: Boolean = false,
    val busy: Boolean = false,
    val error: String? = null,
    /** False until the saved sign-in was read from storage, off the main thread. */
    val known: Boolean = true,
)

/** App-wide state and actions: engine choice, appearance, Connect sign-in and deep links. */
class AppViewModel(
    private val holder: AppSessionHolder,
    private val settings: SettingsStore,
    private val connect: ConnectSignIn,
    /** Where sign-in state is read: it touches encrypted storage, so never the main thread. */
    private val io: CoroutineDispatcher = Dispatchers.IO,
) : ViewModel() {
    val session: StateFlow<AppSession> = holder.session

    private val mutablePrefs = MutableStateFlow(DisplayPrefs(settings.appearance, settings.dynamicColor))
    val prefs: StateFlow<DisplayPrefs> = mutablePrefs.asStateFlow()

    private val mutableSignIn = MutableStateFlow(SignInState(known = false))
    val signIn: StateFlow<SignInState> = mutableSignIn.asStateFlow()

    init {
        viewModelScope.launch {
            val signedIn = readSignedIn()
            mutableSignIn.update { it.copy(signedIn = signedIn, known = true) }
        }
    }

    private suspend fun readSignedIn(): Boolean = withContext(io) { connect.isSignedIn }

    private val mutableDeepLink = MutableStateFlow<DeepLink?>(null)

    /** A link the app was opened with, waiting for navigation to handle it. */
    val pendingDeepLink: StateFlow<DeepLink?> = mutableDeepLink.asStateFlow()

    fun handleDeepLink(raw: String?) {
        DeepLink.parse(raw)?.let { mutableDeepLink.value = it }
    }

    fun consumeDeepLink() {
        mutableDeepLink.value = null
    }

    fun setAppearance(appearance: AppearancePreference) {
        settings.appearance = appearance
        holder.current.model.setAppearance(appearance)
        mutablePrefs.update { it.copy(appearance = appearance) }
    }

    fun setDynamicColor(enabled: Boolean) {
        settings.dynamicColor = enabled
        mutablePrefs.update { it.copy(dynamicColor = enabled) }
    }

    fun useSampleData(scenario: FixtureScenario = FixtureScenario.Default) = holder.switchTo(EngineMode.Sample(scenario))

    fun exitSampleData() = holder.switchTo(EngineMode.Live)

    fun signIn() {
        if (mutableSignIn.value.busy) return
        mutableSignIn.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            val result = connect.signIn()
            val signedIn = readSignedIn()
            mutableSignIn.update {
                it.copy(busy = false, signedIn = signedIn, error = result.exceptionOrNull()?.message, known = true)
            }
            // Signed in from sample data: show the account's real computers.
            if (result.isSuccess && holder.current.isSample) exitSampleData()
        }
    }

    fun clearSignInError() = mutableSignIn.update { it.copy(error = null) }

    /** Signs out of Connect and leaves sample data, back to the welcome screen. */
    fun signOut() {
        viewModelScope.launch {
            connect.signOut()
            mutableSignIn.value = SignInState(signedIn = readSignedIn())
            if (holder.current.isSample) exitSampleData()
        }
    }

    fun removeMachine(id: String) = holder.current.model.engine.removeMachine(id)

    companion object {
        /** Whether the app opens on the home screen rather than welcome. */
        fun startsAtHome(state: AppState, isSample: Boolean, signedIn: Boolean): Boolean =
            isSample || signedIn || state.machines.isNotEmpty()
    }
}
