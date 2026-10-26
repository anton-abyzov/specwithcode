import Foundation
import SWCWire

/// A simulator or emulator that threads on a machine have open, as the
/// device viewer lists it. Like threadDevicePreviews.ts, one row per
/// (host, device): Android serials repeat across hosts.
public struct DeviceSessionSummary: Identifiable, Hashable, Sendable {
  /// `["<hostId>","<deviceId>"]`, the key threadDevicePreviews.ts uses.
  public var id: String
  public var environmentId: String
  public var hostId: String
  public var deviceId: String
  public var isAndroid: Bool
  public var name: String
  /// OS version and host, e.g. "iOS 26.0 · M4".
  public var detail: String
  /// Threads looking at the device, in the order they opened it.
  public var threadIds: [String]

  public init(environmentId: String, hostId: String, deviceId: String, isAndroid: Bool, name: String, detail: String = "", threadIds: [String] = []) {
    self.id = Self.key(hostId: hostId, deviceId: deviceId)
    self.environmentId = environmentId
    self.hostId = hostId
    self.deviceId = deviceId
    self.isAndroid = isAndroid
    self.name = name
    self.detail = detail
    self.threadIds = threadIds
  }

  public static func key(hostId: String, deviceId: String) -> String {
    let data = (try? JSONEncoder().encode([hostId, deviceId])) ?? Data()
    return String(decoding: data, as: UTF8.self)
  }

  /// The session with `key`, else the first one.
  public static func select(_ sessions: [DeviceSessionSummary], key: String?) -> DeviceSessionSummary? {
    sessions.first { $0.id == key } ?? sessions.first
  }
}

/// Whether a machine can show devices at all.
public enum DeviceSupport: Hashable, Sendable {
  /// The device state has not arrived yet.
  case loading
  case available
  /// Device support is off, the pairing may not read it, or the machine is too old.
  case unavailable(String)

  public var message: String? {
    if case let .unavailable(message) = self { return message }
    return nil
  }
}

/// A machine's open devices.
public struct MachineDevices: Hashable, Sendable {
  public var support: DeviceSupport
  public var sessions: [DeviceSessionSummary]
  /// Origin-relative path of the device hub.
  public var hubPath: String

  public init(support: DeviceSupport, sessions: [DeviceSessionSummary] = [], hubPath: String = "/api/device-hub") {
    self.support = support
    self.sessions = sessions
    self.hubPath = hubPath
  }

  public static let loading = MachineDevices(support: .loading)

  public static let disabledMessage = "Device support is off on this computer. Turn it on in SpecWithCode on the computer."
  public static let notAllowedMessage = "This pairing can't see devices. Pair the phone again to allow it."
  public static let unsupportedMessage = "This computer's SpecWithCode doesn't share devices yet. Update it on the computer."

  /// The sessions in a `subscribeDeviceState` value, one per device.
  public init(environmentId: String, state: DeviceServiceState) {
    var order: [String] = []
    var byKey: [String: DeviceSessionSummary] = [:]
    for session in state.sessions {
      let key = DeviceSessionSummary.key(hostId: session.hostId, deviceId: session.deviceId)
      if byKey[key] != nil {
        if !byKey[key]!.threadIds.contains(session.threadId) { byKey[key]!.threadIds.append(session.threadId) }
        continue
      }
      let device = state.devices.first { $0.hostId == session.hostId && $0.id == session.deviceId }
      let host = state.hosts.first { $0.id == session.hostId }
      let android = session.platform == .android
      let name = device?.name ?? (android ? "Android Emulator" : "iOS Simulator")
      let detail = [device?.version, host?.label].compactMap { $0?.isEmpty == false ? $0 : nil }.joined(separator: " · ")
      byKey[key] = DeviceSessionSummary(environmentId: environmentId, hostId: session.hostId, deviceId: session.deviceId, isAndroid: android, name: name, detail: detail, threadIds: [session.threadId])
      order.append(key)
    }
    let sessions = order.compactMap { byKey[$0] }
    let support: DeviceSupport = sessions.isEmpty && state.hostStatus == "disabled" ? .unavailable(Self.disabledMessage) : .available
    self.init(support: support, sessions: sessions, hubPath: state.hubPath)
  }

  /// The devices a thread has open.
  public func sessions(forThread threadId: String) -> [DeviceSessionSummary] {
    sessions.filter { $0.threadIds.contains(threadId) }
  }
}
