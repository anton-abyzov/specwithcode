import Foundation

// `subscribeDeviceState` (packages/contracts/src/device.ts): the simulators and
// emulators a machine's agents opened, and which thread opened each. Only the
// fields the device viewer reads; everything else is ignored, and a missing
// list decodes as empty so a newer or older server never fails the decode.

/// `"ios"` or `"android"`.
public struct DevicePlatform: OpenStringEnum {
  public enum Known: String, Sendable, CaseIterable { case ios, android }
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }

  public static let ios = Self(.ios)
  public static let android = Self(.android)
}

/// A machine that runs devices: the server itself (`local`) or an SSH host.
public struct DeviceHostSummary: Codable, Hashable, Sendable {
  public var id: String
  /// `local` or `ssh`.
  public var kind: String?
  public var label: String

  public init(id: String, kind: String? = nil, label: String) {
    self.id = id
    self.kind = kind
    self.label = label
  }
}

public struct DeviceSummary: Codable, Hashable, Sendable {
  public var hostId: String
  /// Simulator udid or adb serial. Android serials repeat across hosts.
  public var id: String
  public var platform: DevicePlatform
  public var name: String
  /// OS label such as "iOS 18.0".
  public var version: String?
  public var booted: Bool?

  public init(hostId: String, id: String, platform: DevicePlatform, name: String, version: String? = nil, booted: Bool? = nil) {
    self.hostId = hostId
    self.id = id
    self.platform = platform
    self.name = name
    self.version = version
    self.booted = booted
  }
}

/// A device a thread is looking at. One per (thread, device).
public struct DeviceSession: Codable, Hashable, Sendable {
  public var threadId: String
  public var hostId: String
  public var deviceId: String
  public var platform: DevicePlatform
  public var openedAt: String?

  public init(threadId: String, hostId: String, deviceId: String, platform: DevicePlatform, openedAt: String? = nil) {
    self.threadId = threadId
    self.hostId = hostId
    self.deviceId = deviceId
    self.platform = platform
    self.openedAt = openedAt
  }
}

/// `DeviceServiceState`: one value per chunk of `subscribeDeviceState`.
public struct DeviceServiceState: Codable, Hashable, Sendable {
  public var hosts: [DeviceHostSummary]
  public var devices: [DeviceSummary]
  public var sessions: [DeviceSession]
  /// `disabled`, `idle`, `installing`, `starting`, `ready` or `failed`.
  public var hostStatus: String?
  public var hostStatusDetail: String?
  /// Origin-relative path in front of the device hub, `/api/device-hub`.
  public var hubBasePath: String?
  public var revision: Int?

  public init(hosts: [DeviceHostSummary] = [], devices: [DeviceSummary] = [], sessions: [DeviceSession] = [], hostStatus: String? = nil, hostStatusDetail: String? = nil, hubBasePath: String? = nil, revision: Int? = nil) {
    self.hosts = hosts
    self.devices = devices
    self.sessions = sessions
    self.hostStatus = hostStatus
    self.hostStatusDetail = hostStatusDetail
    self.hubBasePath = hubBasePath
    self.revision = revision
  }

  enum CodingKeys: String, CodingKey {
    case hosts, devices, sessions, hostStatus, hostStatusDetail, hubBasePath, revision
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    hosts = Self.lenient(c, .hosts)
    devices = Self.lenient(c, .devices)
    sessions = Self.lenient(c, .sessions)
    hostStatus = try? c.decodeIfPresent(String.self, forKey: .hostStatus)
    hostStatusDetail = try? c.decodeIfPresent(String.self, forKey: .hostStatusDetail)
    hubBasePath = try? c.decodeIfPresent(String.self, forKey: .hubBasePath)
    revision = try? c.decodeIfPresent(Int.self, forKey: .revision)
  }

  /// Drops entries it can't read instead of failing the whole state.
  private static func lenient<T: Decodable>(_ c: KeyedDecodingContainer<CodingKeys>, _ key: CodingKeys) -> [T] {
    guard let items = try? c.decodeIfPresent([Lenient<T>].self, forKey: key) else { return [] }
    return items.compactMap(\.value)
  }

  /// The hub path, `/api/device-hub` when the server leaves it out.
  public var hubPath: String {
    guard let hubBasePath, hubBasePath.hasPrefix("/") else { return "/api/device-hub" }
    return hubBasePath
  }
}

/// One array element that may fail to decode on its own.
private struct Lenient<T: Decodable>: Decodable {
  let value: T?
  init(from decoder: Decoder) throws {
    value = try? T(from: decoder)
  }
}
