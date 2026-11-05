package com.specwithcode.android

import com.specwithcode.android.ui.machines.detailLine
import com.specwithcode.sync.MachineStatus
import com.specwithcode.sync.MachineSummary
import kotlin.test.Test
import kotlin.test.assertEquals

class MachineDetailLineTest {
    private val m4 = MachineSummary(id = "m4", label = "MacBook M4MAX", status = MachineStatus.Connected, platform = "macOS · arm64", serverVersion = "1.0.200")

    @Test
    fun aDirectPairingReachedThroughConnectSaysConnect() {
        assertEquals("macOS · arm64 · v1.0.200 · SpecWithCode Connect", m4.copy(connectedViaConnect = true).detailLine())
    }

    @Test
    fun aConnectRouteKeepsTheDirectPairingsExpiry() {
        assertEquals("macOS · arm64 · v1.0.200 · SpecWithCode Connect · Pairing ends within a day", m4.copy(connectedViaConnect = true, tokenDaysLeft = 1).detailLine())
    }

    @Test
    fun aDirectPairingStillShowsItsExpiry() {
        assertEquals("macOS · arm64 · v1.0.200 · Pairing ends in 12 days", m4.copy(tokenDaysLeft = 12).detailLine())
    }
}
