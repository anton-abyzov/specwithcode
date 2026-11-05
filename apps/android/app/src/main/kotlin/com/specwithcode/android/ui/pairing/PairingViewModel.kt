package com.specwithcode.android.ui.pairing

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.specwithcode.android.app.PairingInput
import com.specwithcode.android.ui.chat.readable
import com.specwithcode.sync.MachineSummary
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

enum class PairingMode { Link, Manual }

data class PairingUi(
    val mode: PairingMode = PairingMode.Link,
    val link: String = "",
    val host: String = "",
    val code: String = "",
    val connecting: Boolean = false,
    val error: String? = null,
    /** Set once pairing worked; the screen leaves. */
    val paired: MachineSummary? = null,
    /** The link came from another app or a web page, so it waits for the user to confirm it. */
    val fromExternalLink: Boolean = false,
) {
    /** The computer a link-mode Connect would pair with, shown before connecting. */
    val linkHost: String?
        get() = if (mode == PairingMode.Link && link.isNotBlank()) PairingInput.host(link) else null

    /** The link a Connect press would use, or null when the input is not complete. */
    val effectiveLink: String?
        get() = when (mode) {
            PairingMode.Link -> link.trim().takeIf { it.isNotEmpty() }?.let(PairingInput::unwrap)
            PairingMode.Manual -> PairingInput.manualLink(host, code)
        }

    val canConnect: Boolean get() = !connecting && effectiveLink != null

    /** The sign-in would cross the network unencrypted. */
    val isCleartext: Boolean
        get() = when (mode) {
            PairingMode.Link -> link.isNotBlank() && PairingInput.isCleartext(link)
            PairingMode.Manual -> PairingInput.origin(host)?.startsWith("http://") == true
        }

    /** Shown under the code field once twelve characters are in but some are not valid. */
    val codeHint: String?
        get() {
            val clean = PairingInput.normalizeCode(code)
            return when {
                clean.isEmpty() -> null
                clean.length < PairingInput.CODE_LENGTH -> "${PairingInput.CODE_LENGTH - clean.length} more characters"
                !PairingInput.isValidCode(clean) -> "Use the 12-character code shown on your computer."
                else -> null
            }
        }
}

/** Pairs a machine from a scanned QR code, a pasted link or a typed host and code. */
class PairingViewModel(
    private val pair: suspend (link: String, expectedEnvironmentId: String?) -> MachineSummary,
    private val expectedMachineId: String? = null,
    /**
     * A link opened from another app or a web page. It is only prefilled: the user sees the
     * computer it pairs with and taps Connect, so no page can pair a machine on its own.
     */
    initialLink: String? = null,
) : ViewModel() {
    private val mutableUi = MutableStateFlow(
        PairingUi(link = initialLink.orEmpty(), fromExternalLink = !initialLink.isNullOrBlank()),
    )
    val ui: StateFlow<PairingUi> = mutableUi.asStateFlow()

    fun setMode(mode: PairingMode) = mutableUi.update { it.copy(mode = mode, error = null) }
    fun setLink(value: String) = mutableUi.update { it.copy(link = value, error = null) }
    fun setHost(value: String) = mutableUi.update { it.copy(host = value, error = null) }
    fun setCode(value: String) = mutableUi.update { it.copy(code = PairingInput.normalizeCode(value).take(PairingInput.CODE_LENGTH), error = null) }

    /** A QR code was read: use it as the link and connect. */
    fun onScanned(raw: String) {
        mutableUi.update { it.copy(mode = PairingMode.Link, link = raw.trim(), error = null, fromExternalLink = false) }
        connect()
    }

    fun connect() {
        val state = mutableUi.value
        if (state.connecting) return
        val link = state.effectiveLink
        if (link == null) {
            mutableUi.update {
                it.copy(
                    error = if (it.mode == PairingMode.Manual) {
                        "Enter the computer's address and the 12-character code shown on it."
                    } else {
                        "Paste the pairing link from your computer."
                    },
                )
            }
            return
        }
        if (state.fromExternalLink && state.mode == PairingMode.Link && PairingInput.isPublicCleartext(state.link)) {
            mutableUi.update {
                it.copy(error = "This link would send the sign-in unencrypted over the internet. Use an https link, or pair on your local network or Tailscale.")
            }
            return
        }
        mutableUi.update { it.copy(connecting = true, error = null) }
        viewModelScope.launch {
            try {
                val machine = pair(link, expectedMachineId)
                mutableUi.update { it.copy(connecting = false, paired = machine) }
            } catch (error: Exception) {
                mutableUi.update { it.copy(connecting = false, error = error.readable()) }
            }
        }
    }
}
