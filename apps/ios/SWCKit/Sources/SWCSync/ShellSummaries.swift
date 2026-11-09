import Foundation
import SWCWire

/// Turns machines' shells into the drawer and list models. Pure, so it is
/// tested without sockets.
public enum ShellSummaries {
  /// What one machine contributes.
  public struct Machine: Sendable, Equatable {
    public var environmentId: String
    public var label: String
    public var online: Bool
    /// Not online yet, but still on its first attempt inside the connecting
    /// grace: rows read "connecting", not offline or unknown.
    public var settling: Bool
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

    public init(environmentId: String, label: String, online: Bool, settling: Bool = false, snapshot: ShellSnapshot?, projectOrder: SidebarProjectOrder? = nil, scratchWorkspaceRoot: String? = nil, nickname: String? = nil, lastSeenAt: Date? = nil, providers: [ServerProviderSummary] = []) {
      self.environmentId = environmentId
      self.label = label
      self.online = online
      self.settling = !online && settling
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
  ///   - home: Machines whose projects are listed, as the desktop app lists
  ///     its own machine's (see `listedMachines`). Empty lists every machine.
  ///   - includeAide: False hides Aide: no `aide`, and its chats are left out
  ///     of recents and `threadsByProject`. Nothing on the machines changes.
  ///   - cache: Each machine's rows from the previous build, reused for a
  ///     machine whose rows would come out the same.
  public static func build(_ machines: [Machine], names: [String: String] = [:], nicknames: [String: String] = [:], home: Set<String> = [], includeAide: Bool = true, cache: Cache? = nil) -> Output {
    let known = machines.map { machine in
      var machine = machine
      if machine.nickname == nil { machine.nickname = nicknames[machine.environmentId] }
      return machine
    }.sorted { $0.environmentId < $1.environmentId }
    let listedIds = listedMachines(known, home: home)
    let ordered = known.filter { listedIds.contains($0.environmentId) }
    let orders = ordered.compactMap(\.projectOrder)
    // The desktop arranges its list by its own machine's saved order. The
    // phone follows the first home machine that holds one, in pairing order,
    // then any other listed machine's.
    let byPairing = machines.filter { listedIds.contains($0.environmentId) }
    let mainOrder = (byPairing.filter { home.contains($0.environmentId) } + byPairing)
      .compactMap(\.projectOrder)
      .first { !$0.pinned.isEmpty || !$0.unpinned.isEmpty }
    // Every known machine still names threads that run on it.
    let directory = Directory(machines: known, names: names, nicknames: nicknames)
    let listed = Set(ordered.flatMap { machine in (machine.snapshot?.threads ?? []).map { "\(machine.environmentId)/\($0.id)" } })
    var aides: [ProjectSummary] = []
    var projects: [ProjectSummary] = []
    var copies: [LinkedCopy] = []
    var threadsByProject: [ProjectRef: [ThreadSummary]] = [:]
    var all: [ThreadSummary] = []

    for machine in ordered {
      guard let snapshot = machine.snapshot else { continue }
      let personalIds = Set(snapshot.projects.filter(\.isPersonal).map(\.id))
      let byProject = topLevelThreads(on: machine, directory: directory, listed: listed, filter: .excluding(includeAide ? [] : personalIds), cache: cache)
      all += byProject.values.joined()

      for project in snapshot.projects where project.deletedAt == nil {
        let ref = ProjectRef(environmentId: machine.environmentId, projectId: project.id)
        if project.isPersonal && !includeAide { continue }
        let threads = sortThreads(byProject[project.id] ?? [])
        threadsByProject[ref] = threads
        var summary = projectSummary(project, environmentId: machine.environmentId, machineLabel: machine.displayName, machineOnline: machine.online, machineSettling: machine.settling, threads: threads)
        if project.isPersonal {
          aides.append(summary)
        } else if isScratch(project, scratchWorkspaceRoot: machine.scratchWorkspaceRoot) {
          // Its chats are listed under recents; the project is never a row, as on the web.
          continue
        } else {
          // The desktop reads pins from the same one order it arranges by.
          summary.isPinned = ProjectPinning.isPinned(project, environmentId: machine.environmentId, orders: mainOrder.map { [$0] } ?? orders)
          copies.append(LinkedCopy(project: project, summary: summary, threads: threads, lastSeenAt: machine.lastSeenAt, keys: ProjectPinning.projectKeys(project, environmentId: machine.environmentId)))
        }
      }
    }

    // Aide is private to its machine, so it may live on one the desktop does
    // not list (another person's home Mac, a worker no project links to).
    // Those machines are searched too, after the listed ones, so the phone
    // never offers to set up a second Aide.
    var others: [ProjectSummary] = []
    var otherThreads: [ProjectRef: [ThreadSummary]] = [:]
    if includeAide {
      for machine in known where !listedIds.contains(machine.environmentId) {
        guard let snapshot = machine.snapshot else { continue }
        let personalIds = Set(snapshot.projects.filter { $0.isPersonal && $0.deletedAt == nil }.map(\.id))
        guard !personalIds.isEmpty else { continue }
        let byProject = topLevelThreads(on: machine, directory: directory, listed: listed, filter: .only(personalIds), cache: cache)
        for project in snapshot.projects where personalIds.contains(project.id) {
          let ref = ProjectRef(environmentId: machine.environmentId, projectId: project.id)
          let threads = sortThreads(byProject[project.id] ?? [])
          otherThreads[ref] = threads
          others.append(projectSummary(project, environmentId: machine.environmentId, machineLabel: machine.displayName, machineOnline: machine.online, machineSettling: machine.settling, threads: threads))
        }
      }
    }
    // An active Aide beats an archived one, then a listed machine's beats
    // another's, then the lowest environment id wins (machines are visited in
    // that order), as the web's findPersonalAssistant.
    let aide = aides.first { !$0.archived } ?? others.first { !$0.archived } ?? aides.first ?? others.first
    if let aide, let threads = otherThreads[aide.ref] {
      // Only the chosen Aide's chats come from a machine that is not listed.
      threadsByProject[aide.ref] = threads
      all += threads
    }

    var ranks: [ProjectRef: ProjectOrdering.Rank] = [:]
    for group in sameProjectGroups(copies) {
      // A linked project is one row under its logical key alone, apart from
      // unlinked checkouts of its repository.
      let linked = group.filter { $0.project.workspaceSettings?.logicalProject != nil }
      let rank = ProjectOrdering.rank(keys: (linked.isEmpty ? group : linked).flatMap(\.keys), members: group.map { "\($0.summary.ref.environmentId):\($0.summary.ref.projectId)" }, in: mainOrder)
      if group.count == 1, group[0].project.workspaceSettings?.logicalProject == nil {
        projects.append(group[0].summary)
        ranks[group[0].summary.ref] = rank
        continue
      }
      let merged = merge(group)
      projects.append(merged.summary)
      ranks[merged.summary.ref] = rank
      for member in group { threadsByProject[member.summary.ref] = merged.threads }
    }

    projects.sort { a, b in
      if a.isPinned != b.isPinned { return a.isPinned }
      if let first = ProjectOrdering.precedes(ranks[a.ref], ranks[b.ref], pinned: a.isPinned) { return first }
      let order = a.title.localizedStandardCompare(b.title)
      if order != .orderedSame { return order == .orderedAscending }
      return (a.ref.environmentId, a.ref.projectId) < (b.ref.environmentId, b.ref.projectId)
    }
    let recent = Array(all.filter { !$0.isCoordinatorWorker }.sorted {
      if $0.activityAt != $1.activityAt { return $0.activityAt > $1.activityAt }
      return ($0.ref.environmentId, $0.ref.threadId) < ($1.ref.environmentId, $1.ref.threadId)
    }.prefix(recentLimit))
    cache?.finish()
    return Output(aide: aide, projects: projects, threadsByProject: threadsByProject, recentThreads: recent)
  }

  // MARK: - Machines

  /// The machines whose projects and threads the phone lists, as the desktop
  /// app's catalog holds them: the home machines, then every machine a listed
  /// project names as a linked member or as its coordinator's new home
  /// (`linkedMachineIds` on the web), or a listed thread was moved to another
  /// project on, repeated until nothing new is named.
  /// Another machine's own projects, which the desktop never lists, stay out,
  /// so a worker's unlinked copy of a project is not a second row. With no home
  /// machine known yet (paired only through Connect, or an install from before
  /// home machines were kept), every machine is listed.
  static func listedMachines(_ machines: [Machine], home: Set<String>) -> Set<String> {
    let all = Set(machines.map(\.environmentId))
    var listed = home.intersection(all)
    guard !listed.isEmpty else { return all }
    let byId = Dictionary(machines.map { ($0.environmentId, $0) }, uniquingKeysWith: { first, _ in first })
    var pending = Array(listed)
    while let id = pending.popLast() {
      let snapshot = byId[id]?.snapshot
      var named: [String] = []
      for project in snapshot?.projects ?? [] where project.deletedAt == nil {
        let settings = project.workspaceSettings
        named += (settings?.logicalProject?.members.map(\.environmentId) ?? []) + [settings?.coordinatorBinding?.successor?.environmentId].compactMap { $0 }
      }
      // The desktop moves a thread to another project only on a machine it
      // lists. A handoff to a worker is not one: the source copy stays listed,
      // placed on the worker, as on the desktop.
      named += (snapshot?.threads ?? []).compactMap { $0.movedTo?.isHandoff == false ? $0.movedTo?.environmentId : nil }
      for next in named where all.contains(next) && listed.insert(next).inserted {
        pending.append(next)
      }
    }
    return listed
  }

  /// The projects whose threads a machine contributes.
  enum ProjectFilter: Equatable {
    case excluding(Set<String>)
    case only(Set<String>)

    func includes(_ projectId: String) -> Bool {
      switch self {
      case let .excluding(ids): !ids.contains(projectId)
      case let .only(ids): ids.contains(projectId)
      }
    }
  }

  /// Every machine's rows from the last build. A machine's rows are made only
  /// from what `Key` holds, so while that is equal they are reused instead of
  /// summarizing each of its threads again. Not thread-safe: one owner builds
  /// with it at a time.
  public final class Cache {
    struct Key: Equatable {
      var machine: Machine
      var directory: Directory
      /// The machine's handed-off threads whose continuation is listed.
      var continuations: Set<String>
      var filter: ProjectFilter
    }

    private var entries: [String: (key: Key, rows: [String: [ThreadSummary]])] = [:]
    private var used: Set<String> = []
    /// How often each machine's threads were summarized afresh, for tests.
    private(set) var summarized: [String: Int] = [:]

    public init() {}

    func rows(_ key: Key, make: () -> [String: [ThreadSummary]]) -> [String: [ThreadSummary]] {
      let id = key.machine.environmentId
      used.insert(id)
      if let entry = entries[id], entry.key == key { return entry.rows }
      let rows = make()
      entries[id] = (key, rows)
      summarized[id, default: 0] += 1
      return rows
    }

    /// Forgets machines the last build did not visit.
    func finish() {
      entries = entries.filter { used.contains($0.key) }
      used = []
    }
  }

  /// `topLevelThreads` through `cache`, when there is one.
  static func topLevelThreads(on machine: Machine, directory: Directory, listed: Set<String>, filter: ProjectFilter, cache: Cache?) -> [String: [ThreadSummary]] {
    guard let cache else { return topLevelThreads(on: machine, directory: directory, listed: listed, include: filter.includes) }
    let continuations = Set((machine.snapshot?.threads ?? []).compactMap { thread -> String? in
      guard let next = thread.movedTo, next.isHandoff else { return nil }
      let key = "\(next.environmentId ?? machine.environmentId)/\(next.threadId)"
      return listed.contains(key) ? key : nil
    })
    // Rows read a machine's last-seen time only while it is unreachable, and
    // an online machine's moves every heartbeat: it is not part of the key.
    var keyed = machine
    if keyed.online { keyed.lastSeenAt = nil }
    let key = Cache.Key(machine: keyed, directory: directory, continuations: continuations, filter: filter)
    return cache.rows(key) { topLevelThreads(on: machine, directory: directory, listed: listed, include: filter.includes) }
  }

  /// One machine's top-level threads by project id, for the projects `include`
  /// accepts. A handed-off copy is left out when its continuation is listed.
  static func topLevelThreads(on machine: Machine, directory: Directory, listed: Set<String>, include: (String) -> Bool) -> [String: [ThreadSummary]] {
    guard let snapshot = machine.snapshot else { return [:] }
    let coordinatorIds = Set(snapshot.projects.map(\.coordinatorThreadId))
    let titles = Dictionary(snapshot.projects.map { ($0.id, $0.displayTitle) }, uniquingKeysWith: { first, _ in first })
    var byProject: [String: [ThreadSummary]] = [:]
    for thread in snapshot.threads where include(thread.projectId) && isTopLevel(thread, coordinatorIds: coordinatorIds) {
      // A handed-off copy is listed through its continuation when that is known.
      if let next = thread.movedTo, next.isHandoff, listed.contains("\(next.environmentId ?? machine.environmentId)/\(next.threadId)") { continue }
      var summary = threadSummary(thread, environmentId: machine.environmentId, projectTitle: titles[thread.projectId], machineLabel: machine.displayName, machineOnline: machine.online, machineSettling: machine.settling, providers: machine.providers)
      summary.placement = placement(thread, on: machine, directory: directory)
      summary.isCoordinatorWorker = isCoordinatorWorker(thread, coordinatorIds: coordinatorIds)
      byProject[thread.projectId, default: []].append(summary)
    }
    return byProject
  }

  /// Names and reachability of every machine the phone knows.
  struct Directory: Equatable {
    /// What a row reads about another machine; never its threads, so one
    /// machine's new thread list leaves the others' rows as they were.
    struct Peer: Equatable {
      var displayName: String
      /// Online, or still on its first attempt: a settling peer does not make
      /// the threads it runs unknown.
      var online: Bool
      /// Only while the peer is unreachable: an online peer's moves every
      /// heartbeat, and keeping it would rebuild every machine's rows.
      var lastSeenAt: Date?
    }

    var machines: [String: Peer]
    var names: [String: String]
    var nicknames: [String: String]

    init(machines: [Machine], names: [String: String], nicknames: [String: String] = [:]) {
      self.machines = Dictionary(machines.map { ($0.environmentId, Peer(displayName: $0.displayName, online: $0.online || $0.settling, lastSeenAt: $0.online ? nil : $0.lastSeenAt)) }, uniquingKeysWith: { first, _ in first })
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
    if !machine.online && !machine.settling {
      placement.unknown = .init(machine: machine.displayName, lastSeenAt: machine.lastSeenAt)
    } else if thread.executionState == .unknown || (execution != machine.environmentId && directory.isOnline(execution) == false) {
      // The machine that runs it is unreachable: from its server, or from the phone.
      placement.unknown = .init(machine: executionName, lastSeenAt: directory.lastSeen(execution) ?? thread.executionLastSeenAt)
    }
    return placement
  }

  // MARK: - One row per project

  /// The keys that show two project records are the same project, as the
  /// desktop sidebar's default "repository" grouping (`deriveLogicalProjectKey`)
  /// decides: a linked project's id, otherwise its repository grouping key,
  /// otherwise its folder on its machine. The same folder registered twice also
  /// matches. Names never decide. Only the row merges: every record stays a
  /// member the switcher can open. Unlike the desktop, a check's copies group
  /// apart from the person's own (see `sameProjectGroups`), and the desktop's
  /// per-device grouping setting is not visible to the phone.
  static func sameProjectKeys(_ project: ProjectShell, environmentId: String) -> [String] {
    var keys: [String] = []
    if let logical = project.workspaceSettings?.logicalProject {
      keys.append("logical:\(logical.id)")
    } else if let repository = project.repositoryIdentity?.groupingKey, !repository.isEmpty {
      keys.append("repo:\(repository)")
    }
    if let folder = folderKey(project, environmentId: environmentId) { keys.append(folder) }
    return keys
  }

  static func folderKey(_ project: ProjectShell, environmentId: String) -> String? {
    let root = ProjectPinning.normalizePath(project.workspaceRoot)
    return root.isEmpty ? nil : "folder:\(environmentId):\(root)"
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
    // A second registration of a linked copy's folder joins the linked row
    // only; it does not also pull in the repository's unlinked checkouts, as
    // the desktop keeps linked projects apart from repository groups.
    let linkedFolders = Set(copies.compactMap { copy in
      copy.project.workspaceSettings?.logicalProject == nil ? nil : folderKey(copy.project, environmentId: copy.summary.ref.environmentId)
    })
    var owner: [String: Int] = [:]
    for (index, copy) in copies.enumerated() {
      let side = copy.summary.isAutomated ? "automated" : "user"
      var keys = sameProjectKeys(copy.project, environmentId: copy.summary.ref.environmentId)
      if let folder = folderKey(copy.project, environmentId: copy.summary.ref.environmentId), linkedFolders.contains(folder) {
        keys.removeAll { $0.hasPrefix("repo:") }
      }
      for key in keys {
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
    /// Every key the web app may have saved for this copy in a sidebar order.
    var keys: [String] = []
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
    // An archived copy leads only when every copy is archived, as the desktop
    // hides a group only then.
    let live = copies.filter { !$0.summary.archived }
    let candidates = (linkedCopies.isEmpty ? copies : linkedCopies).filter { live.isEmpty || !$0.summary.archived }
    let latest = { (copy: LinkedCopy) in copy.threads.map(\.updatedAt).max() ?? .distantPast }
    let online = candidates.filter { $0.summary.machineOnline }
    let busiest = online.max { latest($0) < latest($1) }
    let primary = coordinator ?? busiest ?? candidates.first ?? live.first ?? copies[0]
    let members = ([primary] + copies.filter { $0.summary.ref != primary.summary.ref }).map { copy in
      var member = ProjectMember(ref: copy.summary.ref, machineLabel: copy.summary.machineLabel, machineOnline: copy.summary.machineOnline, lastSeenAt: copy.lastSeenAt, isCoordinator: copy.summary.ref == coordinator?.summary.ref, isLinked: logicalId != nil && copy.project.workspaceSettings?.logicalProject?.id == logicalId, folder: ProjectPinning.normalizePath(copy.project.workspaceRoot))
      member.machineSettling = copy.summary.machineSettling
      return member
    }
    let threads = sortThreads(copies.flatMap(\.threads))
    var summary = primary.summary
    summary.title = groupLabel(copies, primary: primary, logicalId: logicalId)
    summary.members = members
    summary.logicalProjectId = logicalId
    let here = primary.summary.ref.environmentId
    var named = Set([here])
    summary.linkedMachineIds = (primary.project.workspaceSettings?.logicalProject?.members ?? []).map(\.environmentId).filter { named.insert($0).inserted }
    summary.coordinatorElsewhereId = coordinatorElsewhere(primary, among: copies)
    summary.isPinned = copies.contains { $0.summary.isPinned }
    summary.archived = live.isEmpty
    // Automated only when no machine holds it as the person's own.
    summary.isAutomated = copies.allSatisfy { $0.summary.isAutomated }
    summary.workingCount = copies.reduce(0) { $0 + $1.summary.workingCount }
    summary.hasUnread = copies.contains { $0.summary.hasUnread }
    return (summary, threads)
  }

  /// The row's name, as the desktop's `deriveProjectGroupLabel`: a linked
  /// project's title; else the one title every copy shares; else the one
  /// title someone typed; else the repository's name; else the leading copy's.
  static func groupLabel(_ copies: [LinkedCopy], primary: LinkedCopy, logicalId: String?) -> String {
    func unique(_ values: [String?]) -> [String] {
      var seen = Set<String>()
      return values.compactMap { $0?.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty && seen.insert($0).inserted }
    }
    if let logicalId, let title = copies.lazy.compactMap({ $0.project.workspaceSettings?.logicalProject }).first(where: { $0.id == logicalId })?.title, !title.isEmpty {
      return title
    }
    let titles = unique(copies.map(\.project.title))
    let displayNames = unique(copies.map { $0.project.repositoryIdentity?.groupingDisplayName })
    let repositoryNames = unique(copies.map { $0.project.repositoryIdentity?.name })
    let automatic = Set(displayNames + repositoryNames)
    if titles.count == 1, !automatic.contains(titles[0]) { return titles[0] }
    let custom = unique(copies.map { copy in
      let title = copy.project.title.trimmingCharacters(in: .whitespaces)
      let folder = ProjectPinning.normalizePath(copy.project.workspaceRoot).split(separator: "/").last.map(String.init) ?? "project"
      return automatic.contains(title) || title == folder ? nil : title
    })
    if custom.count == 1 { return custom[0] }
    if displayNames.count == 1 { return displayNames[0] }
    if repositoryNames.count == 1 { return repositoryNames[0] }
    return primary.project.title
  }

  /// The machine a workers-only copy's coordinator moved to, followed along
  /// later moves, as the web's `coordinatorElsewhere`. Nil when the copy is not
  /// workers-only, names no successor, or the coordinator is on its own machine.
  static func coordinatorElsewhere(_ copy: LinkedCopy, among copies: [LinkedCopy]) -> String? {
    guard let binding = copy.project.workspaceSettings?.coordinatorBinding, binding.state == .transferred, var successor = binding.successor else { return nil }
    let key = { (ref: ProjectRef) in "\(ref.environmentId):\(ref.projectId)" }
    var seen = Set([key(copy.summary.ref)])
    while true {
      let next = "\(successor.environmentId):\(successor.projectId)"
      guard seen.insert(next).inserted else { return nil }
      guard let binding = copies.first(where: { key($0.summary.ref) == next })?.project.workspaceSettings?.coordinatorBinding,
            binding.state == .transferred, let later = binding.successor else { break }
      successor = later
    }
    return successor.environmentId == copy.summary.ref.environmentId ? nil : successor.environmentId
  }

  /// The active coordinator with the highest epoch, as the desktop decides it.
  static func activeCoordinator(_ copies: [LinkedCopy]) -> LinkedCopy? {
    LinkedProjectResolver.coordinator(copies)
  }

  /// The machine's scratch project, which holds chats started without a project.
  public static func isScratch(_ project: ProjectShell, scratchWorkspaceRoot: String?) -> Bool {
    guard let root = scratchWorkspaceRoot.map(ProjectPinning.normalizePath), !root.isEmpty else { return false }
    return ProjectPinning.normalizePath(project.workspaceRoot) == root
  }

  /// Threads a project lists: not a coordinator and not a thread's own
  /// subagent. A coordinator's workers are listed, as on the desktop.
  public static func isTopLevel(_ thread: ThreadShell, coordinatorIds: Set<String>) -> Bool {
    if thread.isCoordinatorThread || coordinatorIds.contains(thread.id) { return false }
    if thread.isSubagent, !isCoordinatorWorker(thread, coordinatorIds: coordinatorIds) { return false }
    if thread.isArchived || thread.deletedAt != nil { return false }
    return true
  }

  /// Started by a project's coordinator, such as a delegated task.
  public static func isCoordinatorWorker(_ thread: ThreadShell, coordinatorIds: Set<String>) -> Bool {
    guard thread.isSubagent, let parent = thread.lineage.parentThreadId else { return false }
    return parent.hasPrefix("project-coordinator:") || coordinatorIds.contains(parent)
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
    preview(thread, attention: ThreadAttention.attention(thread))
  }

  /// `preview` from attention the caller already read, so a row reads its
  /// thread's report once.
  static func preview(_ thread: ThreadShell, attention: ThreadAttention.Attention) -> String? {
    switch activity(thread) {
    case .needsYou:
      if thread.pendingRuntimeRequest == nil { return "Plan ready" }
      if let request = thread.pendingRuntimeRequest, request.isAccessRequest {
        return AccessRequestCopy.waitingSubtitle(request.access?.subjects.map(\.copyName) ?? [])
      }
      if thread.pendingRuntimeRequest?.kind.isUserInput == true { return "Answer needed" }
      return thread.pendingRuntimeRequest?.kind == .authRefresh ? "Sign-in needed" : "Approval requested"
    case .working:
      if let wait = attention.dependencyWait { return wait }
      if let label = thread.activeWork?.label, !label.isEmpty { return oneLine(label) }
    case .failed:
      if let error = thread.lastError, !error.isEmpty { return oneLine(error) }
    case .idle:
      if attention.needsReply { return "Reply needed" }
      if (thread.heldQueuedCount ?? 0) > 0 { return "Queue held" }
      if let wait = attention.dependencyWait { return wait }
    }
    if let text = thread.latestVisibleMessage?.text, !text.isEmpty { return oneLine(text) }
    if let blocker = thread.reportedBlocker, !blocker.isEmpty { return oneLine(blocker) }
    return nil
  }

  public static func threadSummary(_ thread: ThreadShell, environmentId: String, projectTitle: String?, machineLabel: String, machineOnline: Bool, machineSettling: Bool = false, providers: [ServerProviderSummary] = []) -> ThreadSummary {
    let activity = activity(thread)
    let attention = ThreadAttention.attention(thread)
    let working = activity == .working || activity == .needsYou
    let title = thread.title.trimmingCharacters(in: .whitespacesAndNewlines)
    var summary = ThreadSummary(
      ref: ThreadRef(environmentId: environmentId, threadId: thread.id),
      projectRef: ProjectRef(environmentId: environmentId, projectId: thread.projectId),
      projectTitle: projectTitle,
      title: title.isEmpty ? "New thread" : title,
      activity: activity,
      preview: preview(thread, attention: attention),
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
      waitsOnUser: (thread.heldQueuedCount ?? 0) > 0 || attention.needsReply
    )
    summary.machineSettling = machineSettling
    summary.isDone = thread.status == .completed
    summary.waitReason = attention.dependencyWait
    summary.asksForAccess = thread.pendingRuntimeRequest?.isAccessRequest == true
    summary.traits = traits(thread.modelSelection, providers: providers)
    summary.runtimeMode = RuntimeModeChoice(rawValue: thread.runtimeMode.rawValue)
    return summary
  }

  /// The options the thread's model takes, or nil when its machine lists none.
  static func traits(_ selection: ModelSelection, providers: [ServerProviderSummary]) -> ModelTraits? {
    guard let provider = providers.first(where: { $0.instanceId == selection.instanceId }),
          let model = provider.models.first(where: { $0.slug == selection.model || ($0.aliases ?? []).contains(selection.model) }),
          !model.optionDescriptors.isEmpty
    else { return nil }
    return ModelTraits(selection: selection, descriptors: model.optionDescriptors)
  }

  // MARK: - Projects

  public static func projectSummary(_ project: ProjectShell, environmentId: String, machineLabel: String, machineOnline: Bool, machineSettling: Bool = false, threads: [ThreadSummary]) -> ProjectSummary {
    let personal = project.isPersonal
    let title = project.displayTitle.trimmingCharacters(in: .whitespacesAndNewlines)
    var summary = ProjectSummary(
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
      workingCount: threads.filter { !$0.isUnknown && ($0.activity == .working || $0.activity == .needsYou || $0.waitReason != nil) }.count,
      hasUnread: threads.contains { $0.isUnread }
    )
    summary.machineSettling = machineSettling
    return summary
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

/// Places projects as the desktop's sidebar does (`arrangeProjects` in
/// apps/web/src/studio/projectOrder.ts): pinned projects in their saved order,
/// then projects the order has never seen, then the rest in their saved order.
public enum ProjectOrdering {
  /// A project's place in each part of a saved order; `nil` where it is absent.
  public struct Rank: Hashable, Sendable {
    public var pinned: Int?
    public var unpinned: Int?

    public init(pinned: Int? = nil, unpinned: Int? = nil) {
      self.pinned = pinned
      self.unpinned = unpinned
    }
  }

  /// - Parameters:
  ///   - keys: Every key of the project's copies (`ProjectPinning.projectKeys`).
  ///   - members: The copies' `environmentId:projectId` ids, matched against `pinnedMembers`.
  public static func rank(keys: [String], members: [String], in order: SidebarProjectOrder?) -> Rank {
    guard let order else { return Rank() }
    let keys = Set(keys)
    let members = Set(members)
    let pinned = order.pinned.firstIndex { key in
      keys.contains(key) || order.pinnedMembers?[key]?.contains(where: members.contains) == true
    }
    return Rank(pinned: pinned, unpinned: order.unpinned.firstIndex(where: keys.contains))
  }

  /// Whether the first of two projects in the same part (both pinned or both
  /// not) comes first; `nil` when the order does not tell them apart. A pinned
  /// project the order does not place follows the placed ones; an unpinned
  /// one the order has never seen leads, as a new project does on the desktop.
  public static func precedes(_ a: Rank?, _ b: Rank?, pinned: Bool) -> Bool? {
    let first = pinned ? a?.pinned : a?.unpinned
    let second = pinned ? b?.pinned : b?.unpinned
    switch (first, second) {
    case let (x?, y?): return x == y ? nil : x < y
    case (nil, _?): return !pinned
    case (_?, nil): return pinned
    case (nil, nil): return nil
    }
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

  /// Every key the web app may have saved for this project. A linked project
  /// has only its logical key (`deriveLogicalProjectKey`).
  public static func projectKeys(_ project: ProjectShell, environmentId: String) -> [String] {
    if let logical = project.workspaceSettings?.logicalProject {
      return ["logical-project:\(logical.id)"]
    }
    var keys: [String] = []
    let root = normalizePath(project.workspaceRoot)
    keys.append("\(environmentId):\(root)")
    if let identity = project.repositoryIdentity {
      let canonical = identity.canonicalKey
      keys.append(canonical)
      if identity.groupingKey != canonical { keys.append(identity.groupingKey) }
      if let rootPath = identity.rootPath.map(normalizePath), !rootPath.isEmpty, !root.isEmpty {
        let separator = rootPath.contains("\\") ? "\\" : "/"
        if root != rootPath, root.hasPrefix(rootPath + separator) {
          let relative = String(root.dropFirst(rootPath.count + 1)).replacingOccurrences(of: "\\", with: "/")
          keys.append("\(canonical)::\(relative)")
          if identity.groupingKey != canonical { keys.append("\(identity.groupingKey)::\(relative)") }
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
