import Foundation

/// `TeamRulesSummary`: the limits a company set on a machine, as clients read
/// them. Absent with no rules and on servers that predate them. Every field is
/// read on its own, so one a newer server changed costs only that field.
public struct TeamRulesSummary: Codable, Hashable, Sendable {
  public struct Reach: Codable, Hashable, Sendable {
    public var phones: Bool?
    public var connect: Bool?
    /// `any`, `same-rules` or `none`.
    public var machines: String?
    public var webhooks: Bool?

    public init(phones: Bool? = nil, connect: Bool? = nil, machines: String? = nil, webhooks: Bool? = nil) {
      self.phones = phones
      self.connect = connect
      self.machines = machines
      self.webhooks = webhooks
    }

    enum CodingKeys: String, CodingKey { case phones, connect, machines, webhooks }

    public init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      phones = c.lenient(Bool.self, .phones)
      connect = c.lenient(Bool.self, .connect)
      machines = c.lenient(String.self, .machines)
      webhooks = c.lenient(Bool.self, .webhooks)
    }
  }

  public struct Tools: Codable, Hashable, Sendable {
    public var chrome: Bool?
    public var computerUse: Bool?
    public var google: Bool?
    public var telegram: Bool?

    public init(chrome: Bool? = nil, computerUse: Bool? = nil, google: Bool? = nil, telegram: Bool? = nil) {
      self.chrome = chrome
      self.computerUse = computerUse
      self.google = google
      self.telegram = telegram
    }

    enum CodingKeys: String, CodingKey { case chrome, computerUse, google, telegram }

    public init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      chrome = c.lenient(Bool.self, .chrome)
      computerUse = c.lenient(Bool.self, .computerUse)
      google = c.lenient(Bool.self, .google)
      telegram = c.lenient(Bool.self, .telegram)
    }
  }

  /// `active` or `hold`, when a broken rules file pauses agents.
  public var status: String
  public var owner: String?
  public var contact: String?
  public var fingerprint: String?
  public var ceiling: RuntimeMode?
  public var routinesCeiling: RuntimeMode?
  public var providers: [String]?
  public var models: [String]?
  public var pinnedProviders: [String]?
  public var ownsProviderLaunch: Bool?
  public var telemetryExport: Bool?
  public var reach: Reach?
  public var tools: Tools?
  /// Why the rules are on hold.
  public var issues: [String]?

  public init(status: String = "active", owner: String? = nil, contact: String? = nil, fingerprint: String? = nil, ceiling: RuntimeMode? = nil, routinesCeiling: RuntimeMode? = nil, providers: [String]? = nil, models: [String]? = nil, pinnedProviders: [String]? = nil, ownsProviderLaunch: Bool? = nil, telemetryExport: Bool? = nil, reach: Reach? = nil, tools: Tools? = nil, issues: [String]? = nil) {
    self.status = status
    self.owner = owner
    self.contact = contact
    self.fingerprint = fingerprint
    self.ceiling = ceiling
    self.routinesCeiling = routinesCeiling
    self.providers = providers
    self.models = models
    self.pinnedProviders = pinnedProviders
    self.ownsProviderLaunch = ownsProviderLaunch
    self.telemetryExport = telemetryExport
    self.reach = reach
    self.tools = tools
    self.issues = issues
  }

  enum CodingKeys: String, CodingKey {
    case status, owner, contact, fingerprint, ceiling, routinesCeiling, providers, models, pinnedProviders
    case ownsProviderLaunch, telemetryExport, reach, tools, issues
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    status = try c.decode(String.self, forKey: .status)
    owner = c.lenient(String.self, .owner)
    contact = c.lenient(String.self, .contact)
    fingerprint = c.lenient(String.self, .fingerprint)
    ceiling = c.lenient(RuntimeMode.self, .ceiling)
    routinesCeiling = c.lenient(RuntimeMode.self, .routinesCeiling)
    providers = c.lenient([String].self, .providers)
    models = c.lenient([String].self, .models)
    pinnedProviders = c.lenient([String].self, .pinnedProviders)
    ownsProviderLaunch = c.lenient(Bool.self, .ownsProviderLaunch)
    telemetryExport = c.lenient(Bool.self, .telemetryExport)
    reach = c.lenient(Reach.self, .reach)
    tools = c.lenient(Tools.self, .tools)
    issues = c.lenient([String].self, .issues)
  }
}

/// The ceiling a thread brought from another machine, from `origin.carried`.
public struct TeamRulesCarried: Codable, Hashable, Sendable {
  public var ceiling: RuntimeMode
  public var owner: String
  public var contact: String?
  public var from: String?

  public init(ceiling: RuntimeMode, owner: String, contact: String? = nil, from: String? = nil) {
    self.ceiling = ceiling
    self.owner = owner
    self.contact = contact
    self.from = from
  }
}

/// `OrchestrationV2ThreadOrigin`: only the part the app reads.
public struct ThreadOriginSummary: Codable, Hashable, Sendable {
  public var carried: TeamRulesCarried?

  public init(carried: TeamRulesCarried? = nil) { self.carried = carried }

  enum CodingKeys: String, CodingKey { case carried }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    carried = c.lenient(TeamRulesCarried.self, .carried)
  }
}

private extension KeyedDecodingContainer {
  /// A missing, null or malformed value reads as absent.
  func lenient<T: Decodable>(_ type: T.Type, _ key: Key) -> T? {
    (try? decodeIfPresent(type, forKey: key)) ?? nil
  }
}
