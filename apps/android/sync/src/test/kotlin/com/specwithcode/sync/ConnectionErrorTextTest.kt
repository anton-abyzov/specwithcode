package com.specwithcode.sync

import com.specwithcode.transport.MachineConnection.State
import com.specwithcode.transport.TransportException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class ConnectionErrorTextTest {
    @Test
    fun showsTheReasonOnlyWhileOffline() {
        val error = TransportException.UpgradeFailed(502)
        assertEquals("The computer refused the live connection (HTTP 502).", connectionErrorText(error, State.OFFLINE, viaConnect = true))
        for (state in listOf(State.CONNECTING, State.RECONNECTING, State.CONNECTED)) {
            assertNull(connectionErrorText(error, state, viaConnect = true))
        }
        assertNull(connectionErrorText(null, State.OFFLINE, viaConnect = false))
    }

    @Test
    fun leavesOutErrorsTheCardAlreadyShows() {
        assertNull(connectionErrorText(TransportException.TeamRules("Blocked by team rules."), State.OFFLINE, viaConnect = false))
        assertNull(connectionErrorText(TransportException.NeedsRepair(), State.OFFLINE, viaConnect = false))
    }

    @Test
    fun connectMachinesDoNotSuggestTheSameNetwork() {
        val error = TransportException.Unreachable("Offline")
        assertEquals(
            "The computer could not be reached through SpecWithCode Connect. Check that it is awake and online.",
            connectionErrorText(error, State.OFFLINE, viaConnect = true),
        )
        assertEquals(error.message, connectionErrorText(error, State.OFFLINE, viaConnect = false))
    }
}
