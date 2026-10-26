import Foundation
import Testing
@testable import SWCWire

@Suite("Device state")
struct DeviceStateTests {
  private func decode(_ json: String) throws -> DeviceServiceState {
    try JSONDecoder().decode(DeviceServiceState.self, from: Data(json.utf8))
  }

  @Test func decodesAServerStateAndIgnoresFieldsItDoesNotRead() throws {
    let state = try decode(#"""
    {"supportsHostRetry":true,"hosts":[{"id":"local","kind":"local","label":"M4","tools":{"hub":"1.2.0"}}],
     "hostStatus":"ready","hostStatuses":{"local":{"status":"ready"}},
     "devices":[{"hostId":"local","id":"439CE36F","platform":"ios","name":"iPhone Duo","version":"iOS 26.0","booted":true,"physical":false,"formFactor":"fold"}],
     "sessions":[{"threadId":"t-1","hostId":"local","deviceId":"439CE36F","platform":"ios","openedAt":"2026-10-25T08:00:00.000Z"}],
     "onboardingCompleted":true,"agentAccessEnabled":true,"hubBasePath":"/api/device-hub","revision":7}
    """#)
    #expect(state.hosts == [DeviceHostSummary(id: "local", kind: "local", label: "M4")])
    #expect(state.devices.first?.name == "iPhone Duo")
    #expect(state.devices.first?.platform == .ios)
    #expect(state.sessions.first?.deviceId == "439CE36F")
    #expect(state.hostStatus == "ready")
    #expect(state.revision == 7)
    #expect(state.hubPath == "/api/device-hub")
  }

  @Test func skipsEntriesItCannotReadAndDefaultsMissingLists() throws {
    let state = try decode(#"""
    {"devices":[{"hostId":"local","id":"a","platform":"ios","name":"One"},{"id":"no-host"},{"hostId":"h","id":"b","platform":"tvos","name":"Two"}],
     "sessions":"not a list","hostStatus":42,"hubBasePath":"https://elsewhere.example/hub"}
    """#)
    #expect(state.devices.map(\.id) == ["a", "b"])
    #expect(state.devices.last?.platform.rawValue == "tvos")
    #expect(state.hosts.isEmpty)
    #expect(state.sessions.isEmpty)
    #expect(state.hostStatus == nil)
    // Only an origin-relative hub path is used.
    #expect(state.hubPath == "/api/device-hub")
  }
}
