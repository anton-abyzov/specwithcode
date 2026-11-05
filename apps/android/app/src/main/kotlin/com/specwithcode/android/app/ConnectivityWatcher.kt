package com.specwithcode.android.app

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Handler
import android.os.Looper

/**
 * Tells the engine when the phone's network changes (Wi-Fi to cellular, back online), so
 * dropped connections retry at once instead of waiting out their backoff.
 */
class ConnectivityWatcher(context: Context, private val onChange: () -> Unit) {
    private val manager = context.getSystemService(ConnectivityManager::class.java)
    private val main = Handler(Looper.getMainLooper())
    private val notify = Runnable { onChange() }
    private var lastNetwork: Network? = null
    private var registered = false

    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) = changed(network)

        override fun onLost(network: Network) = changed(null)

        override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
            if (capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) && network != lastNetwork) changed(network)
        }
    }

    private fun changed(network: Network?) {
        lastNetwork = network
        // Several callbacks arrive together on a switch; one retry is enough.
        main.removeCallbacks(notify)
        main.postDelayed(notify, 300)
    }

    fun start() {
        if (registered || manager == null) return
        registered = runCatching { manager.registerDefaultNetworkCallback(callback) }.isSuccess
    }

    fun stop() {
        if (!registered) return
        runCatching { manager?.unregisterNetworkCallback(callback) }
        registered = false
    }
}
