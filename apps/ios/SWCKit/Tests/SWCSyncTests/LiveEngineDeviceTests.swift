import Foundation
import Testing
import SWCTransport
import SWCWire
@testable import SWCSync

@MainActor
@Suite struct LiveEngineDeviceTests {
  let env = FakeMachine.environmentId

  @Test func followsDeviceStateAndMintsHubAccessOnTheRoute() async throws {
    let h = try await LiveEngineTests().harness()
    defer { h.engine.setActive(false) }
    #expect(await until { h.model.devices[env]?.sessions.first?.name == "iPhone Duo" })
    let session = try #require(h.model.devices[env]?.sessions.first)
    #expect(session.threadIds == ["thr_1"])
    #expect(h.model.deviceSessions(for: ThreadRef(environmentId: env, threadId: "thr_1")).count == 1)
    // A passive read: it never asks the machine to start helpers.
    #expect(h.machine.requests("device.list").isEmpty)

    let access = try await h.engine.deviceHubAccess(machineId: env, hostId: session.hostId)
    #expect(access.httpBase == "http://192.168.1.20:8319/api/device-hub")
    #expect(access.wsBase == "ws://192.168.1.20:8319/api/device-hub")
    #expect(access.query["hostId"] == "local")
    #expect(access.query["wsTicket"] == "tk.sig")
    #expect(access.credentials == false)
  }

  @Test func refusedDeviceStateSaysWhyAndBlocksTheViewer() async throws {
    let h = try await LiveEngineTests().harness(failing: [
      "subscribeDeviceState": #"{"_tag":"EnvironmentAuthorizationError","requiredScope":"orchestration:read","message":"Not allowed"}"#,
    ])
    defer { h.engine.setActive(false) }
    #expect(await until { h.model.devices[env]?.support == .unavailable(MachineDevices.notAllowedMessage) })
    await #expect(throws: SyncError.sendBlocked(MachineDevices.notAllowedMessage)) {
      try await h.engine.deviceHubAccess(machineId: env, hostId: "local")
    }
  }
}
