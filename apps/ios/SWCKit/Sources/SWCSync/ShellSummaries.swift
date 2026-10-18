import Foundation
import SWCWire

/// Turns machines' shells into the drawer and list models. Pure, so it is
/// tested without sockets.
public enum ShellSummaries {
  /// What one machine contributes.
  public struct Machine: Sendable {
    public var environmentId: String
    public var label: String
    public var online: Bool
    public var snapshot: ShellSnapshot?
    /// The machine's saved sidebar order, from its server settings.
    public var projectOrder: SidebarProjectOrder?
    /// Folder of the machine's scratch project ("No project"), from its server config.
    public var scratchWorkspaceRoot: String?

    public init(environmentId: String, label: String, online: Bool, snapshot: ShellSnapshot?, projectOrder: SidebarProjectOrder? = nil, scratchWorkspaceRoot: String? = nil) {
      self.environmentId = environmentId
      self.label = label
      self.online = online
      self.snapshot = snapshot
      self.projectOrder = projectOrder
      self.scratchWorkspaceRoot = scratchWorkspaceRoot
    }
  }

  public struct Output: Sendable, Hashable {
    public var aide: ProjectSummary?
    public var projects: [ProjectSummary]
    public var threadsByProject: [ProjectRef: [ThreadSummary]]
    public var recentThreads: [ThreadSummary]
  }

  public static let recentLimit = 30

  public static func build(_ machines: [Machine]) -> Output {
    let ordered = machines.sorted { $0.environmentId < $1.environmentId }
    let orders = ordered.compactMap(\.projectOrder)
    var aide: ProjectSummary?
    var archivedAide: ProjectSummary?
    var projects: [ProjectSummary] = []
    var threadsByProject: [ProjectRef: [ThreadSummary]] = [:]
    var all: [ThreadSummary] = []

    for machine in ordered {
      guard let snapshot = machine.snapshot else { continue }
      let coordinatorIds = Set(snapshot.projects.map(\.coordinatorThreadId))
      let titles = Dictionary(snapshot.projects.map { ($0.id, $0.displayTitle) }, uniquingKeysWith: { first, _ in first })

      var byProject: [String: [ThreadSummary]] = [:]
      for thread in snapshot.threads where isTopLevel(thread, coordinatorIds: coordinatorIds) {
        let summary = threadSummary(thread, environmentId: machine.environmentId, projectTitle: titles[thread.projectId], machineLabel: machine.label, machineOnline: machine.online)
        byProject[thread.projectId, default: []].append(summary)
        all.append(summary)
      }

      for project in snapshot.projects where project.deletedAt == nil {
        let ref = ProjectRef(environmentId: machine.environmentId, projectId: project.id)
        let threads = sortThreads(byProject[project.id] ?? [])
        threadsByProject[ref] = threads
        var summary = projectSummary(project, environmentId: machine.environmentId, machineLabel: machine.label, machineOnline: machine.online, threads: threads)
        if project.isPersonal {
          // An active Aide beats an archived one, then the lowest environment id
          // wins (machines are visited in that order), as the web's findPersonalAssistant.
          if project.isArchived {
            if archivedAide == nil { archivedAide = summary }
          } else if aide == nil {
            aide = summary
          }
        } else if isScratch(project, scratchWorkspaceRoot: machine.scratchWorkspaceRoot) {
          // Its chats are listed under recents; the project is never a row, as on the web.
          continue
        } else {
          summary.isPinned = ProjectPinning.isPinned(project, environmentId: machine.environmentId, orders: orders)
          projects.append(summary)
        }
      }
    }

    projects.sort { a, b in
      if a.isPinned != b.isPinned { return a.isPinned }
      let order = a.title.localizedStandardCompare(b.title)
      if order != .orderedSame { return order == .orderedAscending }
      return (a.ref.environmentId, a.ref.projectId) < (b.ref.environmentId, b.ref.projectId)
    }
    let recent = Array(sortThreads(all).prefix(recentLimit))
    return Output(aide: aide ?? archivedAide, projects: projects, threadsByProject: threadsByProject, recentThreads: recent)
  }

  /// The machine's scratch project, which holds chats started without a project.
  public static func isScratch(_ project: ProjectShell, scratchWorkspaceRoot: String?) -> Bool {
    guard let root = scratchWorkspaceRoot.map(ProjectPinning.normalizePath), !root.isEmpty else { return false }
    return ProjectPinning.normalizePath(project.workspaceRoot) == root
  }

  /// Threads the user started: not a coordinator and not a subagent's child.
  public static func isTopLevel(_ thread: ThreadShell, coordinatorIds: Set<String>) -> Bool {
    if thread.isCoordinatorThread || coordinatorIds.contains(thread.id) { return false }
    if thread.isSubagent { return false }
    if thread.isArchived || thread.deletedAt != nil { return false }
    return true
  }

  /// Pinned first, then most recently updated.
  public static func sortThreads(_ threads: [ThreadSummary]) -> [ThreadSummary] {
    threads.sorted { a, b in
      if a.isPinned != b.isPinned { return a.isPinned }
      if a.updatedAt != b.updatedAt { return a.updatedAt > b.updatedAt }
      return (a.ref.environmentId, a.ref.threadId) < (b.ref.environmentId, b.ref.threadId)
    }
  }

  // MARK: - Threads

  public static func activity(_ thread: ThreadShell) -> ThreadActivity {
    if thread.pendingRuntimeRequest != nil { return .needsYou }
    if thread.status.isWorking || thread.activityRunStatus?.isWorking == true { return .working }
    if thread.status == .failed { return .failed }
    return .idle
  }

  public static func preview(_ thread: ThreadShell) -> String? {
    switch activity(thread) {
    case .needsYou:
      return thread.pendingRuntimeRequest?.kind.isUserInput == true ? "Waiting for your answer" : "Waiting for your approval"
    case .working:
      if let label = thread.activeWork?.label, !label.isEmpty { return oneLine(label) }
    case .failed:
      if let error = thread.lastError, !error.isEmpty { return oneLine(error) }
    case .idle:
      break
    }
    if let text = thread.latestVisibleMessage?.text, !text.isEmpty { return oneLine(text) }
    if let blocker = thread.reportedBlocker, !blocker.isEmpty { return oneLine(blocker) }
    return nil
  }

  public static func threadSummary(_ thread: ThreadShell, environmentId: String, projectTitle: String?, machineLabel: String, machineOnline: Bool) -> ThreadSummary {
    let activity = activity(thread)
    let working = activity == .working || activity == .needsYou
    let title = thread.title.trimmingCharacters(in: .whitespacesAndNewlines)
    return ThreadSummary(
      ref: ThreadRef(environmentId: environmentId, threadId: thread.id),
      projectRef: ProjectRef(environmentId: environmentId, projectId: thread.projectId),
      projectTitle: projectTitle,
      title: title.isEmpty ? "New thread" : title,
      activity: activity,
      preview: preview(thread),
      updatedAt: thread.updatedAt,
      workStartedAt: working ? (thread.activityRunStartedAt ?? thread.latestRunStartedAt) : nil,
      isPinned: thread.isPinned,
      isResolved: thread.isSettled,
      isUnread: thread.isUnread,
      machineLabel: machineLabel,
      machineOnline: machineOnline,
      planProgress: thread.planProgress.flatMap { $0.total > 0 ? PlanProgress(completed: $0.completed, total: $0.total) : nil }
    )
  }

  // MARK: - Projects

  public static func projectSummary(_ project: ProjectShell, environmentId: String, machineLabel: String, machineOnline: Bool, threads: [ThreadSummary]) -> ProjectSummary {
    let personal = project.isPersonal
    let title = project.displayTitle.trimmingCharacters(in: .whitespacesAndNewlines)
    return ProjectSummary(
      ref: ProjectRef(environmentId: environmentId, projectId: project.id),
      title: title.isEmpty ? (personal ? "Aide" : "Project") : title,
      icon: icon(project.projectIcon ?? (personal ? .personalAssistant : nil)),
      kind: personal ? .personal : .code,
      machineLabel: machineLabel,
      machineOnline: machineOnline,
      isPinned: false,
      paused: project.isPaused,
      archived: project.isArchived,
      workingCount: threads.filter { $0.activity == .working || $0.activity == .needsYou }.count,
      hasUnread: threads.contains { $0.isUnread }
    )
  }

  public static func icon(_ icon: ProjectIconOverride?) -> ProjectIcon {
    switch icon {
    case let .lucide(name, color)?: .symbol(name: name, color: color)
    case let .emoji(emoji)?: .emoji(emoji)
    case let .monogram(text, color)?: .monogram(text: text, color: color)
    case .unknown?, nil: .none
    }
  }

  static func oneLine(_ text: String, limit: Int = 240) -> String {
    let collapsed = text.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.joined(separator: " ")
    guard collapsed.count > limit else { return collapsed }
    return String(collapsed.prefix(limit)).trimmingCharacters(in: .whitespaces) + "…"
  }
}

/// Matches projects against the sidebar order the web app saves in server
/// settings (apps/web/src/studio/projectOrder.ts). Saved keys are logical
/// project keys, repository keys or physical `environmentId:path` keys, and
/// `pinnedMembers` remembers each pin's `environmentId:projectId` members.
public enum ProjectPinning {
  public static func isPinned(_ project: ProjectShell, environmentId: String, orders: [SidebarProjectOrder]) -> Bool {
    guard !orders.isEmpty else { return false }
    let keys = Set(projectKeys(project, environmentId: environmentId))
    let member = "\(environmentId):\(project.id)"
    for order in orders {
      for key in order.pinned {
        if keys.contains(key) { return true }
        if order.pinnedMembers?[key]?.contains(member) == true { return true }
      }
    }
    return false
  }

  /// Every key the web app may have saved for this project.
  public static func projectKeys(_ project: ProjectShell, environmentId: String) -> [String] {
    var keys: [String] = []
    if let logical = project.workspaceSettings?.logicalProject {
      keys.append("logical-project:\(logical.id)")
    }
    let root = normalizePath(project.workspaceRoot)
    keys.append("\(environmentId):\(root)")
    if let identity = project.repositoryIdentity {
      let canonical = identity.canonicalKey
      keys.append(canonical)
      if let rootPath = identity.rootPath.map(normalizePath), !rootPath.isEmpty, !root.isEmpty {
        let separator = rootPath.contains("\\") ? "\\" : "/"
        if root != rootPath, root.hasPrefix(rootPath + separator) {
          let relative = String(root.dropFirst(rootPath.count + 1)).replacingOccurrences(of: "\\", with: "/")
          keys.append("\(canonical)::\(relative)")
        }
      }
    }
    return keys
  }

  /// Trims whitespace and trailing separators; Windows paths compare lowercased.
  public static func normalizePath(_ value: String) -> String {
    var path = value.trimmingCharacters(in: .whitespacesAndNewlines)
    let isRoot: (String) -> Bool = { $0 == "/" || $0 == "\\" || ($0.count == 3 && $0.dropFirst().hasPrefix(":") && ($0.hasSuffix("/") || $0.hasSuffix("\\"))) }
    if !path.isEmpty, !isRoot(path) {
      let separators: Set<Character> = path.hasPrefix("/") ? ["/"] : ["/", "\\"]
      var trimmed = path
      while let last = trimmed.last, separators.contains(last) { trimmed.removeLast() }
      if !trimmed.isEmpty {
        path = (trimmed.count == 2 && trimmed.hasSuffix(":")) ? trimmed + "\\" : trimmed
      }
    }
    let windowsDrive = path.count >= 2 && path.first?.isLetter == true && path.dropFirst().first == ":"
    if windowsDrive || path.hasPrefix("\\\\") {
      return path.replacingOccurrences(of: "/", with: "\\").lowercased()
    }
    return path
  }
}

/// Which thread a project's or Aide's chat shows.
public enum CoordinatorRouting {
  public enum Resolution: Hashable, Sendable {
    /// The project names its coordinator thread.
    case known(String)
    /// No thread is stored yet: call `projects.coordinatorStart`, which
    /// creates it; `fallback` is the id the server uses by default.
    case needsStart(fallback: String)
  }

  public static func resolve(_ project: ProjectShell) -> Resolution {
    if let id = project.workspaceSettings?.coordinatorThreadId, !id.isEmpty { return .known(id) }
    return .needsStart(fallback: ProjectShell.defaultCoordinatorThreadId(projectId: project.id))
  }

  public static func threadId(for project: ProjectShell?, projectId: String) -> String {
    project?.coordinatorThreadId ?? ProjectShell.defaultCoordinatorThreadId(projectId: projectId)
  }
}
