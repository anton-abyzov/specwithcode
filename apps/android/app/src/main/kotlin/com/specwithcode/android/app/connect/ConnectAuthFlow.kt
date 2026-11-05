package com.specwithcode.android.app.connect

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.browser.customtabs.CustomTabsIntent
import androidx.core.net.toUri
import com.specwithcode.android.MainActivity
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Hands the sign-in page to a Custom Tab and waits for its redirect. Closing the tab without
 * finishing ends the wait with "Sign-in was cancelled."
 */
object ConnectAuthFlow {
    private val lock = Any()
    private var pending: CompletableDeferred<String>? = null
    private var launchedAt = 0L

    /** The redirect the Expo app used, so the account service's allow list already has it. */
    fun redirectUrl(applicationId: String): String = "clerk://$applicationId.callback"

    suspend fun open(context: Context, url: String): String {
        val deferred = CompletableDeferred<String>()
        synchronized(lock) {
            pending?.completeExceptionally(ConnectSignInException("Sign-in was cancelled."))
            pending = deferred
            launchedAt = SystemClock.elapsedRealtime()
        }
        withContext(Dispatchers.Main) {
            val intent = CustomTabsIntent.Builder().setShowTitle(true).build()
            intent.intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            try {
                intent.launchUrl(context, url.toUri())
            } catch (e: ActivityNotFoundException) {
                deferred.completeExceptionally(ConnectSignInException("Install or turn on a web browser to sign in."))
            }
        }
        return try {
            deferred.await()
        } finally {
            synchronized(lock) { if (pending === deferred) pending = null }
        }
    }

    /** The browser redirected back with the result. */
    fun complete(uri: String) {
        synchronized(lock) { pending }?.complete(uri)
    }

    /** The app is in front again. If no redirect follows shortly, the person closed the page. */
    fun appResumed() {
        val deferred = synchronized(lock) {
            if (SystemClock.elapsedRealtime() - launchedAt < 1_000) return
            pending
        } ?: return
        Handler(Looper.getMainLooper()).postDelayed({
            deferred.completeExceptionally(ConnectSignInException("Sign-in was cancelled."))
        }, 1_500)
    }
}

/** Receives `clerk://<applicationId>.callback?...` from the browser and returns to the app. */
class ConnectCallbackActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        intent?.dataString?.let(ConnectAuthFlow::complete)
        startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP))
        finish()
    }
}
