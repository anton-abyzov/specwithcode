import Foundation

/// `server.getSettings` (and `ServerConfig.settings`): the subset the app reads.
/// The server sends about 70 keys; the rest are ignored.
public struct ServerSettings: Codable, Hashable, Sendable {
  public var defaultRuntimeMode: RuntimeMode?
  public var defaultModelSelection: ModelSelection?
  public var textGenerationModelSelection: ModelSelection?
  public var sidebarProjectOrder: SidebarProjectOrder?
  /// Configured provider instances by instance id.
  public var providerInstances: [String: ProviderInstanceInfo]
  public var defaultThreadEnvMode: ThreadEnvMode?
  public var environmentIcon: String?

  public init(defaultRuntimeMode: RuntimeMode? = nil, defaultModelSelection: ModelSelection? = nil, textGenerationModelSelection: ModelSelection? = nil, sidebarProjectOrder: SidebarProjectOrder? = nil, providerInstances: [String: ProviderInstanceInfo] = [:], defaultThreadEnvMode: ThreadEnvMode? = nil, environmentIcon: String? = nil) {
    self.defaultRuntimeMode = defaultRuntimeMode
    self.defaultModelSelection = defaultModelSelection
    self.textGenerationModelSelection = textGenerationModelSelection
    self.sidebarProjectOrder = sidebarProjectOrder
    self.providerInstances = providerInstances
    self.defaultThreadEnvMode = defaultThreadEnvMode
    self.environmentIcon = environmentIcon
  }

  enum CodingKeys: String, CodingKey {
    case defaultRuntimeMode, defaultModelSelection, textGenerationModelSelection, sidebarProjectOrder
    case providerInstances, defaultThreadEnvMode, environmentIcon
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    defaultRuntimeMode = try c.decodeIfPresent(RuntimeMode.self, forKey: .defaultRuntimeMode)
    defaultModelSelection = try? c.decodeIfPresent(ModelSelection.self, forKey: .defaultModelSelection)
    textGenerationModelSelection = try? c.decodeIfPresent(ModelSelection.self, forKey: .textGenerationModelSelection)
    sidebarProjectOrder = try? c.decodeIfPresent(SidebarProjectOrder.self, forKey: .sidebarProjectOrder)
    providerInstances = Self.decodeInstances(c)
    defaultThreadEnvMode = try c.decodeIfPresent(ThreadEnvMode.self, forKey: .defaultThreadEnvMode)
    environmentIcon = try? c.decodeIfPresent(String.self, forKey: .environmentIcon)
  }

  private static func decodeInstances(_ c: KeyedDecodingContainer<CodingKeys>) -> [String: ProviderInstanceInfo] {
    guard let raw = try? c.decodeIfPresent([String: JSONValue].self, forKey: .providerInstances) else { return [:] }
    var result: [String: ProviderInstanceInfo] = [:]
    for (id, value) in raw {
      if let info = try? value.decode(ProviderInstanceInfo.self) { result[id] = info }
    }
    return result
  }
}

/// The user's order of the projects list on one host: pinned first, then the rest.
public struct SidebarProjectOrder: Codable, Hashable, Sendable {
  public var pinned: [String]
  public var unpinned: [String]
  /// The `environmentId:projectId` members of each pinned project.
  public var pinnedMembers: [String: [String]]?

  public init(pinned: [String] = [], unpinned: [String] = [], pinnedMembers: [String: [String]]? = nil) {
    self.pinned = pinned
    self.unpinned = unpinned
    self.pinnedMembers = pinnedMembers
  }

  enum CodingKeys: String, CodingKey { case pinned, unpinned, pinnedMembers }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    pinned = try c.decodeArray(String.self, forKey: .pinned)
    unpinned = try c.decodeArray(String.self, forKey: .unpinned)
    pinnedMembers = try c.decodeIfPresent([String: [String]].self, forKey: .pinnedMembers)
  }
}

/// One entry of `ServerSettings.providerInstances`: its name and whether it is on.
public struct ProviderInstanceInfo: Codable, Hashable, Sendable {
  public var driver: String
  public var displayName: String?
  public var enabled: Bool?

  public init(driver: String, displayName: String? = nil, enabled: Bool? = nil) {
    self.driver = driver
    self.displayName = displayName
    self.enabled = enabled
  }
}

/// `server.updateSettings` patch. Every key is optional; omitted keys stay unchanged.
public struct ServerSettingsPatch: Codable, Hashable, Sendable {
  public var defaultRuntimeMode: RuntimeMode?
  /// `.null` clears the default model.
  public var defaultModelSelection: Nullable<ModelSelection>?
  /// Replaces the whole order; send both lists.
  public var sidebarProjectOrder: SidebarProjectOrder?

  public init(defaultRuntimeMode: RuntimeMode? = nil, defaultModelSelection: Nullable<ModelSelection>? = nil, sidebarProjectOrder: SidebarProjectOrder? = nil) {
    self.defaultRuntimeMode = defaultRuntimeMode
    self.defaultModelSelection = defaultModelSelection
    self.sidebarProjectOrder = sidebarProjectOrder
  }

  enum CodingKeys: String, CodingKey { case defaultRuntimeMode, defaultModelSelection, sidebarProjectOrder }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    defaultRuntimeMode = try c.decodeIfPresent(RuntimeMode.self, forKey: .defaultRuntimeMode)
    defaultModelSelection = try c.decodeNullable(ModelSelection.self, forKey: .defaultModelSelection)
    sidebarProjectOrder = try c.decodeIfPresent(SidebarProjectOrder.self, forKey: .sidebarProjectOrder)
  }

  public var isEmpty: Bool { defaultRuntimeMode == nil && defaultModelSelection == nil && sidebarProjectOrder == nil }
}

/// Payload of `server.updateSettings`.
public struct UpdateServerSettingsInput: Codable, Hashable, Sendable {
  public var patch: ServerSettingsPatch
  public init(patch: ServerSettingsPatch) { self.patch = patch }
}
