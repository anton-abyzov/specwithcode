import Foundation
import Observation

// The UI contract. SwiftUI views read `AppModel` and `ChatSession` only; they
// never see wire types, sockets or reducers. An `AppEngine` fills the model:
// `LiveEngine` talks to real machines, `FixtureEngine` serves sample data for
// previews, snapshot tests and simulator screenshots.

// MARK: - References

public struct ProjectRef: Hashable, Sendable, Codable {
  public let environmentId: String
  public let projectId: String
  public init(environmentId: String, projectId: String) {
    self.environmentId = environmentId
    self.projectId = projectId
  }
}

public struct ThreadRef: Hashable, Sendable, Codable {
  public let environmentId: String
  public let threadId: String
  public init(environmentId: String, threadId: String) {
    self.environmentId = environmentId
    self.threadId = threadId
  }
}

/// Where a message goes. Aide and projects talk to their coordinator.
public enum ChatTarget: Hashable, Sendable, Codable {
  case aide(ProjectRef)
  case project(ProjectRef)
  case thread(ThreadRef)

  public var environmentId: String {
    switch self {
    case let .aide(p), let .project(p): p.environmentId
    case let .thread(t): t.environmentId
    }
  }
}

// MARK: - Machines

public enum MachineStatus: String, Sendable, Codable {
  case offline, connecting, connected, reconnecting, needsRepair, unsupported

  public var isOnline: Bool { self == .connected }

  public var label: String {
    switch self {
    case .offline: "Offline"
    case .connecting: "Connecting"
    case .connected: "Online"
    case .reconnecting: "Reconnecting"
    case .needsRepair: "Pair again"
    case .unsupported: "Update needed"
    }
  }
}

public struct MachineSummary: Identifiable, Hashable, Sendable {
  /// The machine's environment id.
  public let id: String
  public var label: String
  /// The user's nickname for it, else its short name: what rows and notices show.
  public var displayName: String
  public var status: MachineStatus
  /// e.g. "macOS · arm64"
  public var platform: String?
  public var serverVersion: String?
  /// Base URL the app currently uses, e.g. https://m4.tailnet.ts.net
  public var address: String?
  /// Days until the pairing token expires, when known.
  public var tokenDaysLeft: Int?
  /// Online, but the machine's projects and threads are not live right now:
  /// the app is catching up or subscribing again after a failed stream.
  public var isStale: Bool
  /// Reached through SpecWithCode Connect, the signed-in account.
  public var viaConnect: Bool
  /// The account signed out; signing in again reconnects it.
  public var needsSignIn: Bool
  /// When SpecWithCode Connect last checked an offline computer.
  public var checkedAt: Date?
  /// Paired with a link or QR code, so it has a pairing that expires.
  public var hasDirectPairing: Bool

  public init(id: String, label: String, displayName: String? = nil, status: MachineStatus, platform: String? = nil, serverVersion: String? = nil, address: String? = nil, tokenDaysLeft: Int? = nil, isStale: Bool = false, viaConnect: Bool = false, needsSignIn: Bool = false, checkedAt: Date? = nil, hasDirectPairing: Bool? = nil) {
    self.displayName = displayName ?? MachineNickname.shortName(label)
    self.hasDirectPairing = hasDirectPairing ?? !viaConnect
    self.viaConnect = viaConnect
    self.needsSignIn = needsSignIn
    self.checkedAt = checkedAt
    self.id = id
    self.label = label
    self.status = status
    self.platform = platform
    self.serverVersion = serverVersion
    self.address = address
    self.tokenDaysLeft = tokenDaysLeft
    self.isStale = isStale
  }
}

// MARK: - Projects

public enum ProjectIcon: Hashable, Sendable {
  /// A Lucide icon name (e.g. "concierge-bell") and a color name or hex.
  case symbol(name: String, color: String?)
  case emoji(String)
  case monogram(text: String, color: String?)
  case none
}

public enum ProjectKind: String, Sendable { case code, personal }

public struct ProjectSummary: Identifiable, Hashable, Sendable {
  public var id: ProjectRef { ref }
  /// The project's own row; for a project on several machines, the member
  /// whose coordinator is active.
  public let ref: ProjectRef
  public var title: String
  public var icon: ProjectIcon
  public var kind: ProjectKind
  public var machineLabel: String
  public var machineOnline: Bool
  public var isPinned: Bool
  public var paused: Bool
  public var archived: Bool
  /// Made by a check or agent for itself; listed under "Automated", apart from the person's projects.
  public var isAutomated: Bool
  /// Threads of this project that are working right now.
  public var workingCount: Int
  public var hasUnread: Bool
  /// Each machine's copy of a project linked across machines, coordinator
  /// first. Empty for a project on one machine.
  public var members: [ProjectMember]

  public init(ref: ProjectRef, title: String, icon: ProjectIcon = .none, kind: ProjectKind = .code, machineLabel: String, machineOnline: Bool, isPinned: Bool = false, paused: Bool = false, archived: Bool = false, isAutomated: Bool = false, workingCount: Int = 0, hasUnread: Bool = false, members: [ProjectMember] = []) {
    self.ref = ref
    self.title = title
    self.icon = icon
    self.kind = kind
    self.machineLabel = machineLabel
    self.machineOnline = machineOnline
    self.isPinned = isPinned
    self.paused = paused
    self.archived = archived
    self.isAutomated = isAutomated
    self.workingCount = workingCount
    self.hasUnread = hasUnread
    self.members = members
  }

  /// True for this project's row or any machine's copy of it.
  public func contains(_ ref: ProjectRef) -> Bool {
    self.ref == ref || members.contains { $0.ref == ref }
  }
}

/// One machine's copy of a project linked across machines. Each has its own
/// coordinator; viewing one never moves a thread.
public struct ProjectMember: Identifiable, Hashable, Sendable {
  public var id: ProjectRef { ref }
  public let ref: ProjectRef
  /// The machine's nickname.
  public var machineLabel: String
  public var machineOnline: Bool
  /// When the phone last had the machine connected.
  public var lastSeenAt: Date?
  /// This copy's coordinator is the project's active coordinator.
  public var isCoordinator: Bool
  /// Linked to the project's other copies (one logical project), so a thread
  /// can move here. A copy that is only the same folder is listed in the
  /// same row but is not linked.
  public var isLinked: Bool
  /// The copy's folder on its machine, normalized; tells apart several
  /// checkouts of one repository on the same machine.
  public var folder: String?

  public init(ref: ProjectRef, machineLabel: String, machineOnline: Bool, lastSeenAt: Date? = nil, isCoordinator: Bool = false, isLinked: Bool = true, folder: String? = nil) {
    self.ref = ref
    self.isLinked = isLinked
    self.folder = folder
    self.machineLabel = machineLabel
    self.machineOnline = machineOnline
    self.lastSeenAt = lastSeenAt
    self.isCoordinator = isCoordinator
  }
}

// MARK: - Threads

public enum ThreadActivity: String, Sendable {
  /// Waiting for an approval or an answer from you.
  case needsYou
  case working
  case failed
  case idle
}

public struct ThreadSummary: Identifiable, Hashable, Sendable {
  public var id: ThreadRef { ref }
  public let ref: ThreadRef
  public var projectRef: ProjectRef?
  public var projectTitle: String?
  public var title: String
  public var activity: ThreadActivity
  /// Latest status line or message preview.
  public var preview: String?
  public var updatedAt: Date
  public var activityAt: Date
  public var identity: ThreadIdentity
  public var waitsOnUser: Bool
  /// When the current run started, for "2m" style elapsed labels.
  public var workStartedAt: Date?
  public var isPinned: Bool
  public var isResolved: Bool
  public var isUnread: Bool
  public var machineLabel: String
  public var machineOnline: Bool
  public var planProgress: PlanProgress?
  /// Where the thread lives and runs, by machine nickname, and whether its
  /// state is unknown because that machine is unreachable.
  public var placement: ThreadPlacement

  public init(ref: ThreadRef, projectRef: ProjectRef? = nil, projectTitle: String? = nil, title: String, activity: ThreadActivity, preview: String? = nil, updatedAt: Date, workStartedAt: Date? = nil, isPinned: Bool = false, isResolved: Bool = false, isUnread: Bool = false, machineLabel: String, machineOnline: Bool, planProgress: PlanProgress? = nil, placement: ThreadPlacement? = nil, activityAt: Date? = nil, identity: ThreadIdentity = .unknown, waitsOnUser: Bool = false) {
    self.ref = ref
    self.projectRef = projectRef
    self.projectTitle = projectTitle
    self.title = title
    self.activity = activity
    self.preview = preview
    self.updatedAt = updatedAt
    self.activityAt = activityAt ?? updatedAt
    self.identity = identity
    self.waitsOnUser = waitsOnUser
    self.workStartedAt = workStartedAt
    self.isPinned = isPinned
    self.isResolved = isResolved
    self.isUnread = isUnread
    self.machineLabel = machineLabel
    self.machineOnline = machineOnline
    self.planProgress = planProgress
    self.placement = placement ?? ThreadPlacement(owner: MachineNickname.shortName(machineLabel))
  }

  /// Its machine is unreachable, so its activity is the last known one.
  public var isUnknown: Bool { placement.unknown != nil }
}

public struct PlanProgress: Hashable, Sendable {
  public var completed: Int
  public var total: Int
  public init(completed: Int, total: Int) {
    self.completed = completed
    self.total = total
  }
}

public enum ThreadAction: Sendable, Hashable {
  case pin, unpin, resolve, unresolve, archive, delete, markUnread
  case rename(String)
}

// MARK: - Transcript

public struct TodoStep: Hashable, Sendable, Identifiable {
  public enum Status: String, Sendable { case pending, running, completed }
  public let id: String
  public var text: String
  public var status: Status
  public init(id: String, text: String, status: Status) {
    self.id = id
    self.text = text
    self.status = status
  }
}

public enum ToolStatus: String, Sendable { case running, completed, failed }

/// Where a message you sent stands.
public enum UserMessageState: String, Hashable, Sendable {
  /// The machine has it and its run started or finished.
  case sent
  /// On its way to the machine.
  case sending
  /// Waits for the active run to finish.
  case queued
  /// Queued behind a stop or a restart; it runs once the queue is resumed.
  case held
}

public struct TranscriptRow: Identifiable, Hashable, Sendable {
  public enum Kind: Hashable, Sendable {
    case user(text: String, state: UserMessageState = .sent)
    case assistant(markdown: String, streaming: Bool)
    /// `seconds` is how long a settled thought took; nil when it was not measured.
    case reasoning(text: String, streaming: Bool, seconds: Int? = nil)
    /// A command, file change, search or other tool call.
    case tool(title: String, detail: String?, symbol: String, status: ToolStatus)
    case plan(steps: [TodoStep])
    case proposedPlan(markdown: String)
    case approval(requestId: String, prompt: String, resolved: Bool)
    case question(requestId: String, prompt: String, resolved: Bool)
    case subagent(title: String, child: ThreadRef?)
    case error(message: String)
    case notice(text: String)
  }

  public let id: String
  public var kind: Kind

  public init(id: String, kind: Kind) {
    self.id = id
    self.kind = kind
  }
}

public enum ApprovalDecision: String, Sendable { case approve, approveForSession, deny }

/// One open conversation. The engine keeps it current while the view is visible.
@MainActor @Observable
public final class ChatSession: Identifiable {
  public nonisolated let id: ChatTarget
  public var title: String
  /// e.g. "Coordinator · M4" or "Thread · 2 artifacts"
  public var subtitle: String
  public var rows: [TranscriptRow] = []
  /// True from the moment the first cached or live data arrives.
  public var isLoaded = false
  /// Content came from the disk cache and is not live yet. Stop and queue stay disabled.
  public var isStale = false
  public var isRunning = false
  public var queuedCount = 0
  public var plan: PlanProgress?
  public var machineLabel: String
  public var machineOnline: Bool
  /// When set, the composer is disabled and shows this reason.
  public var sendBlockedReason: String?
  /// Last send error, shown inline above the composer.
  public var lastError: String?
  /// The conversation could not be loaded; `AppEngine.reload` tries again.
  public var loadError: String?

  public init(id: ChatTarget, title: String, subtitle: String, machineLabel: String, machineOnline: Bool) {
    self.id = id
    self.title = title
    self.subtitle = subtitle
    self.machineLabel = machineLabel
    self.machineOnline = machineOnline
  }
}

// MARK: - Settings

public struct ProjectSettingsDraft: Hashable, Sendable {
  public var title: String
  public var goal: String
  public var instructions: String
  public var paused: Bool
  public var archived: Bool
  /// Display name of the coordinator model, read only in v1.
  public var coordinatorModel: String?
  /// Optimistic-concurrency revision from the last read.
  public var revision: Int

  public init(title: String, goal: String, instructions: String, paused: Bool, archived: Bool, coordinatorModel: String?, revision: Int) {
    self.title = title
    self.goal = goal
    self.instructions = instructions
    self.paused = paused
    self.archived = archived
    self.coordinatorModel = coordinatorModel
    self.revision = revision
  }
}

public enum AppearancePreference: String, Sendable, CaseIterable, Codable {
  case system, light, dark
  public var label: String {
    switch self {
    case .system: "System"
    case .light: "Light"
    case .dark: "Dark"
    }
  }
}

public enum RuntimeModeChoice: String, Sendable, CaseIterable {
  case approvalRequired = "approval-required"
  case autoAcceptEdits = "auto-accept-edits"
  case auto
  case fullAccess = "full-access"

  public var label: String {
    switch self {
    case .approvalRequired: "Ask before changes"
    case .autoAcceptEdits: "Accept edits"
    case .auto: "Auto"
    case .fullAccess: "Full access"
    }
  }
}

/// Settings that live on one machine's server.
public struct MachineSettings: Hashable, Sendable {
  public var defaultRuntimeMode: RuntimeModeChoice?
  public var defaultModel: String?
  public init(defaultRuntimeMode: RuntimeModeChoice?, defaultModel: String?) {
    self.defaultRuntimeMode = defaultRuntimeMode
    self.defaultModel = defaultModel
  }
}

// MARK: - Engine

/// Everything that talks to machines. Methods throw `ServerError`-style errors
/// with user-readable `localizedDescription`.
@MainActor
public protocol AppEngine: AnyObject {
  /// Called once. The engine keeps `model` current from then on.
  func start(model: AppModel)
  /// The app came to the foreground or went to the background.
  func setActive(_ active: Bool)

  func pair(link: String) async throws -> MachineSummary
  /// "Pair again" on a known machine: a link to another machine fails before
  /// its one-time code is spent.
  func pair(link: String, expectedEnvironmentId: String?) async throws -> MachineSummary
  func removeMachine(id: String)
  /// Tries again now, closing a live connection first.
  func reconnect(machineId: String)
  /// Skips the rest of a dropped connection's backoff. A live connection,
  /// an attempt in flight and pairings that need the person are left alone.
  func wake(machineId: String)

  /// Opens a live conversation. The engine fills and updates the session until `close`.
  func open(_ session: ChatSession)
  func close(_ session: ChatSession)
  /// Loads an open conversation again after `loadError`.
  func reload(_ session: ChatSession)
  func send(_ text: String, to target: ChatTarget) async throws
  /// Stops the active run and holds the queue.
  func stop(_ target: ChatTarget) async throws
  func respond(to requestId: String, in target: ChatTarget, decision: ApprovalDecision) async throws

  func perform(_ action: ThreadAction, on thread: ThreadRef) async throws
  func handoffOptions(for thread: ThreadRef) async throws -> HandoffOptions
  func checkHandoff(_ thread: ThreadRef, destination: HandoffDestination) async throws -> HandoffCheck
  func continueThread(_ thread: ThreadRef, destination: HandoffDestination) async throws -> ThreadRef
  func incrementProgress(for target: ChatTarget) async throws -> IncrementRead
  func setupAide() async throws -> ProjectRef

  func loadProjectSettings(_ project: ProjectRef) async throws -> ProjectSettingsDraft
  func saveProjectSettings(_ draft: ProjectSettingsDraft, for project: ProjectRef) async throws
  func loadMachineSettings(_ machineId: String) async throws -> MachineSettings
  func saveMachineSettings(_ settings: MachineSettings, for machineId: String) async throws

  /// Signs in to SpecWithCode Connect and adds the account's computers.
  func connectSignIn(with method: ConnectSignInMethod) async throws
  /// Signs out and forgets the computers that came from the account.
  func connectSignOut() async
  /// Deletes the SpecWithCode account, then signs out.
  func connectDeleteAccount() async throws
  /// Lists the account's computers again.
  func connectRefresh() async
  /// Hands over the APNs device token so the relay can send notifications.
  func connectSetPushToken(_ token: Data)

  /// A fresh ticket for watching a device on a machine's device hub. Each
  /// (re)connect of the viewer asks again; a ticket lives five minutes.
  func deviceHubAccess(machineId: String, hostId: String) async throws -> DeviceHubAccess
}

extension AppEngine {
  public func incrementProgress(for target: ChatTarget) async throws -> IncrementRead {
    .unavailable("SpecWeave increment progress is unavailable in this connection.")
  }

  public func handoffOptions(for thread: ThreadRef) async throws -> HandoffOptions {
    throw SyncError.sendBlocked("Handoff is unavailable on this machine.")
  }
  public func checkHandoff(_ thread: ThreadRef, destination: HandoffDestination) async throws -> HandoffCheck {
    throw SyncError.sendBlocked("Handoff is unavailable on this machine.")
  }
  public func continueThread(_ thread: ThreadRef, destination: HandoffDestination) async throws -> ThreadRef {
    throw SyncError.sendBlocked("Handoff is unavailable on this machine.")
  }

  public func pair(link: String, expectedEnvironmentId: String?) async throws -> MachineSummary {
    try await pair(link: link)
  }

  public func wake(machineId: String) {
    reconnect(machineId: machineId)
  }

  public func reload(_ session: ChatSession) {
    close(session)
    open(session)
  }

  public func connectSignIn(with method: ConnectSignInMethod) async throws {}
  public func connectSignOut() async {}
  public func connectDeleteAccount() async throws {}
  public func connectRefresh() async {}
  public func connectSetPushToken(_ token: Data) {}

  public func deviceHubAccess(machineId: String, hostId: String) async throws -> DeviceHubAccess {
    throw SyncError.sendBlocked(MachineDevices.unsupportedMessage)
  }
}

/// Everything the UI shows outside an open conversation.
@MainActor @Observable
public final class AppModel {
  public var machines: [MachineSummary] = []
  /// The personal assistant project, if one exists on any machine.
  public var aide: ProjectSummary?
  /// Code projects across machines, pinned first, then by title.
  public var projects: [ProjectSummary] = []
  /// Threads by project.
  public var threadsByProject: [ProjectRef: [ThreadSummary]] = [:]
  /// Most recent top-level threads across machines, pinned first.
  public var recentThreads: [ThreadSummary] = []
  /// True until every enabled machine has answered once (or failed).
  public var isLoading = true
  /// False while a paired machine's projects and threads have not arrived
  /// yet, so a missing Aide or project may only be missing for now.
  public var allShellsLoaded = true
  /// SpecWithCode Connect, nil when this build has no Connect configuration.
  public var connect: ConnectState?
  /// Open simulators and emulators by machine; missing until a machine answers.
  public var devices: [String: MachineDevices] = [:]
  public var appearance: AppearancePreference {
    didSet { UserDefaults.standard.set(appearance.rawValue, forKey: "appearance") }
  }

  @ObservationIgnored public let engine: AppEngine
  @ObservationIgnored private var sessions: [ChatTarget: ChatSession] = [:]
  @ObservationIgnored private var sessionViewers: [ChatTarget: Int] = [:]

  public init(engine: AppEngine) {
    self.engine = engine
    self.appearance = UserDefaults.standard.string(forKey: "appearance").flatMap(AppearancePreference.init) ?? .system
    engine.start(model: self)
  }

  public var pinnedProjects: [ProjectSummary] { projects.filter { $0.isPinned && !$0.archived && !$0.isAutomated } }
  public var otherProjects: [ProjectSummary] { projects.filter { !$0.isPinned && !$0.archived && !$0.isAutomated } }
  /// Projects checks and agents made for themselves, listed apart under "Automated".
  public var automatedProjects: [ProjectSummary] { projects.filter { $0.isAutomated && !$0.archived } }

  public var archivedProjects: [ProjectSummary] { projects.filter(\.archived) }

  public func machine(_ id: String) -> MachineSummary? { machines.first { $0.id == id } }

  /// The project row for a project or any machine's copy of it.
  public func project(_ ref: ProjectRef) -> ProjectSummary? {
    if aide?.ref == ref { return aide }
    return projects.first { $0.ref == ref } ?? projects.first { $0.contains(ref) }
  }

  public func threads(in project: ProjectRef) -> [ThreadSummary] {
    threadsByProject[project] ?? self.project(project).flatMap { threadsByProject[$0.ref] } ?? []
  }

  /// The devices a thread has open on its machine.
  public func deviceSessions(for thread: ThreadRef) -> [DeviceSessionSummary] {
    devices[thread.environmentId]?.sessions(forThread: thread.threadId) ?? []
  }

  public func thread(_ ref: ThreadRef) -> ThreadSummary? {
    for list in threadsByProject.values { if let t = list.first(where: { $0.ref == ref }) { return t } }
    return recentThreads.first { $0.ref == ref }
  }

  /// A view showing a chat calls this on appear. The same chat can be on
  /// screen twice (the root and a pushed copy), and SwiftUI may run one's
  /// disappear after the other's appear, so viewers are counted.
  public func openSession(_ session: ChatSession) {
    sessionViewers[session.id, default: 0] += 1
    engine.open(session)
  }

  /// The engine stops following a chat only when its last viewer goes.
  public func closeSession(_ session: ChatSession) {
    let remaining = (sessionViewers[session.id] ?? 1) - 1
    sessionViewers[session.id] = remaining > 0 ? remaining : nil
    if remaining <= 0 { engine.close(session) }
  }

  /// The shared session for a target; views call `openSession` on appear.
  public func session(for target: ChatTarget) -> ChatSession {
    if let s = sessions[target] { return s }
    let s: ChatSession
    switch target {
    case let .aide(p), let .project(p):
      let summary = project(p)
      let machine = machine(p.environmentId)
      s = ChatSession(id: target, title: summary?.title ?? "Project", subtitle: "Coordinator · \(machine?.displayName ?? "machine")", machineLabel: machine?.displayName ?? "", machineOnline: machine?.status.isOnline ?? false)
    case let .thread(t):
      let summary = thread(t)
      let machine = machine(t.environmentId)
      s = ChatSession(id: target, title: summary?.title ?? "Thread", subtitle: summary?.projectTitle ?? "Thread", machineLabel: machine?.displayName ?? "", machineOnline: machine?.status.isOnline ?? false)
    }
    sessions[target] = s
    return s
  }
}
