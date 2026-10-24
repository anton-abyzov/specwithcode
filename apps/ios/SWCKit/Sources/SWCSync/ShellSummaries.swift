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
    /// The live thread list, or the last one saved while the machine is unreachable.
    public var snapshot: ShellSnapshot?
    /// The machine's saved sidebar order, from its server settings.
    public var projectOrder: SidebarProjectOrder?
    /// Folder of the machine's scratch project ("No project"), from its server config.
    public var scratchWorkspaceRoot: String?
    /// The user's nickname for the machine, when set.
    public var nickname: String?
    /// When the phone last had the machine connected.
    public var lastSeenAt: Date?
    public var providers: [ServerProviderSummary]

    public init(environmentId: String, label: String, online: Bool, snapshot: ShellSnapshot?, projectOrder: SidebarProjectOrder? = nil, scratchWorkspaceRoot: String? = nil, nickname: String? = nil, lastSeenAt: Date? = nil, providers: [ServerProviderSummary] = []) {
      self.environmentId = environmentId
      self.label = label
      self.online = online
      self.snapshot = snapshot
      self.projectOrder = projectOrder
      self.scratchWorkspaceRoot = scratchWorkspaceRoot
      self.nickname = nickname
      self.lastSeenAt = lastSeenAt
      self.providers = providers
    }

    public var displayName: String {
      MachineNickname.resolve(environmentId: environmentId, label: label, nicknames: nickname.map { [environmentId: $0] } ?? [:])
    }
  }

  public struct Output: Sendable, Hashable {
    public var aide: ProjectSummary?
    public var projects: [ProjectSummary]
    public var threadsByProject: [ProjectRef: [ThreadSummary]]
    public var recentThreads: [ThreadSummary]
  }

  public static let recentLimit = 30

  /// - Parameters:
  ///   - names: Labels of machines the phone knows only from the main
  ///     machine's roster, so a thread running there still shows its name.
  ///   - nicknames: The user's nicknames by environment id, for every machine.
  public static func build(_ machines: [Machine], names: [String: String] = [:], nicknames: [String: String] = [:]) -> Output {
    let ordered = machines.map { machine in
      var machine = machine
      if machine.nickname == nil { machine.nickname = nicknames[machine.environmentId] }
      return machine
    }.sorted { $0.environmentId < $1.environmentId }
    let orders = ordered.compactMap(\.projectOrder)
    let directory = Directory(machines: ordered, names: names, nicknames: nicknames)
    let listed = Set(ordered.flatMap { machine in (machine.snapshot?.threads ?? []).map { "\(machine.environmentId)/\($0.id)" } })
    var aide: ProjectSummary?
    var archivedAide: ProjectSummary?
    var projects: [ProjectSummary] = []
    var copies: [LinkedCopy] = []
    var threadsByProject: [ProjectRef: [ThreadSummary]] = [:]
    var all: [ThreadSummary] = []

    for machine in ordered {
      guard let snapshot = machine.snapshot else { continue }
      let name = machine.displayName
      let coordinatorIds = Set(snapshot.projects.map(\.coordinatorThreadId))
      let titles = Dictionary(snapshot.projects.map { ($0.id, $0.displayTitle) }, uniquingKeysWith: { first, _ in first })

      var byProject: [String: [ThreadSummary]] = [:]
      for thread in snapshot.threads where isTopLevel(thread, coordinatorIds: coordinatorIds) {
        // A handed-off copy is listed through its continuation when that is known.
        if let next = thread.movedTo, next.isHandoff, listed.contains("\(next.environmentId ?? machine.environmentId)/\(next.threadId)") { continue }
        var summary = threadSummary(thread, environmentId: machine.environmentId, projectTitle: titles[thread.projectId], machineLabel: name, machineOnline: machine.online, providers: machine.providers)
        summary.placement = placement(thread, on: machine, directory: directory)
        byProject[thread.projectId, default: []].append(summary)
        all.append(summary)
      }

      for project in snapshot.projects where project.deletedAt == nil {
        let ref = ProjectRef(environmentId: machine.environmentId, projectId: project.id)
        let threads = sortThreads(byProject[project.id] ?? [])
        threadsByProject[ref] = threads
        var summary = projectSummary(project, environmentId: machine.environmentId, machineLabel: name, machineOnline: machine.online, threads: threads)
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
          copies.append(LinkedCopy(project: project, summary: summary, threads: threads, lastSeenAt: machine.lastSeenAt))
        }
      }
    }

    for group in sameProjectGroups(copies) {
      if group.count == 1, group[0].project.workspaceSettings?.logicalProject == nil {
        projects.append(group[0].summary)
        continue
      }
      let merged = merge(group)
      projects.append(merged.summary)
      for member in group { threadsByProject[member.summary.ref] = merged.threads }
    }

    projects.sort { a, b in
      if a.isPinned != b.isPinned { return a.isPinned }
      let order = a.title.localizedStandardCompare(b.title)
      if order != .orderedSame { return order == .orderedAscending }
      return (a.ref.environmentId, a.ref.projectId) < (b.ref.environmentId, b.ref.projectId)
    }
    let recent = Array(all.sorted {
      if $0.activityAt != $1.activityAt { return $0.activityAt > $1.activityAt }
      return ($0.ref.environmentId, $0.ref.threadId) < ($1.ref.environmentId, $1.ref.threadId)
    }.prefix(recentLimit))
    return Output(aide: aide ?? archivedAide, projects: projects, threadsByProject: threadsByProject, recentThreads: recent)
  }

  // MARK: - Machines

  /// Names and reachability of every machine the phone knows.
  struct Directory {
    var machines: [String: Machine]
    var names: [String: String]
    var nicknames: [String: String]

    init(machines: [Machine], names: [String: String], nicknames: [String: String] = [:]) {
      self.machines = Dictionary(machines.map { ($0.environmentId, $0) }, uniquingKeysWith: { first, _ in first })
      self.names = names
      self.nicknames = nicknames
    }

    func name(_ environmentId: String, reported: String? = nil) -> String {
      if let machine = machines[environmentId] { return machine.displayName }
      let label = names[environmentId] ?? reported ?? ""
      // A machine the phone never heard of reads better than its raw id.
      return MachineNickname.known(environmentId: environmentId, label: label, nicknames: nicknames) ?? "Another machine"
    }

    func isOnline(_ environmentId: String) -> Bool? { machines[environmentId]?.online }

    func lastSeen(_ environmentId: String) -> Date? { machines[environmentId]?.lastSeenAt }
  }

  /// Where a thread lives and runs. A thread listed by an unreachable
  /// machine, or one its machine reports it cannot reach, is unknown.
  static func placement(_ thread: ThreadShell, on machine: Machine, directory: Directory) -> ThreadPlacement {
    let owner = thread.ownerMachineId ?? machine.environmentId
    let handoff = thread.movedTo?.isHandoff == true ? thread.movedTo : nil
    let execution = thread.executionMachineId ?? handoff?.environmentId ?? owner
    let executionName = directory.name(execution, reported: thread.executionMachineLabel ?? handoff?.machineLabel)
    var placement = ThreadPlacement(owner: directory.name(owner), runsOn: execution == owner ? nil : executionName)
    if !machine.online {
      placement.unknown = .init(machine: machine.displayName, lastSeenAt: machine.lastSeenAt)
    } else if thread.executionState == .unknown || (execution != machine.environmentId && directory.isOnline(execution) == false) {
      // The machine that runs it is unreachable: from its server, or from the phone.
      placement.unknown = .init(machine: executionName, lastSeenAt: directory.lastSeen(execution) ?? thread.executionLastSeenAt)
    }
    return placement
  }

  // MARK: - One row per project

  /// The keys that show two project records are the same project: an explicit
  /// logical project, or the exact same folder on the same machine.
  /// Separate checkouts or worktrees of the same repository never merge
  /// solely because remotes match. Names never decide.
  static func sameProjectKeys(_ project: ProjectShell, environmentId: String) -> [String] {
    var keys: [String] = []
    if let logical = project.workspaceSettings?.logicalProject { keys.append("logical:\(logical.id)") }
    let root = ProjectPinning.normalizePath(project.workspaceRoot)
    if !root.isEmpty { keys.append("folder:\(environmentId):\(root)") }
    return keys
  }

  /// Groups records of the same project, from one machine or several, so the
  /// phone lists each project once. A check's copies group apart from the
  /// person's own, so they stay under Automated. Only the display merges:
  /// every record, its threads and its coordinator stay as they are.
  static func sameProjectGroups(_ copies: [LinkedCopy]) -> [[LinkedCopy]] {
    var parent = Array(copies.indices)
    func find(_ index: Int) -> Int {
      var index = index
      while parent[index] != index {
        parent[index] = parent[parent[index]]
        index = parent[index]
      }
      return index
    }
    var owner: [String: Int] = [:]
    for (index, copy) in copies.enumerated() {
      let side = copy.summary.isAutomated ? "automated" : "user"
      for key in sameProjectKeys(copy.project, environmentId: copy.summary.ref.environmentId) {
        // Linked copies are one project whoever made them; a shared
        // folder merges only copies on the same side.
        let scoped = key.hasPrefix("logical:") ? key : "\(side)|\(key)"
        if let first = owner[scoped] {
          let a = find(first), b = find(index)
          if a != b { parent[max(a, b)] = min(a, b) }
        } else {
          owner[scoped] = index
        }
      }
    }
    var groups: [Int: [LinkedCopy]] = [:]
    var order: [Int] = []
    for index in copies.indices {
      let root = find(index)
      if groups[root] == nil { order.append(root) }
      groups[root, default: []].append(copies[index])
    }
    return order.compactMap { groups[$0] }
  }

  // MARK: - Projects linked across machines

  struct LinkedCopy {
    var project: ProjectShell
    var summary: ProjectSummary
    var threads: [ThreadSummary]
    var lastSeenAt: Date?
  }

  /// One row for a project linked across machines or registered twice. The row
  /// opens the member whose coordinator is active, chosen as the web's
  /// `logicalCoordinator` does; without one, the online linked copy with the
  /// most recent thread.
  static func merge(_ copies: [LinkedCopy]) -> (summary: ProjectSummary, threads: [ThreadSummary]) {
    // The row's linked project: the one most of its copies share. Copies of the same
    // folder that were never linked sit in the row without being linked to it.
    let logicalIds = copies.compactMap { $0.project.workspaceSettings?.logicalProject?.id }
    let counts = Dictionary(logicalIds.map { ($0, 1) }, uniquingKeysWith: +)
    let logicalId = logicalIds.first { counts[$0] == counts.values.max() }
    let linkedCopies = copies.filter { $0.project.workspaceSettings?.logicalProject?.id == logicalId && logicalId != nil }
    let coordinator = activeCoordinator(linkedCopies)
    // Without an active coordinator, the reachable linked copy worked in most
    // recently; an unlinked same-folder copy leads only a row with no linked copies.
    let latest = { (copy: LinkedCopy) in copy.threads.map(\.updatedAt).max() ?? .distantPast }
    let online = (linkedCopies.isEmpty ? copies : linkedCopies).filter { $0.summary.machineOnline }
    let busiest = online.max { latest($0) < latest($1) }
    let primary = coordinator ?? busiest ?? linkedCopies.first ?? copies[0]
    let members = ([primary] + copies.filter { $0.summary.ref != primary.summary.ref }).map { copy in
      ProjectMember(ref: copy.summary.ref, machineLabel: copy.summary.machineLabel, machineOnline: copy.summary.machineOnline, lastSeenAt: copy.lastSeenAt, isCoordinator: copy.summary.ref == coordinator?.summary.ref, isLinked: logicalId != nil && copy.project.workspaceSettings?.logicalProject?.id == logicalId)
    }
    let threads = sortThreads(copies.flatMap(\.threads))
    var summary = primary.summary
    summary.members = members
    summary.isPinned = copies.contains { $0.summary.isPinned }
    // Automated only when no machine holds it as the person's own.
    summary.isAutomated = copies.allSatisfy { $0.summary.isAutomated }
    summary.workingCount = copies.reduce(0) { $0 + $1.summary.workingCount }
    summary.hasUnread = copies.contains { $0.summary.hasUnread }
    return (summary, threads)
  }

  static func activeCoordinator(_ copies: [LinkedCopy]) -> LinkedCopy? {
    let epoch = { (copy: LinkedCopy) in copy.project.workspaceSettings?.coordinatorBinding?.epoch ?? 0 }
    guard let highest = copies.map(epoch).max() else { return nil }
    let current = copies.filter { epoch($0) == highest }
    if let pending = current.first(where: { $0.project.workspaceSettings?.coordinatorBinding?.state == .transferring }) { return pending }
    let active = current.filter { $0.project.workspaceSettings?.coordinatorBinding?.state == .active }
    return active.count == 1 ? active[0] : nil
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
    if thread.pendingRuntimeRequest != nil || thread.hasActionableProposedPlan { return .needsYou }
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

  public static func threadSummary(_ thread: ThreadShell, environmentId: String, projectTitle: String?, machineLabel: String, machineOnline: Bool, providers: [ServerProviderSummary] = []) -> ThreadSummary {
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
      planProgress: thread.planProgress.flatMap { $0.total > 0 ? PlanProgress(completed: $0.completed, total: $0.total) : nil },
      activityAt: [thread.createdAt, thread.latestRunRequestedAt, thread.latestUserMessageAt].compactMap { $0 }.max(),
      identity: ThreadIdentity(selection: thread.modelIdentity?.current ?? thread.modelSelection, providers: providers),
      waitsOnUser: (thread.heldQueuedCount ?? 0) > 0 || (!thread.isSettled && thread.reportedBlocker?.isEmpty == false)
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
      isAutomated: project.isAutomated,
      workingCount: threads.filter { !$0.isUnknown && ($0.activity == .working || $0.activity == .needsYou) }.count,
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
