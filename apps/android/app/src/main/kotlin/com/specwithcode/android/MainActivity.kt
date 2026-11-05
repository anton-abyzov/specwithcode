package com.specwithcode.android

import android.app.Application
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.core.content.edit
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.specwithcode.android.app.AppSessionHolder
import com.specwithcode.android.app.AppViewModel
import com.specwithcode.android.app.ConnectSignIn
import com.specwithcode.android.app.ConnectivityWatcher
import com.specwithcode.android.app.EngineConnectSignIn
import com.specwithcode.android.app.connect.ClerkConnectAccount
import com.specwithcode.android.app.connect.ConnectAuthFlow
import com.specwithcode.android.app.secure.DataStoreSealedValueFile
import com.specwithcode.android.app.secure.KeystoreCredentialStore
import com.specwithcode.android.app.secure.KeystoreDpopKeyStore
import com.specwithcode.android.app.secure.KeystoreSecretBox
import com.specwithcode.android.app.secure.SecureValues
import com.specwithcode.sync.ConnectRuntime
import com.specwithcode.sync.LiveEngine
import com.specwithcode.transport.ConnectConfig
import com.specwithcode.transport.CredentialStore
import com.specwithcode.transport.MachineHttp
import com.specwithcode.transport.MachineRegistry
import java.io.File
import java.util.UUID
import com.specwithcode.android.app.EngineMode
import com.specwithcode.android.app.SharedPreferencesSettingsStore
import com.specwithcode.android.app.SettingsStore
import com.specwithcode.android.ui.theme.WeaveTheme
import com.specwithcode.sync.FixtureScenario

/** App-wide objects: secure storage, the live engine, Connect sign-in and the session holder. */
class AppGraph(context: Context) {
    private val appContext = context.applicationContext
    val settings: SettingsStore = SharedPreferencesSettingsStore(appContext)

    /** Credentials and the Connect session, sealed with a Keystore key, in a file kept out of backups. */
    private val secureValues = SecureValues(DataStoreSealedValueFile(appContext), KeystoreSecretBox("specwithcode_credentials"))
    val credentials: CredentialStore = KeystoreCredentialStore(secureValues)

    /** Opens the sealed values on a background thread, so no screen waits on disk or the Keystore. */
    fun warmUp() {
        Thread({ runCatching { secureValues.warm() } }, "secure-warmup").start()
    }
    val registry = MachineRegistry(File(appContext.filesDir, "machines.json"))

    val connectConfig: ConnectConfig = ConnectConfig.resolve(
        BuildConfig.CONNECT_PUBLISHABLE_KEY,
        BuildConfig.CONNECT_RELAY_URL,
        BuildConfig.CONNECT_JWT_TEMPLATE,
        BuildConfig.CONNECT_OAUTH_PROVIDERS,
    )

    private val clientLabel: String = Build.MODEL?.takeIf { it.isNotBlank() } ?: "Android phone"

    val account = ClerkConnectAccount(
        config = connectConfig,
        values = secureValues,
        browser = { url -> ConnectAuthFlow.open(appContext, url) },
        redirectUrl = ConnectAuthFlow.redirectUrl(BuildConfig.APPLICATION_ID),
    )

    private val http = MachineHttp()

    /** One live engine for the app's lifetime; switching to sample data and back reuses it. */
    val liveEngine: LiveEngine by lazy {
        LiveEngine(
            registry = registry,
            credentials = credentials,
            clientLabel = clientLabel,
            http = http,
            connect = ConnectRuntime(
                config = connectConfig,
                account = account,
                keys = KeystoreDpopKeyStore(),
                credentials = credentials,
                http = http,
                deviceId = deviceId(appContext),
                clientLabel = clientLabel,
            ),
        )
    }

    val connect: ConnectSignIn = EngineConnectSignIn(account) { liveEngine }
    val sessions = AppSessionHolder(settings, liveEngine = { liveEngine })

    /** Retries dropped connections when the network changes. */
    val network = ConnectivityWatcher(appContext) { sessions.current.model.engine.networkChanged() }

    private companion object {
        /** A random id for this install, so Connect can tell phones apart. Not a secret; kept out of backups. */
        fun deviceId(context: Context): String {
            val prefs = context.getSharedPreferences("connect", Context.MODE_PRIVATE)
            return prefs.getString("device_id", null) ?: UUID.randomUUID().toString().also {
                prefs.edit { putString("device_id", it) }
            }
        }
    }
}

class SpecWithCodeApp : Application() {
    lateinit var graph: AppGraph
        private set

    override fun onCreate() {
        super.onCreate()
        graph = AppGraph(this)
        graph.warmUp()
        graph.network.start()
    }
}

class MainActivity : ComponentActivity() {
    private val graph: AppGraph get() = (application as SpecWithCodeApp).graph

    private val app: AppViewModel by viewModels {
        viewModelFactory { initializer { AppViewModel(graph.sessions, graph.settings, graph.connect) } }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        // Screenshot and UI test runs (debug builds) start on sample data without changing the saved choice:
        // adb shell am start -n com.specwithcode.android/.MainActivity --es fixture default
        // Without the extra the app uses the live engine (or the sample data the person chose).
        // Debug builds only: any app can start this exported activity with extras.
        if (BuildConfig.DEBUG) {
            intent.getStringExtra(EXTRA_FIXTURE)?.let { raw ->
                graph.sessions.switchTo(EngineMode.Sample(FixtureScenario.fromRaw(raw)), persist = false)
            }
        }
        if (savedInstanceState == null) app.handleDeepLink(intent.dataString)
        setContent {
            val prefs by app.prefs.collectAsStateWithLifecycle()
            WeaveTheme(appearance = prefs.appearance, dynamicColor = prefs.dynamicColor) {
                AppNavHost(app, BuildConfig.VERSION_NAME, BuildConfig.VERSION_CODE)
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        app.handleDeepLink(intent.dataString)
    }

    override fun onStart() {
        super.onStart()
        // Foreground: connect now, or cut a reconnect backoff short.
        graph.sessions.setActive(true)
    }

    override fun onResume() {
        super.onResume()
        ConnectAuthFlow.appResumed()
    }

    override fun onStop() {
        graph.sessions.setActive(false)
        super.onStop()
    }

    companion object {
        /** Starts the app on a sample scenario: `default`, `empty`, `running` or `long`. */
        const val EXTRA_FIXTURE = "fixture"
    }
}
