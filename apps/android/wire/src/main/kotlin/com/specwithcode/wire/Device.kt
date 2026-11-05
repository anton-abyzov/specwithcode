package com.specwithcode.wire

import kotlinx.serialization.Serializable

// `subscribeDeviceState` (packages/contracts/src/device.ts): the simulators and emulators a
// machine's agents opened, and which thread opened each. Only the fields the device viewer
// reads; a missing or malformed list decodes as empty so no server version fails the decode.

/** A machine that runs devices: the server itself (`local`) or an SSH host. */
@Serializable
data class DeviceHostSummary(
    val id: String,
    /** `local` or `ssh`. */
    val kind: String? = null,
    val label: String,
)

@Serializable
data class DeviceSummary(
    val hostId: String,
    /** Simulator udid or adb serial. Android serials repeat across hosts. */
    val id: String,
    val platform: DevicePlatform,
    val name: String,
    /** OS label such as "iOS 18.0". */
    val version: String? = null,
    val booted: Boolean? = null,
)

/** A device a thread is looking at. One per (thread, device). */
@Serializable
data class DeviceSession(
    val threadId: String,
    val hostId: String,
    val deviceId: String,
    val platform: DevicePlatform,
    val openedAt: String? = null,
)

object LenientDeviceHosts : LenientListSerializer<DeviceHostSummary>(DeviceHostSummary.serializer())
object LenientDevices : LenientListSerializer<DeviceSummary>(DeviceSummary.serializer())
object LenientDeviceSessions : LenientListSerializer<DeviceSession>(DeviceSession.serializer())

/** `DeviceServiceState`: one value per chunk of `subscribeDeviceState`. */
@Serializable
data class DeviceServiceState(
    @Serializable(with = LenientDeviceHosts::class) val hosts: List<DeviceHostSummary> = emptyList(),
    @Serializable(with = LenientDevices::class) val devices: List<DeviceSummary> = emptyList(),
    @Serializable(with = LenientDeviceSessions::class) val sessions: List<DeviceSession> = emptyList(),
    /** `disabled`, `idle`, `installing`, `starting`, `ready` or `failed`. */
    @Serializable(with = LenientString::class) val hostStatus: String? = null,
    @Serializable(with = LenientString::class) val hostStatusDetail: String? = null,
    /** Origin-relative path in front of the device hub, `/api/device-hub`. */
    @Serializable(with = LenientString::class) val hubBasePath: String? = null,
    @Serializable(with = LenientInt::class) val revision: Int? = null,
) {
    /** The hub path, `/api/device-hub` when the server leaves it out. */
    val hubPath: String get() = hubBasePath?.takeIf { it.startsWith("/") } ?: "/api/device-hub"
}
