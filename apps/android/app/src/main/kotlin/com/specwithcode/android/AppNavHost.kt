package com.specwithcode.android

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavDestination.Companion.hasRoute
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.toRoute
import com.specwithcode.android.app.AppViewModel
import com.specwithcode.android.app.DeepLink
import com.specwithcode.android.ui.chat.ChatScreen
import com.specwithcode.android.ui.chat.ChatViewModel
import com.specwithcode.android.ui.home.HomeScreen
import com.specwithcode.android.ui.machines.MachinesScreen
import com.specwithcode.android.ui.newthread.NewThreadScreen
import com.specwithcode.android.ui.newthread.NewThreadViewModel
import com.specwithcode.android.ui.pairing.PairingScreen
import com.specwithcode.android.ui.pairing.PairingViewModel
import com.specwithcode.android.ui.settings.LicensesScreen
import com.specwithcode.android.ui.settings.SettingsScreen
import com.specwithcode.android.ui.settings.SettingsUi
import com.specwithcode.android.ui.welcome.WelcomeScreen
import com.specwithcode.sync.ChatTarget
import com.specwithcode.sync.ProjectRef
import com.specwithcode.sync.ThreadRef
import kotlinx.serialization.Serializable

@Serializable data object WelcomeRoute

@Serializable data object HomeRoute

@Serializable data class PairRoute(val machineId: String? = null, val link: String? = null)

@Serializable data object MachinesRoute

/** [kind] is `aide`, `project` or `thread`; [id] is the project or thread id. */
@Serializable data class ChatRoute(val kind: String, val environmentId: String, val id: String) {
    fun target(): ChatTarget = when (kind) {
        "aide" -> ChatTarget.Aide(ProjectRef(environmentId, id))
        "project" -> ChatTarget.Project(ProjectRef(environmentId, id))
        else -> ChatTarget.Thread(ThreadRef(environmentId, id))
    }

    companion object {
        fun of(target: ChatTarget): ChatRoute = when (target) {
            is ChatTarget.Aide -> ChatRoute("aide", target.project.environmentId, target.project.projectId)
            is ChatTarget.Project -> ChatRoute("project", target.project.environmentId, target.project.projectId)
            is ChatTarget.Thread -> ChatRoute("thread", target.thread.environmentId, target.thread.threadId)
        }
    }
}

@Serializable data class NewThreadRoute(val environmentId: String? = null, val projectId: String? = null)

@Serializable data object SettingsRoute

@Serializable data object LicensesRoute

/** Every screen, driven by the current session's [com.specwithcode.sync.AppModel]. */
@Composable
fun AppNavHost(app: AppViewModel, versionName: String, versionCode: Int) {
    val session by app.session.collectAsStateWithLifecycle()
    val prefs by app.prefs.collectAsStateWithLifecycle()
    val signIn by app.signIn.collectAsStateWithLifecycle()
    // The first screen depends on the saved sign-in, read off the main thread: wait for it.
    if (!signIn.known && !session.isSample) {
        Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background))
        return
    }
    // A new session (sample data on or off) starts navigation over.
    key(session) {
        val model = session.model
        val state by model.state.collectAsStateWithLifecycle()
        val nav = rememberNavController()
        val start: Any = remember { if (AppViewModel.startsAtHome(model.value, session.isSample, signIn.signedIn)) HomeRoute else WelcomeRoute }
        val deepLink by app.pendingDeepLink.collectAsStateWithLifecycle()
        LaunchedEffect(deepLink) {
            when (val link = deepLink) {
                is DeepLink.Pair -> nav.navigate(PairRoute(link = link.link)) { launchSingleTop = true }
                is DeepLink.Thread -> nav.navigate(ChatRoute("thread", link.environmentId, link.threadId)) { launchSingleTop = true }
                null -> return@LaunchedEffect
            }
            app.consumeDeepLink()
        }
        // The sign-in state the screens last saw; null until the first pass.
        var lastSignedIn by remember { mutableStateOf<Boolean?>(null) }
        LaunchedEffect(signIn.signedIn) {
            val wasSignedIn = lastSignedIn
            lastSignedIn = signIn.signedIn
            val onWelcome = nav.currentDestination?.hasRoute<WelcomeRoute>() == true
            if (signIn.signedIn && onWelcome) nav.goHome()
            // Signing out with nothing paired: back to the start. Only on a real sign-out, so a
            // pairing link that opened the app on a cold start is not sent back to Welcome.
            if (wasSignedIn == true && !signIn.signedIn && !onWelcome && nav.currentDestination != null &&
                !AppViewModel.startsAtHome(model.value, session.isSample, signedIn = false)
            ) {
                nav.navigate(WelcomeRoute) { popUpTo(nav.graph.id) { inclusive = true } }
            }
        }
        NavHost(nav, startDestination = start) {
            composable<WelcomeRoute> {
                WelcomeScreen(
                    signIn = signIn,
                    onSignIn = app::signIn,
                    onPair = { app.clearSignInError(); nav.navigate(PairRoute()) },
                    onSampleData = { app.useSampleData() },
                )
            }
            composable<HomeRoute> {
                HomeScreen(
                    state = state,
                    isSample = session.isSample,
                    onOpenChat = { nav.navigate(ChatRoute.of(it)) },
                    onNewThread = { nav.navigate(NewThreadRoute(it?.environmentId, it?.projectId)) },
                    onMachines = { nav.navigate(MachinesRoute) },
                    onSettings = { nav.navigate(SettingsRoute) },
                    onExitSample = app::exitSampleData,
                )
            }
            composable<PairRoute> { entry ->
                val route = entry.toRoute<PairRoute>()
                val vm = viewModel { PairingViewModel({ link, expected -> model.engine.pair(link, expected) }, route.machineId, route.link) }
                PairingScreen(
                    viewModel = vm,
                    pairingAgain = route.machineId?.let { model.machine(it)?.displayName },
                    isSample = session.isSample,
                    onExitSample = app::exitSampleData,
                    onBack = { nav.popBackStack() },
                    onPaired = { nav.goHome() },
                )
            }
            composable<MachinesRoute> {
                MachinesScreen(
                    machines = state.machines,
                    engine = model.engine,
                    onBack = { nav.popBackStack() },
                    onPair = { nav.navigate(PairRoute(machineId = it?.id)) },
                )
            }
            composable<ChatRoute> { entry ->
                val route = entry.toRoute<ChatRoute>()
                val target = remember(route) { route.target() }
                val vm = viewModel { ChatViewModel(model, target) }
                ChatScreen(
                    viewModel = vm,
                    thread = (target as? ChatTarget.Thread)?.let { state.thread(it.thread) },
                    onBack = { nav.popBackStack() },
                    onOpenThread = { nav.navigate(ChatRoute.of(ChatTarget.Thread(it))) },
                )
            }
            composable<NewThreadRoute> { entry ->
                val route = entry.toRoute<NewThreadRoute>()
                val initial = route.projectId?.let { ProjectRef(route.environmentId.orEmpty(), it) }
                val vm = viewModel { NewThreadViewModel(model, initial) }
                NewThreadScreen(
                    viewModel = vm,
                    onBack = { nav.popBackStack() },
                    onCreated = { ref ->
                        nav.navigate(ChatRoute.of(ChatTarget.Thread(ref))) {
                            popUpTo<NewThreadRoute> { inclusive = true }
                        }
                    },
                )
            }
            composable<SettingsRoute> {
                SettingsScreen(
                    ui = SettingsUi(
                        appearance = prefs.appearance,
                        dynamicColor = prefs.dynamicColor,
                        isSample = session.isSample,
                        signedIn = signIn.signedIn,
                        machines = state.machines,
                        versionName = versionName,
                        versionCode = versionCode,
                    ),
                    onBack = { nav.popBackStack() },
                    onAppearance = app::setAppearance,
                    onDynamicColor = app::setDynamicColor,
                    onSampleData = { on -> if (on) app.useSampleData() else app.exitSampleData() },
                    onMachines = { nav.navigate(MachinesRoute) },
                    onRemoveMachine = app::removeMachine,
                    onLicenses = { nav.navigate(LicensesRoute) },
                    onSignOut = app::signOut,
                )
            }
            composable<LicensesRoute> { LicensesScreen(onBack = { nav.popBackStack() }) }
        }
    }
}

private fun NavHostController.goHome() {
    navigate(HomeRoute) {
        popUpTo(graph.id) { inclusive = true }
        launchSingleTop = true
    }
}
