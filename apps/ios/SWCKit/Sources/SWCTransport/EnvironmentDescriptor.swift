import Foundation

/// The fields of `GET /.well-known/studio/environment` the transport needs.
/// Extra keys are ignored.
public struct EnvironmentDescriptorLite: Sendable, Hashable, Codable {
  /// The orchestration protocol this app speaks.
  public static let supportedProtocolVersion = 2

  public struct Platform: Sendable, Hashable, Codable {
    public var os: String?
    public var arch: String?
    public var machine: String?

    public init(os: String? = nil, arch: String? = nil, machine: String? = nil) {
      self.os = os
      self.arch = arch
      self.machine = machine
    }
  }

  public var environmentId: String
  public var label: String
  public var serverVersion: String?
  /// Absent on servers from before protocol negotiation, which speak version 1.
  public var orchestrationProtocolVersion: Int?
  public var platform: Platform?

  public init(environmentId: String, label: String, serverVersion: String? = nil, orchestrationProtocolVersion: Int? = nil, platform: Platform? = nil) {
    self.environmentId = environmentId
    self.label = label
    self.serverVersion = serverVersion
    self.orchestrationProtocolVersion = orchestrationProtocolVersion
    self.platform = platform
  }

  /// The protocol version the server speaks; a missing value means 1.
  public var protocolVersion: Int { orchestrationProtocolVersion ?? 1 }

  /// Whether the server and this app speak the same protocol.
  public var protocolCompatibility: ProtocolCompatibility {
    if protocolVersion == Self.supportedProtocolVersion { return .compatible }
    return protocolVersion > Self.supportedProtocolVersion ? .appTooOld : .serverTooOld
  }

  /// e.g. "macOS · arm64"
  public var platformLabel: String? {
    guard let platform else { return nil }
    let os: String? = switch platform.os {
    case "darwin": "macOS"
    case "linux": "Linux"
    case "win32": "Windows"
    case let other: other
    }
    let parts = [os, platform.arch].compactMap { $0 }.filter { !$0.isEmpty }
    return parts.isEmpty ? nil : parts.joined(separator: " · ")
  }
}

public enum ProtocolCompatibility: Sendable, Hashable {
  case compatible
  /// The server speaks a newer protocol. Update the app.
  case appTooOld
  /// The server speaks an older protocol. Update SpecWithCode on the computer.
  case serverTooOld
}
