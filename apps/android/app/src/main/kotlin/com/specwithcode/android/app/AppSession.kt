package com.specwithcode.android.app

import android.content.Context
import androidx.core.content.edit
import com.specwithcode.sync.AppEngine
import com.specwithcode.sync.AppModel
import com.specwithcode.sync.AppearancePreference
import com.specwithcode.sync.FixtureEngine
import com.specwithcode.sync.FixtureScenario
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Small app preferences. Credentials never live here. */
interface SettingsStore {
    var appearance: AppearancePreference
    var dynamicColor: Boolean

    /** The sample scenario in use, or null for real machines. */
    var sampleScenario: String?
}

class InMemorySettingsStore(
    override var appearance: AppearancePreference = AppearancePreference.System,
    override var dynamicColor: Boolean = false,
    override var sampleScenario: String? = null,
) : SettingsStore

class SharedPreferencesSettingsStore(context: Context) : SettingsStore {
    private val prefs = context.getSharedPreferences("settings", Context.MODE_PRIVATE)

    override var appearance: AppearancePreference
        get() = AppearancePreference.entries.firstOrNull { it.name == prefs.getString("appearance", null) } ?: AppearancePreference.System
        set(value) = prefs.edit { putString("appearance", value.name) }

    override var dynamicColor: Boolean
        get() = prefs.getBoolean("dynamic_color", false)
        set(value) = prefs.edit { putBoolean("dynamic_color", value) }

    override var sampleScenario: String?
        get() = prefs.getString("sample_scenario", null)
        set(value) = prefs.edit { putString("sample_scenario", value) }
}

/** Which engine fills the app. */
sealed interface EngineMode {
    /** Sample data; nothing leaves the phone. */
    data class Sample(val scenario: FixtureScenario) : EngineMode

    /** The person's own machines. */
    data object Live : EngineMode
}

/** The model screens read, and how it is filled. */
class AppSession(val model: AppModel, val mode: EngineMode, internal val scope: CoroutineScope) {
    val isSample: Boolean get() = mode is EngineMode.Sample
}

/**
 * Owns the current [AppSession]. Switching between sample data and real machines builds a new
 * model; screens follow [session].
 */
class AppSessionHolder(
    private val settings: SettingsStore,
    /** Builds the engine for real machines: the app passes its `LiveEngine`; tests keep [PendingLiveEngine]. */
    private val liveEngine: () -> AppEngine = { PendingLiveEngine() },
    private val scopeFactory: () -> CoroutineScope = { CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate) },
    /** Zero in tests so fixture replies finish at once. */
    private val fixtureDelays: Boolean = true,
    initialMode: EngineMode? = null,
) {
    private val mutableSession = MutableStateFlow(build(initialMode ?: savedMode()))
    val session: StateFlow<AppSession> = mutableSession.asStateFlow()

    val current: AppSession get() = mutableSession.value

    private fun savedMode(): EngineMode =
        settings.sampleScenario?.let { EngineMode.Sample(FixtureScenario.fromRaw(it)) } ?: EngineMode.Live

    private fun build(mode: EngineMode): AppSession {
        val scope = scopeFactory()
        val engine = when (mode) {
            is EngineMode.Sample -> FixtureEngine(mode.scenario, aideEnabled = true, scope = scope).also {
                if (!fixtureDelays) {
                    it.latencyMs = 0
                    it.streamDelayMs = 0
                }
            }
            EngineMode.Live -> liveEngine()
        }
        val model = AppModel(engine)
        model.setAppearance(settings.appearance)
        return AppSession(model, mode, scope)
    }

    /** Whether the app is in the foreground; the engine in use follows it. */
    private var foreground = false

    /** Foreground (true) or background (false): passed to the engine in use, and to the next one after [switchTo]. */
    fun setActive(active: Boolean) {
        foreground = active
        current.model.engine.setActive(active)
    }

    /** Switches engines. [persist] is false for a one-off launch (e.g. a screenshot run). */
    fun switchTo(mode: EngineMode, persist: Boolean = true) {
        if (persist) settings.sampleScenario = (mode as? EngineMode.Sample)?.scenario?.rawValue
        if (mode == current.mode) return
        val old = current
        // The old engine lets go of its connections first; the live engine is reused later.
        old.model.engine.setActive(false)
        old.scope.cancel()
        val next = build(mode)
        mutableSession.value = next
        if (foreground) next.model.engine.setActive(true)
    }
}
