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
  /// The user's short names for every machine in the fleet, by environment id.
  /// Older servers omit it.
  public var machineNicknames: [String: MachineNicknameEntry]
  /// Whether Percy, the personal assistant, is shown. Off by default; older
  /// servers omit it, so Percy stays hidden there.
  public var aideEnabled: Bool
  /// Suggested prompts: "all", "native" (the provider's own only) or "off".
  /// Older servers omit it and show every suggestion they record.
  public var promptSuggestions: String
  /// How agents on this machine write their replies. Nil from a server that
  /// predates the setting or sent a value this app does not know.
  public var responseStyle: ResponseStyle?
  /// Per-project overrides of project-scoped settings, by project id. Only
  /// the keys the app reads are kept.
  public var projectSettingsOverrides: [String: ProjectSettingsOverrides]

  public init(defaultRuntimeMode: RuntimeMode? = nil, defaultModelSelection: ModelSelection? = nil, textGenerationModelSelection: ModelSelection? = nil, sidebarProjectOrder: SidebarProjectOrder? = nil, providerInstances: [String: ProviderInstanceInfo] = [:], defaultThreadEnvMode: ThreadEnvMode? = nil, environmentIcon: String? = nil, machineNicknames: [String: MachineNicknameEntry] = [:], aideEnabled: Bool = false, promptSuggestions: String = "all", responseStyle: ResponseStyle? = nil, projectSettingsOverrides: [String: ProjectSettingsOverrides] = [:]) {
    self.defaultRuntimeMode = defaultRuntimeMode
    self.defaultModelSelection = defaultModelSelection
    self.textGenerationModelSelection = textGenerationModelSelection
    self.sidebarProjectOrder = sidebarProjectOrder
    self.providerInstances = providerInstances
    self.defaultThreadEnvMode = defaultThreadEnvMode
    self.environmentIcon = environmentIcon
    self.machineNicknames = machineNicknames
    self.aideEnabled = aideEnabled
    self.promptSuggestions = promptSuggestions
    self.responseStyle = responseStyle
    self.projectSettingsOverrides = projectSettingsOverrides
  }

  enum CodingKeys: String, CodingKey {
    case defaultRuntimeMode, defaultModelSelection, textGenerationModelSelection, sidebarProjectOrder
    case providerInstances, defaultThreadEnvMode, environmentIcon, machineNicknames, aideEnabled
    case promptSuggestions, responseStyle, projectSettingsOverrides
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
    machineNicknames = Self.decodeNicknames(c)
    aideEnabled = (try? c.decodeIfPresent(Bool.self, forKey: .aideEnabled)) ?? false
    promptSuggestions = (try? c.decodeIfPresent(String.self, forKey: .promptSuggestions)) ?? "all"
    responseStyle = try? c.decodeIfPresent(ResponseStyle.self, forKey: .responseStyle)
    projectSettingsOverrides = Self.decodeOverrides(c)
  }

  /// Drops a malformed project entry rather than failing the whole snapshot.
  private static func decodeOverrides(_ c: KeyedDecodingContainer<CodingKeys>) -> [String: ProjectSettingsOverrides] {
    guard let raw = try? c.decodeIfPresent([String: JSONValue].self, forKey: .projectSettingsOverrides) else { return [:] }
    return raw.compactMapValues { try? $0.decode(ProjectSettingsOverrides.self) }
  }

  /// Drops a malformed entry rather than failing the whole settings snapshot.
  private static func decodeNicknames(_ c: KeyedDecodingContainer<CodingKeys>) -> [String: MachineNicknameEntry] {
    guard let raw = try? c.decodeIfPresent([String: JSONValue].self, forKey: .machineNicknames) else { return [:] }
    return raw.compactMapValues { try? $0.decode(MachineNicknameEntry.self) }
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

/// How agents write their replies: `responseStyle` in the server's settings.
public enum ResponseStyle: String, Codable, CaseIterable, Hashable, Sendable {
  case concise
  case detailed
}

/// One project's overrides in `ServerSettings.projectSettingsOverrides`. An
/// absent key follows the machine's value. The server holds about 50 keys;
/// the app reads only these.
public struct ProjectSettingsOverrides: Codable, Hashable, Sendable {
  public var responseStyle: ResponseStyle?

  public init(responseStyle: ResponseStyle? = nil) { self.responseStyle = responseStyle }

  enum CodingKeys: String, CodingKey { case responseStyle }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    responseStyle = try? c.decodeIfPresent(ResponseStyle.self, forKey: .responseStyle)
  }
}

/// One project's per-key edit in `ServerSettingsPatch.projectSettingsOverrideChanges`:
/// `set` writes these keys, `clear` removes the named keys so they follow the
/// machine again. Other keys of the project stay as they are.
public struct ProjectSettingsOverrideChange: Codable, Hashable, Sendable {
  public var set: ProjectSettingsOverrides?
  public var clear: [String]?

  public init(set: ProjectSettingsOverrides? = nil, clear: [String]? = nil) {
    self.set = set
    self.clear = clear
  }
}

/// One entry of `ServerSettings.machineNicknames`. An empty name means the
/// machine's default short name; its stamp still lets a reset beat an older rename.
public struct MachineNicknameEntry: Codable, Hashable, Sendable {
  public var name: String
  /// ISO 8601; the newest entry wins when machines disagree.
  public var updatedAt: String

  public init(name: String, updatedAt: String) {
    self.name = name
    self.updatedAt = updatedAt
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
  /// Per-key project override edits by project id. Send only to a server whose
  /// capabilities report `projectSettingsOverrideChanges`: older servers drop
  /// the key without saving anything.
  public var projectSettingsOverrideChanges: [String: ProjectSettingsOverrideChange]?

  public init(defaultRuntimeMode: RuntimeMode? = nil, defaultModelSelection: Nullable<ModelSelection>? = nil, sidebarProjectOrder: SidebarProjectOrder? = nil, projectSettingsOverrideChanges: [String: ProjectSettingsOverrideChange]? = nil) {
    self.defaultRuntimeMode = defaultRuntimeMode
    self.defaultModelSelection = defaultModelSelection
    self.sidebarProjectOrder = sidebarProjectOrder
    self.projectSettingsOverrideChanges = projectSettingsOverrideChanges
  }

  enum CodingKeys: String, CodingKey { case defaultRuntimeMode, defaultModelSelection, sidebarProjectOrder, projectSettingsOverrideChanges }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    defaultRuntimeMode = try c.decodeIfPresent(RuntimeMode.self, forKey: .defaultRuntimeMode)
    defaultModelSelection = try c.decodeNullable(ModelSelection.self, forKey: .defaultModelSelection)
    sidebarProjectOrder = try c.decodeIfPresent(SidebarProjectOrder.self, forKey: .sidebarProjectOrder)
    projectSettingsOverrideChanges = try c.decodeIfPresent([String: ProjectSettingsOverrideChange].self, forKey: .projectSettingsOverrideChanges)
  }

  public var isEmpty: Bool {
    defaultRuntimeMode == nil && defaultModelSelection == nil && sidebarProjectOrder == nil && projectSettingsOverrideChanges == nil
  }
}

/// Payload of `server.updateSettings`.
public struct UpdateServerSettingsInput: Codable, Hashable, Sendable {
  public var patch: ServerSettingsPatch
  public init(patch: ServerSettingsPatch) { self.patch = patch }
}
