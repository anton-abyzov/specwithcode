import Foundation
import SWCWire

/// How agents write their replies in a project's chats: the desktop's
/// Replies setting (`responseStyle`). It never hides rows; the Show level does.
public typealias ReplyStyle = ResponseStyle

extension ResponseStyle: Identifiable {
  public var id: String { rawValue }

  public var label: String {
    switch self {
    case .concise: "Concise"
    case .detailed: "Detailed"
    }
  }
}

/// One machine's reply settings, as the phone last read them.
public struct MachineReplyStyles: Hashable, Sendable {
  static let offlineReason = "The machine is offline."
  /// The machine's own value; nil when its server predates the setting.
  public var machine: ReplyStyle?
  /// Projects with their own value, by project id.
  public var projects: [String: ReplyStyle]
  /// The phone may change a project's value on this machine.
  public var canChange: Bool
  /// Why it cannot, when it cannot.
  public var readOnlyReason: String?

  public init(machine: ReplyStyle?, projects: [String: ReplyStyle] = [:], canChange: Bool, readOnlyReason: String? = nil) {
    self.machine = machine
    self.projects = projects
    self.canChange = canChange
    self.readOnlyReason = canChange ? nil : readOnlyReason
  }

  /// Why a paired phone without permission to make changes cannot change it.
  public static let notOperableReason = "This computer was paired without permission to make changes."
  /// Why a server without per-key project edits cannot take the change.
  public static let updateNeededReason = "Update SpecWithCode on this computer to change replies from the phone."

  /// Reads the machine's settings. A project change goes through
  /// `projectSettingsOverrideChanges`, which only a server reporting that
  /// capability saves, and only when the phone may operate the machine.
  public static func read(_ settings: ServerSettings, canOperate: Bool, perKeyProjectChanges: Bool) -> MachineReplyStyles {
    let projects = settings.projectSettingsOverrides.compactMapValues { $0.responseStyle }
    let reason: String? = !canOperate ? notOperableReason : (perKeyProjectChanges ? nil : updateNeededReason)
    return MachineReplyStyles(
      machine: settings.responseStyle,
      projects: projects,
      canChange: canOperate && perKeyProjectChanges,
      readOnlyReason: reason
    )
  }

  /// What a project's chats use: its own value, else the machine's. Nil when
  /// neither is known, so the chat shows nothing rather than a guess.
  public func state(forProject projectId: String) -> ReplyStyleState? {
    if let own = projects[projectId] {
      return ReplyStyleState(style: own, isProjectOverride: true, canChange: canChange, readOnlyReason: readOnlyReason)
    }
    guard let machine else { return nil }
    return ReplyStyleState(style: machine, isProjectOverride: false, canChange: canChange, readOnlyReason: readOnlyReason)
  }

  /// The patch that gives a project its own value, touching no other key.
  public static func patch(_ style: ReplyStyle, forProject projectId: String) -> ServerSettingsPatch {
    ServerSettingsPatch(projectSettingsOverrideChanges: [
      projectId: ProjectSettingsOverrideChange(set: ProjectSettingsOverrides(responseStyle: style)),
    ])
  }
}

/// The reply style a project's chat shows in its menu.
public struct ReplyStyleState: Hashable, Sendable {
  public var style: ReplyStyle
  /// The project has its own value; otherwise it follows the machine.
  public var isProjectOverride: Bool
  public var canChange: Bool
  public var readOnlyReason: String?

  public init(style: ReplyStyle, isProjectOverride: Bool, canChange: Bool, readOnlyReason: String? = nil) {
    self.style = style
    self.isProjectOverride = isProjectOverride
    self.canChange = canChange
    self.readOnlyReason = readOnlyReason
  }
}
