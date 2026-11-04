import Foundation

// Access requests: an agent asks to use apps, devices, machines or folders.
// One answer covers every subject; an Allow carries how long it lasts.
// Mirrors `packages/contracts/src/accessRequest.ts`.

/// What an access request asks for.
public struct AccessRequestSubjectKind: OpenStringEnum {
  public enum Known: String, Sendable, CaseIterable {
    case app, device, machine, folder
  }
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }

  public static let app = Self(.app)
  public static let device = Self(.device)
  public static let machine = Self(.machine)
  public static let folder = Self(.folder)
}

/// Where an access request card stands.
public struct AccessRequestStatus: OpenStringEnum {
  public enum Known: String, Sendable, CaseIterable {
    case pending, allowed, denied, cancelled
  }
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }

  public static let pending = Self(.pending)
  public static let allowed = Self(.allowed)
  public static let denied = Self(.denied)
  public static let cancelled = Self(.cancelled)
}

/// How long an Allow lasts: this thread only, or every thread on this machine.
public enum AccessRequestScope: String, Codable, Hashable, Sendable, CaseIterable {
  case thread, machine
}

/// A small PNG of the subject's own icon, base64 encoded.
public struct AccessRequestIcon: Codable, Hashable, Sendable {
  public var mimeType: String
  public var data: String

  public init(mimeType: String = "image/png", data: String) {
    self.mimeType = mimeType
    self.data = data
  }

  /// The decoded PNG bytes, nil when the data is not valid base64.
  public var pngData: Data? { Data(base64Encoded: data, options: .ignoreUnknownCharacters) }
}

/// One thing the agent asks to use, with what it may do with it.
public struct AccessRequestSubject: Codable, Hashable, Sendable, Identifiable {
  public var id: String { key }
  public var kind: AccessRequestSubjectKind
  /// The grant this subject is recorded under, e.g. `app:activity monitor`.
  public var key: String
  /// Its name, e.g. "Activity Monitor" or "iPhone 17 Pro".
  public var label: String
  /// What the agent may do with it, e.g. "See and control its windows".
  public var detail: String
  /// The machine it is on, when that is worth saying, e.g. "M1".
  public var hostLabel: String?
  /// `ios` or `android`, for a device.
  public var platform: String?
  public var icon: AccessRequestIcon?

  public init(kind: AccessRequestSubjectKind, key: String, label: String, detail: String, hostLabel: String? = nil, platform: String? = nil, icon: AccessRequestIcon? = nil) {
    self.kind = kind
    self.key = key
    self.label = label
    self.detail = detail
    self.hostLabel = hostLabel
    self.platform = platform
    self.icon = icon
  }

  enum CodingKeys: String, CodingKey { case kind, key, label, detail, hostLabel, platform, icon }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    kind = try c.decode(AccessRequestSubjectKind.self, forKey: .kind)
    key = try c.decode(String.self, forKey: .key)
    label = try c.decode(String.self, forKey: .label)
    detail = try c.decodeIfPresent(String.self, forKey: .detail) ?? ""
    hostLabel = try c.decodeIfPresent(String.self, forKey: .hostLabel)
    platform = try c.decodeIfPresent(String.self, forKey: .platform)
    // A malformed icon falls back to the kind's glyph rather than failing the item.
    icon = try? c.decodeIfPresent(AccessRequestIcon.self, forKey: .icon)
  }
}

extension TurnItem {
  /// Access the agent asked for. Answer with `access.answerRequest`.
  public struct AccessRequest: Codable, Hashable, Sendable {
    /// What is asked, e.g. "Use System Settings and Activity Monitor".
    public var accessTitle: String
    public var reason: String
    public var subjects: [AccessRequestSubject]
    public var accessStatus: AccessRequestStatus
    /// Set once allowed.
    public var accessScope: AccessRequestScope?

    public init(accessTitle: String, reason: String, subjects: [AccessRequestSubject], accessStatus: AccessRequestStatus = .pending, accessScope: AccessRequestScope? = nil) {
      self.accessTitle = accessTitle
      self.reason = reason
      self.subjects = subjects
      self.accessStatus = accessStatus
      self.accessScope = accessScope
    }

    enum CodingKeys: String, CodingKey { case accessTitle, reason, subjects, accessStatus, accessScope }

    public init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      accessTitle = try c.decode(String.self, forKey: .accessTitle)
      reason = try c.decodeIfPresent(String.self, forKey: .reason) ?? ""
      subjects = try c.decode([AccessRequestSubject].self, forKey: .subjects)
      accessStatus = try c.decode(AccessRequestStatus.self, forKey: .accessStatus)
      // A scope this build does not know reads as none rather than failing the item.
      accessScope = try? c.decodeIfPresent(AccessRequestScope.self, forKey: .accessScope)
    }

    public var isPending: Bool { accessStatus == .pending }
  }
}

/// The user's answer to an access request card.
public enum AccessRequestAnswer: Codable, Hashable, Sendable {
  case allow(scope: AccessRequestScope)
  case deny

  enum CodingKeys: String, CodingKey { case type, scope }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    switch try c.decode(String.self, forKey: .type) {
    case "allow": self = .allow(scope: try c.decode(AccessRequestScope.self, forKey: .scope))
    case "deny": self = .deny
    case let other: throw DecodingError.dataCorruptedError(forKey: .type, in: c, debugDescription: "Unknown answer \(other)")
    }
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    switch self {
    case let .allow(scope):
      try c.encode("allow", forKey: .type)
      try c.encode(scope, forKey: .scope)
    case .deny:
      try c.encode("deny", forKey: .type)
    }
  }
}

/// `access.answerRequest` -> void.
public struct AccessAnswerRequestInput: Codable, Hashable, Sendable {
  public var threadId: String
  public var turnItemId: String
  public var answer: AccessRequestAnswer

  public init(threadId: String, turnItemId: String, answer: AccessRequestAnswer) {
    self.threadId = threadId
    self.turnItemId = turnItemId
    self.answer = answer
  }
}

/// User-facing text for `AccessRequestError.reason`. The server sends only the reason.
public enum AccessRequestErrorText {
  public static func message(for reason: String?) -> String {
    switch reason {
    case "load_failed": "Could not load the access request."
    case "not_found": "This access request no longer exists."
    case "already_answered": "This access request was already answered."
    case "agent_stopped": "The agent that asked has stopped, so there is nothing to allow."
    case "grant_failed": "Could not save the access."
    case "record_failed": "Saved the access, but could not update the request."
    default: "Could not answer the access request."
    }
  }
}

/// The words every client uses for an access request. A port of
/// `packages/client-runtime/src/accessRequest.ts`; keep the two in step.
public enum AccessRequestCopy {
  /// What the copy needs from a subject: its kind and its name.
  public struct SubjectName: Hashable, Sendable {
    public var kind: String
    public var label: String
    public init(kind: String, label: String) {
      self.kind = kind
      self.label = label
    }
  }

  static func joinNames(_ names: [String]) -> String {
    guard names.count > 1 else { return names.first ?? "" }
    return "\(names.dropLast().joined(separator: ", ")) and \(names[names.count - 1])"
  }

  /// "Claude wants to use SpecWithCode", "Codex wants to control iPhone 17 Pro".
  public static func headline(agentLabel: String?, subjects: [SubjectName]) -> String {
    let trimmed = agentLabel?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let agent = trimmed.isEmpty ? "The agent" : trimmed
    let used = subjects.filter { $0.kind != "device" }.map(\.label)
    let controlled = subjects.filter { $0.kind == "device" }.map(\.label)
    var parts: [String] = []
    if !used.isEmpty { parts.append("use \(joinNames(used))") }
    if !controlled.isEmpty { parts.append("control \(joinNames(controlled))") }
    let what = parts.isEmpty ? "use something on your computer" : parts.joined(separator: " and ")
    return "\(agent) wants to \(what)"
  }

  /// The scope tag on each subject chip: what the agent may do with it.
  public static func subjectTag(_ subject: SubjectName) -> String { "All" }

  /// The one plain line under the chips, saying what Allow lets the agent do.
  public static func note(_ subjects: [SubjectName]) -> String {
    let apps = subjects.contains { $0.kind == "app" }
    let devices = subjects.contains { $0.kind == "device" }
    if apps && devices {
      return "The agent can see your screen, click and type in these apps, and drive the device."
    }
    if devices { return "The agent can see the device's screen, tap, type and install apps on it." }
    if subjects.contains(where: { $0.kind == "folder" }) {
      return "The agent can read and change files in this folder."
    }
    if subjects.contains(where: { $0.kind == "machine" }) {
      return "The agent can run work on that machine."
    }
    return "The agent can see your screen and click and type in these apps while it works."
  }

  /// A waiting thread's subtitle in the thread lists.
  public static func waitingSubtitle(_ subjects: [SubjectName]) -> String {
    let kinds = Set(subjects.map(\.kind))
    if kinds == ["device"] {
      return subjects.count == 1 ? "Asking to control a device" : "Asking to control devices"
    }
    if kinds == ["folder"] { return "Asking to use a folder" }
    if kinds == ["machine"] { return "Asking to work on another machine" }
    return "Asking to use apps on your computer"
  }

  /// After a thread link: "is waiting for you to allow access to M4, so it can find …".
  public static func waitingSentence(machineLabel: String, reason: String) -> String {
    var purpose = reason.trimmingCharacters(in: .whitespacesAndNewlines)
    while let last = purpose.last, last == "." || last == "!" { purpose.removeLast() }
    if let range = purpose.range(of: #"^(?:to|in order to)\s+"#, options: [.regularExpression, .caseInsensitive]) {
      purpose.removeSubrange(range)
    }
    guard let first = purpose.first else {
      return "is waiting for you to allow access to \(machineLabel)."
    }
    return "is waiting for you to allow access to \(machineLabel), so it can \(first.lowercased())\(purpose.dropFirst())."
  }
}

extension AccessRequestSubject {
  public var copyName: AccessRequestCopy.SubjectName { .init(kind: kind.rawValue, label: label) }
}

/// What a thread's pending access request asks for, as the thread shell
/// carries it. Older servers leave it out.
public struct PendingAccessSummary: Codable, Hashable, Sendable {
  public struct Subject: Codable, Hashable, Sendable {
    public var kind: String
    public var label: String
    public var hostLabel: String?
    public init(kind: String, label: String, hostLabel: String? = nil) {
      self.kind = kind
      self.label = label
      self.hostLabel = hostLabel
    }
    public var copyName: AccessRequestCopy.SubjectName { .init(kind: kind, label: label) }
  }

  public var accessTitle: String
  public var reason: String
  public var subjects: [Subject]

  public init(accessTitle: String, reason: String, subjects: [Subject]) {
    self.accessTitle = accessTitle
    self.reason = reason
    self.subjects = subjects
  }

  enum CodingKeys: String, CodingKey { case accessTitle, reason, subjects }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    accessTitle = try c.decodeIfPresent(String.self, forKey: .accessTitle) ?? ""
    reason = try c.decodeIfPresent(String.self, forKey: .reason) ?? ""
    subjects = try c.decodeIfPresent([Subject].self, forKey: .subjects) ?? []
  }
}
