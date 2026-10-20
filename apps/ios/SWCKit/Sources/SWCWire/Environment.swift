import Foundation

/// The orchestration protocol this app speaks.
public enum OrchestrationProtocol {
  public static let version = 2
  /// Query parameter for the socket URL.
  public static let queryParameter = "orchestrationProtocol"
  /// Header for REST snapshot routes.
  public static let header = "x-studio-orchestration-protocol"
}

/// `GET /.well-known/studio/environment`, served without auth.
public struct EnvironmentDescriptor: Codable, Hashable, Sendable {
  public var environmentId: String
  public var label: String
  public var platform: EnvironmentPlatform
  public var serverVersion: String?
  public var serverSourceCommit: String?
  /// Absent on hosts that predate protocol negotiation, which speak version 1.
  public var orchestrationProtocolVersion: Int?
  public var capabilities: EnvironmentCapabilities

  public init(environmentId: String, label: String, platform: EnvironmentPlatform, serverVersion: String? = nil, serverSourceCommit: String? = nil, orchestrationProtocolVersion: Int? = nil, capabilities: EnvironmentCapabilities = EnvironmentCapabilities()) {
    self.environmentId = environmentId
    self.label = label
    self.platform = platform
    self.serverVersion = serverVersion
    self.serverSourceCommit = serverSourceCommit
    self.orchestrationProtocolVersion = orchestrationProtocolVersion
    self.capabilities = capabilities
  }

  enum CodingKeys: String, CodingKey {
    case environmentId, label, platform, serverVersion, serverSourceCommit, orchestrationProtocolVersion, capabilities
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    environmentId = try c.decode(String.self, forKey: .environmentId)
    label = try c.decodeIfPresent(String.self, forKey: .label) ?? environmentId
    platform = try c.decodeIfPresent(EnvironmentPlatform.self, forKey: .platform) ?? EnvironmentPlatform(os: "unknown", arch: "other")
    serverVersion = try c.decodeIfPresent(String.self, forKey: .serverVersion)
    serverSourceCommit = try c.decodeIfPresent(String.self, forKey: .serverSourceCommit)
    orchestrationProtocolVersion = try c.decodeIfPresent(Int.self, forKey: .orchestrationProtocolVersion)
    capabilities = try c.decodeIfPresent(EnvironmentCapabilities.self, forKey: .capabilities) ?? EnvironmentCapabilities()
  }

  /// The protocol version, treating a missing value as 1.
  public var protocolVersion: Int { orchestrationProtocolVersion ?? 1 }

  public enum Compatibility: Sendable, Hashable {
    case compatible
    /// The machine runs an older protocol; its server needs an update.
    case serverTooOld(Int)
    /// The machine runs a newer protocol; this app needs an update.
    case appTooOld(Int)
  }

  public var compatibility: Compatibility {
    let v = protocolVersion
    if v == OrchestrationProtocol.version { return .compatible }
    return v < OrchestrationProtocol.version ? .serverTooOld(v) : .appTooOld(v)
  }
}

public struct EnvironmentPlatform: Codable, Hashable, Sendable {
  /// `darwin`, `linux`, `windows` or `unknown`.
  public var os: String
  /// `arm64`, `x64` or `other`.
  public var arch: String
  /// Hardware shape such as `laptop` or `mac-mini`, when the server detected one.
  public var machine: String?

  public init(os: String, arch: String, machine: String? = nil) {
    self.os = os
    self.arch = arch
    self.machine = machine
  }

  /// e.g. "macOS · arm64"
  public var displayName: String {
    let name = switch os {
    case "darwin": "macOS"
    case "linux": "Linux"
    case "windows": "Windows"
    default: os
    }
    return arch == "other" ? name : "\(name) · \(arch)"
  }
}

/// Feature flags a server advertises. Kept as raw JSON so new flags pass through.
public struct EnvironmentCapabilities: Codable, Hashable, Sendable {
  public var values: [String: JSONValue]

  public init(_ values: [String: JSONValue] = [:]) { self.values = values }

  public init(from decoder: Decoder) throws {
    let c = try decoder.singleValueContainer()
    values = (try? c.decode([String: JSONValue].self)) ?? [:]
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.singleValueContainer()
    try c.encode(values)
  }

  /// True when the server reports the flag as `true`.
  public func has(_ name: String) -> Bool { values[name]?.boolValue == true }

  public subscript(name: String) -> JSONValue? { values[name] }

  public var serverResolvedCommandContext: Bool { has("serverResolvedCommandContext") }
  public var threadPinning: Bool { has("threadPinning") }
  public var threadSettlement: Bool { has("threadSettlement") }
  public var threadVisitedTracking: Bool { has("threadVisitedTracking") }
  public var attachmentUploads: Bool { has("attachmentUploads") }
  public var maxUploadBytes: Int? { values["fileAttachments"]?["maxUploadBytes"]?.intValue }
}

/// An address the server listens on, so a client connected one way can learn others.
public struct DirectEndpoint: Codable, Hashable, Sendable {
  public var kind: DirectEndpointKind
  public var httpBaseUrl: String

  public init(kind: DirectEndpointKind, httpBaseUrl: String) {
    self.kind = kind
    self.httpBaseUrl = httpBaseUrl
  }
}

/// `server.getConfig`: the subset the app reads.
public struct ServerConfig: Codable, Hashable, Sendable {
  public var environment: EnvironmentDescriptor
  public var directEndpoints: [DirectEndpoint]
  public var settings: ServerSettings?
  public var providers: [ServerProviderSummary]
  public var shellResumeCompletionMarker: Bool?
  public var threadResumeCompletionMarker: Bool?
  public var threadSnapshotPagination: Bool?
  public var newProjectsRoot: String?
  public var scratchWorkspaceRoot: String?

  public init(environment: EnvironmentDescriptor, directEndpoints: [DirectEndpoint] = [], settings: ServerSettings? = nil, providers: [ServerProviderSummary] = [], shellResumeCompletionMarker: Bool? = nil, threadResumeCompletionMarker: Bool? = nil, threadSnapshotPagination: Bool? = nil, newProjectsRoot: String? = nil, scratchWorkspaceRoot: String? = nil) {
    self.environment = environment
    self.directEndpoints = directEndpoints
    self.settings = settings
    self.providers = providers
    self.shellResumeCompletionMarker = shellResumeCompletionMarker
    self.threadResumeCompletionMarker = threadResumeCompletionMarker
    self.threadSnapshotPagination = threadSnapshotPagination
    self.newProjectsRoot = newProjectsRoot
    self.scratchWorkspaceRoot = scratchWorkspaceRoot
  }

  enum CodingKeys: String, CodingKey {
    case environment, directEndpoints, settings, providers, shellResumeCompletionMarker, threadResumeCompletionMarker
    case threadSnapshotPagination, newProjectsRoot, scratchWorkspaceRoot
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    environment = try c.decode(EnvironmentDescriptor.self, forKey: .environment)
    directEndpoints = try c.decodeLossyArray(DirectEndpoint.self, forKey: .directEndpoints)
    settings = try c.decodeIfPresent(ServerSettings.self, forKey: .settings)
    providers = try c.decodeLossyArray(ServerProviderSummary.self, forKey: .providers)
    shellResumeCompletionMarker = try c.decodeIfPresent(Bool.self, forKey: .shellResumeCompletionMarker)
    threadResumeCompletionMarker = try c.decodeIfPresent(Bool.self, forKey: .threadResumeCompletionMarker)
    threadSnapshotPagination = try c.decodeIfPresent(Bool.self, forKey: .threadSnapshotPagination)
    newProjectsRoot = try c.decodeIfPresent(String.self, forKey: .newProjectsRoot)
    scratchWorkspaceRoot = try c.decodeIfPresent(String.self, forKey: .scratchWorkspaceRoot)
  }

  /// The provider snapshot for a model selection's instance.
  public func provider(_ instanceId: String) -> ServerProviderSummary? {
    providers.first { $0.instanceId == instanceId }
  }
}

/// A configured provider instance and its models, from `ServerConfig.providers`.
public struct ServerProviderSummary: Codable, Hashable, Sendable, Identifiable {
  public var id: String { instanceId }
  public var instanceId: String
  public var driver: String
  public var displayName: String?
  public var enabled: Bool
  public var installed: Bool
  /// e.g. `ready`, `error`, `disabled`.
  public var status: String
  public var message: String?
  public var models: [ServerProviderModel]

  public init(instanceId: String, driver: String, displayName: String? = nil, enabled: Bool = true, installed: Bool = true, status: String = "ready", message: String? = nil, models: [ServerProviderModel] = []) {
    self.instanceId = instanceId
    self.driver = driver
    self.displayName = displayName
    self.enabled = enabled
    self.installed = installed
    self.status = status
    self.message = message
    self.models = models
  }

  enum CodingKeys: String, CodingKey { case instanceId, driver, displayName, enabled, installed, status, message, models }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    instanceId = try c.decode(String.self, forKey: .instanceId)
    driver = try c.decodeIfPresent(String.self, forKey: .driver) ?? instanceId
    displayName = try c.decodeIfPresent(String.self, forKey: .displayName)
    enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? false
    installed = try c.decodeIfPresent(Bool.self, forKey: .installed) ?? false
    status = try c.decodeIfPresent(String.self, forKey: .status) ?? "unknown"
    message = try c.decodeIfPresent(String.self, forKey: .message)
    models = try c.decodeLossyArray(ServerProviderModel.self, forKey: .models)
  }

  /// The display name of a model slug, falling back to the slug.
  public func modelName(_ slug: String) -> String {
    models.first { $0.slug == slug || ($0.aliases ?? []).contains(slug) }?.name ?? slug
  }
}

public struct ServerProviderModel: Codable, Hashable, Sendable {
  public var slug: String
  public var name: String
  public var aliases: [String]?
  public var badge: String?
  public var isCustom: Bool?

  public init(slug: String, name: String, aliases: [String]? = nil, badge: String? = nil, isCustom: Bool? = nil) {
    self.slug = slug
    self.name = name
    self.aliases = aliases
    self.badge = badge
    self.isCustom = isCustom
  }
}

/// Items of the `subscribeServerConfig` stream. Only the snapshot and settings
/// updates are modelled.
public enum ServerConfigStreamItem: Decodable, Sendable, Hashable {
  case snapshot(ServerConfig)
  /// The server's settings after any change, such as a machine rename.
  case settingsUpdated(ServerSettings)
  /// Any other update, such as `usageLimitSourcesUpdated`.
  case other(type: String, raw: JSONValue)

  enum CodingKeys: String, CodingKey { case type, config, payload }
  enum PayloadKeys: String, CodingKey { case settings }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    let type = try c.decodeIfPresent(String.self, forKey: .type) ?? ""
    switch type {
    case "snapshot":
      self = .snapshot(try c.decode(ServerConfig.self, forKey: .config))
    case "settingsUpdated":
      let payload = try c.nestedContainer(keyedBy: PayloadKeys.self, forKey: .payload)
      self = .settingsUpdated(try payload.decode(ServerSettings.self, forKey: .settings))
    default:
      self = .other(type: type, raw: try JSONValue(from: decoder))
    }
  }
}
