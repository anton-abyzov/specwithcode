import SWCWire

/// A machine's Team rules as screens read them. Nil on a machine with no rules.
public struct TeamRulesInfo: Hashable, Sendable {
  public struct Row: Hashable, Sendable, Identifiable {
    public var id: String { title }
    public let title: String
    public let value: String
    public init(title: String, value: String) {
      self.title = title
      self.value = value
    }
  }

  /// A broken rules file: agents are paused until it is fixed.
  public var isHold: Bool
  public var owner: String?
  public var contact: String?
  public var ceiling: RuntimeModeChoice?
  public var issues: [String]
  /// What the rules limit, each only when they do.
  public var rows: [Row]

  public init(_ summary: TeamRulesSummary) {
    isHold = summary.status == "hold"
    owner = summary.owner
    contact = summary.contact
    // A hold names no limits: the broken file cannot be trusted either way.
    ceiling = isHold ? nil : summary.ceiling.flatMap { RuntimeModeChoice(rawValue: $0.rawValue) }
    issues = summary.issues ?? []
    rows = isHold ? [] : Self.rows(summary)
  }

  /// The label a locked control shows.
  public var setByLabel: String { Self.setByLabel(owner) }

  public static func setByLabel(_ owner: String?) -> String {
    guard let owner, !owner.isEmpty else { return "Set by your team" }
    return "Set by \(owner)"
  }

  /// Full access as a ceiling limits nothing, so it locks nothing.
  public var limitsModes: Bool { ceiling != nil && ceiling != .fullAccess }

  /// The modes a picker may offer, narrowest first.
  public var allowedModes: [RuntimeModeChoice] {
    guard let ceiling else { return RuntimeModeChoice.allCases }
    return RuntimeModeChoice.allCases.filter { $0.rank <= ceiling.rank }
  }

  /// The broadest allowed mode no wider than `mode`.
  public func clamped(_ mode: RuntimeModeChoice) -> RuntimeModeChoice {
    guard let ceiling, mode.rank > ceiling.rank else { return mode }
    return ceiling
  }

  private static func rows(_ summary: TeamRulesSummary) -> [Row] {
    var rows: [Row] = []
    func add(_ title: String, _ value: String?) {
      if let value { rows.append(Row(title: title, value: value)) }
    }
    func listed(_ values: [String]?) -> String? {
      values.map { $0.isEmpty ? "None" : $0.joined(separator: ", ") }
    }
    func off(_ value: Bool?) -> String? { value == false ? "Off" : nil }
    func mode(_ value: RuntimeMode?) -> String? {
      value.map { RuntimeModeChoice(rawValue: $0.rawValue)?.label ?? $0.rawValue }
    }
    add("Broadest permission", mode(summary.ceiling))
    add("Routines", mode(summary.routinesCeiling))
    add("Approved providers", listed(summary.providers))
    add("Approved models", listed(summary.models))
    if summary.ownsProviderLaunch == true || !(summary.pinnedProviders ?? []).isEmpty {
      add("Provider launch", "Set by the rules")
    }
    add("Telemetry export", off(summary.telemetryExport))
    add("Phones", off(summary.reach?.phones))
    add("SpecWithCode Connect", off(summary.reach?.connect))
    switch summary.reach?.machines {
    case "none": add("Other machines", "Off")
    case "same-rules": add("Other machines", "Same rules only")
    default: break
    }
    add("Webhooks", off(summary.reach?.webhooks))
    add("Agent use of Chrome", off(summary.tools?.chrome))
    add("Agent use of this computer", off(summary.tools?.computerUse))
    add("Google accounts", off(summary.tools?.google))
    add("Telegram", off(summary.tools?.telegram))
    return rows
  }
}

/// What a chat says when Team rules stop it: paused by a broken file, or running
/// above a limit, with the way down when the phone can take it.
public struct ChatTeamRulesNotice: Hashable, Sendable {
  public let title: String
  public let message: String
  /// The thread to lower and the mode to lower it to.
  public let thread: ThreadRef?
  public let switchTo: RuntimeModeChoice?

  public init(title: String, message: String, thread: ThreadRef? = nil, switchTo: RuntimeModeChoice? = nil) {
    self.title = title
    self.message = message
    self.thread = thread
    self.switchTo = switchTo
  }

  public var switchTitle: String? { switchTo.map { "Switch to \($0.label)" } }

  /// Nothing with no rules and no carried ceiling, so such a chat looks as it always did.
  public static func make(rules: TeamRulesInfo?, carried: TeamRulesCarried?, mode: RuntimeModeChoice?, thread: ThreadRef?) -> ChatTeamRulesNotice? {
    if let rules, rules.isHold {
      let contact = rules.contact.map { " See \($0)." } ?? ""
      return ChatTeamRulesNotice(
        title: "Agents are paused by your team's rules",
        message: "\(rules.issues.first ?? "The team rules file has an error.") Fixing the file resumes agents without a restart.\(contact)"
      )
    }
    guard let mode else { return nil }
    let brought = carried.flatMap { RuntimeModeChoice(rawValue: $0.ceiling.rawValue) }
    let limit = [rules?.ceiling, brought].compactMap(\.self).min { $0.rank < $1.rank }
    guard let limit, mode.rank > limit.rank else { return nil }
    let setBy: String
    if let carried, brought == limit, rules?.ceiling != limit {
      setBy = "\(TeamRulesInfo.setByLabel(carried.owner)), on the machine this work came from"
    } else {
      setBy = rules?.setByLabel ?? TeamRulesInfo.setByLabel(carried?.owner)
    }
    return ChatTeamRulesNotice(
      title: "Above your team's limit",
      message: "\(setBy). This thread uses \(mode.label).",
      thread: thread,
      switchTo: thread == nil ? nil : limit
    )
  }
}

extension RuntimeModeChoice {
  /// Narrowest first, the order `allCases` declares.
  public var rank: Int { Self.allCases.firstIndex(of: self) ?? 0 }
}
