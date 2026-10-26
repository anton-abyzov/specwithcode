import Foundation
import Testing
import SWCWire
@testable import SWCSync

@Suite("Device sessions")
struct DeviceSessionsTests {
  private let state = DeviceServiceState(
    hosts: [DeviceHostSummary(id: "local", label: "M4"), DeviceHostSummary(id: "ssh-mini", kind: "ssh", label: "Mini")],
    devices: [
      DeviceSummary(hostId: "local", id: "439CE36F", platform: .ios, name: "iPhone Duo", version: "iOS 26.0"),
      DeviceSummary(hostId: "local", id: "emulator-5554", platform: .android, name: "Pixel 9", version: "Android 16"),
      DeviceSummary(hostId: "ssh-mini", id: "emulator-5554", platform: .android, name: "Pixel 8", version: nil),
    ],
    sessions: [
      DeviceSession(threadId: "t-1", hostId: "local", deviceId: "439CE36F", platform: .ios),
      DeviceSession(threadId: "t-2", hostId: "local", deviceId: "439CE36F", platform: .ios),
      DeviceSession(threadId: "t-1", hostId: "local", deviceId: "emulator-5554", platform: .android),
      DeviceSession(threadId: "t-3", hostId: "ssh-mini", deviceId: "emulator-5554", platform: .android),
      DeviceSession(threadId: "t-4", hostId: "ssh-mini", deviceId: "gone", platform: .ios),
    ],
    hostStatus: "ready",
    hubBasePath: "/api/device-hub"
  )

  @Test func groupsSessionsByHostAndDevice() {
    let devices = MachineDevices(environmentId: "env-m4", state: state)
    #expect(devices.support == .available)
    #expect(devices.sessions.map(\.name) == ["iPhone Duo", "Pixel 9", "Pixel 8", "iOS Simulator"])
    // The same simulator open in two threads is one row that lists both.
    #expect(devices.sessions[0].threadIds == ["t-1", "t-2"])
    #expect(devices.sessions[0].detail == "iOS 26.0 · M4")
    // Android serials repeat across hosts, so the host is part of the key.
    #expect(devices.sessions[1].id != devices.sessions[2].id)
    #expect(devices.sessions[2].detail == "Mini")
    #expect(devices.sessions[1].isAndroid && !devices.sessions[0].isAndroid)
  }

  @Test func listsTheDevicesOfOneThread() {
    let devices = MachineDevices(environmentId: "env-m4", state: state)
    #expect(devices.sessions(forThread: "t-1").map(\.name) == ["iPhone Duo", "Pixel 9"])
    #expect(devices.sessions(forThread: "t-3").map(\.hostId) == ["ssh-mini"])
    #expect(devices.sessions(forThread: "t-9").isEmpty)
  }

  @Test func selectsByKeyAndFallsBackToTheFirst() {
    let sessions = MachineDevices(environmentId: "env-m4", state: state).sessions
    let key = DeviceSessionSummary.key(hostId: "ssh-mini", deviceId: "emulator-5554")
    #expect(key == #"["ssh-mini","emulator-5554"]"#)
    #expect(DeviceSessionSummary.select(sessions, key: key)?.name == "Pixel 8")
    #expect(DeviceSessionSummary.select(sessions, key: "missing")?.name == "iPhone Duo")
    #expect(DeviceSessionSummary.select([], key: key) == nil)
  }

  @Test func saysWhenDeviceSupportIsOff() {
    let off = MachineDevices(environmentId: "env-m4", state: DeviceServiceState(hostStatus: "disabled"))
    #expect(off.support == .unavailable(MachineDevices.disabledMessage))
    #expect(MachineDevices(environmentId: "env-m4", state: DeviceServiceState(hostStatus: "idle")).support == .available)
  }

  @Test func buildsHubAccessOnTheRouteOrigin() throws {
    let direct = try #require(DeviceHubAccess(origin: URL(string: "http://192.168.1.20:8319/")!, hubPath: "/api/device-hub", ticket: "tk", hostId: "local"))
    #expect(direct.httpBase == "http://192.168.1.20:8319/api/device-hub")
    #expect(direct.wsBase == "ws://192.168.1.20:8319/api/device-hub")
    #expect(direct.query == ["wsTicket": "tk", "hostId": "local"])
    #expect(direct.credentials == false)

    let tunnel = try #require(DeviceHubAccess(origin: URL(string: "https://relay.example.com/t/env-1/?x=1")!, hubPath: "/api/device-hub", ticket: "tk", hostId: "ssh-mini"))
    #expect(tunnel.httpBase == "https://relay.example.com/t/env-1/api/device-hub")
    #expect(tunnel.wsBase == "wss://relay.example.com/t/env-1/api/device-hub")

    #expect(DeviceHubAccess(origin: URL(string: "http://mac:8319/")!, hubPath: "api/device-hub", ticket: "tk", hostId: "local") == nil)
  }

  @Test func encodesAccessAsTheStreamTransportReadsIt() throws {
    let access = DeviceHubAccess(httpBase: "http://mac/api/device-hub", wsBase: "ws://mac/api/device-hub", query: ["wsTicket": "tk"])
    let object = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(access)) as? [String: Any])
    #expect(Set(object.keys) == ["httpBase", "wsBase", "query", "credentials"])
    #expect(object["credentials"] as? Bool == false)
  }
}
