import SWCSync

/// The line under a chat's title that says what kind of chat it is, as the
/// desktop's coordinator pane and its "Threads ›" crumb do: a project's
/// coordinator, or a thread working in a project. Aide's chat keeps its own
/// subtitle.
struct ChatKindLine: Equatable {
  enum Kind: Equatable { case coordinator, thread }

  let kind: Kind
  let text: String
  /// What the header shows when `text` does not fit: the glyph already says
  /// thread, so the project name comes first.
  let shortText: String
  /// Read by VoiceOver when the line opens the project's coordinator; nil
  /// when there is no coordinator to go back to.
  let coordinatorHint: String?

  /// A hub of connected nodes: the chat that hands out the work.
  static let coordinatorSymbol = "point.3.filled.connected.trianglepath.dotted"
  /// A speech bubble with lines: one conversation doing one piece of work.
  static let threadSymbol = "text.bubble"

  var symbol: String { kind == .coordinator ? Self.coordinatorSymbol : Self.threadSymbol }

  init(kind: Kind, text: String, shortText: String? = nil, coordinatorHint: String?) {
    self.kind = kind
    self.text = text
    self.shortText = shortText ?? text
    self.coordinatorHint = coordinatorHint
  }

  /// The line for a chat. `machine` is the machine's display name: a
  /// coordinator names it, since the title already names the project, and so
  /// does a thread in a personal project, whose copies are told apart by
  /// machine. `projectTitle` is the session's own record of a thread's
  /// project, for a subagent's child or an archived thread that no project
  /// list holds. `coordinator` is where the line goes back to, if anywhere.
  static func make(
    for target: ChatTarget,
    machine: String,
    projectTitle sessionProjectTitle: String? = nil,
    coordinator: ChatTarget? = nil,
    in model: AppModel
  ) -> ChatKindLine? {
    switch target {
    case .aide:
      return nil
    case .project:
      return ChatKindLine(kind: .coordinator, text: joined("Coordinator", machine), coordinatorHint: nil)
    case let .thread(ref):
      let summary = model.thread(ref)
      let project = summary?.projectRef.flatMap { model.project($0) } ?? coordinator.flatMap(projectRef).flatMap { model.project($0) }
      let title = [project?.title, summary?.projectTitle, sessionProjectTitle]
        .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
        .first { !$0.isEmpty }
      guard let title else {
        return ChatKindLine(kind: .thread, text: "Thread", coordinatorHint: nil)
      }
      let hint: String? = coordinator.map {
        if case .aide = $0 { return "Opens \(title)" }
        return "Opens the \(title) coordinator"
      }
      let personal = project?.kind == .personal
      return ChatKindLine(
        kind: .thread,
        text: personal ? joined("Thread in \(title)", machine) : "Thread in \(title)",
        shortText: personal ? joined("In \(title)", machine) : "In \(title)",
        coordinatorHint: hint
      )
    }
  }

  private static func projectRef(_ target: ChatTarget) -> ProjectRef? {
    switch target {
    case let .aide(ref), let .project(ref): ref
    case .thread: nil
    }
  }

  private static func joined(_ text: String, _ machine: String) -> String {
    machine.isEmpty ? text : "\(text) · \(machine)"
  }
}

extension ChatKindLine {
  /// Only a worker thread shows its SpecWeave increment, as on the desktop,
  /// whose coordinator pane has no plan card. A coordinator that ran
  /// `specweave` itself is bound to whatever it touched last, which is not
  /// its own work.
  static func showsIncrement(_ target: ChatTarget) -> Bool {
    guard case let .thread(ref) = target else { return false }
    return !ref.threadId.hasPrefix("project-coordinator:")
  }
}
