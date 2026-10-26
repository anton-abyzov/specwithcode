import Foundation

/// A project as the shell sends it. `projects.mutate` returns the same shape plus `deletedAt`.
///
/// `createdAt`, `updatedAt` and `deletedAt` are free-form ISO strings on the wire,
/// kept as sent; use the `...Date` accessors to read them.
public struct ProjectShell: Codable, Hashable, Sendable, Identifiable {
  public var id: String
  public var title: String
  public var workspaceRoot: String
  public var repositoryIdentity: RepositoryIdentity?
  public var defaultModelSelection: ModelSelection?
  public var defaultThreadEnvMode: ThreadEnvMode?
  public var autoPull: Bool?
  public var faviconPath: String?
  public var projectIcon: ProjectIconOverride?
  /// Omitted by the server when the project has none.
  public var workspaceSettings: ProjectWorkspaceSettings?
  public var scripts: [ProjectScript]
  public var createdAt: String
  public var updatedAt: String
  public var deletedAt: String?

  enum CodingKeys: String, CodingKey {
    case id, title, workspaceRoot, repositoryIdentity, defaultModelSelection, defaultThreadEnvMode, autoPull
    case faviconPath, projectIcon, workspaceSettings, scripts, createdAt, updatedAt, deletedAt
  }

  public init(id: String, title: String, workspaceRoot: String, repositoryIdentity: RepositoryIdentity? = nil, defaultModelSelection: ModelSelection? = nil, defaultThreadEnvMode: ThreadEnvMode? = nil, autoPull: Bool? = nil, faviconPath: String? = nil, projectIcon: ProjectIconOverride? = nil, workspaceSettings: ProjectWorkspaceSettings? = nil, scripts: [ProjectScript] = [], createdAt: String, updatedAt: String, deletedAt: String? = nil) {
    self.id = id
    self.title = title
    self.workspaceRoot = workspaceRoot
    self.repositoryIdentity = repositoryIdentity
    self.defaultModelSelection = defaultModelSelection
    self.defaultThreadEnvMode = defaultThreadEnvMode
    self.autoPull = autoPull
    self.faviconPath = faviconPath
    self.projectIcon = projectIcon
    self.workspaceSettings = workspaceSettings
    self.scripts = scripts
    self.createdAt = createdAt
    self.updatedAt = updatedAt
    self.deletedAt = deletedAt
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    title = try c.decode(String.self, forKey: .title)
    workspaceRoot = try c.decode(String.self, forKey: .workspaceRoot)
    repositoryIdentity = try? c.decodeIfPresent(RepositoryIdentity.self, forKey: .repositoryIdentity)
    defaultModelSelection = try c.decodeIfPresent(ModelSelection.self, forKey: .defaultModelSelection)
    defaultThreadEnvMode = try c.decodeIfPresent(ThreadEnvMode.self, forKey: .defaultThreadEnvMode)
    autoPull = try c.decodeIfPresent(Bool.self, forKey: .autoPull)
    faviconPath = try c.decodeIfPresent(String.self, forKey: .faviconPath)
    projectIcon = try c.decodeIfPresent(ProjectIconOverride.self, forKey: .projectIcon)
    workspaceSettings = try c.decodeIfPresent(ProjectWorkspaceSettings.self, forKey: .workspaceSettings)
    scripts = try c.decodeLossyArray(ProjectScript.self, forKey: .scripts)
    createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt) ?? ""
    updatedAt = try c.decodeIfPresent(String.self, forKey: .updatedAt) ?? ""
    deletedAt = try c.decodeIfPresent(String.self, forKey: .deletedAt)
  }

  public var kind: WorkspaceKind { workspaceSettings?.kind ?? .code }
  public var isPersonal: Bool { kind == .personal }
  public var isPaused: Bool { workspaceSettings?.paused ?? false }
  public var isArchived: Bool { workspaceSettings?.archived ?? false }

  /// The coordinator thread: the stored id, or `project-coordinator:<id>` when none is set.
  public var coordinatorThreadId: String {
    workspaceSettings?.coordinatorThreadId ?? ProjectShell.defaultCoordinatorThreadId(projectId: id)
  }

  /// The logical project title when the project belongs to one.
  public var displayTitle: String { workspaceSettings?.logicalProject?.title ?? title }

  public var createdDate: Date? { WireCoding.parseDate(createdAt) }
  public var updatedDate: Date? { WireCoding.parseDate(updatedAt) }

  public static func defaultCoordinatorThreadId(projectId: String) -> String {
    "project-coordinator:\(projectId)"
  }
}

/// A project's chosen icon. A kind from a newer server decodes as `.unknown`;
/// show the default icon for it.
public enum ProjectIconOverride: Codable, Hashable, Sendable {
  /// A Lucide icon name such as `concierge-bell` and a palette color such as `violet`.
  case lucide(name: String, color: String)
  case emoji(String)
  case monogram(text: String, color: String)
  case unknown(JSONValue)

  enum CodingKeys: String, CodingKey { case kind, name, color, emoji, text, monogramText, monogram }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    let kind = try c.decodeIfPresent(String.self, forKey: .kind)
    switch kind {
    case "lucide":
      let color = try c.decodeIfPresent(String.self, forKey: .color) ?? "gray"
      // Older servers sent a monogram as a lucide icon carrying its text.
      if let text = try c.decodeIfPresent(String.self, forKey: .monogramText) ?? c.decodeIfPresent(String.self, forKey: .monogram) {
        self = .monogram(text: text, color: color)
      } else {
        self = .lucide(name: try c.decode(String.self, forKey: .name), color: color)
      }
    case "emoji":
      self = .emoji(try c.decode(String.self, forKey: .emoji))
    case "monogram":
      self = .monogram(text: try c.decode(String.self, forKey: .text), color: try c.decodeIfPresent(String.self, forKey: .color) ?? "gray")
    default:
      self = .unknown(try JSONValue(from: decoder))
    }
  }

  public func encode(to encoder: Encoder) throws {
    if case let .unknown(raw) = self {
      try raw.encode(to: encoder)
      return
    }
    var c = encoder.container(keyedBy: CodingKeys.self)
    switch self {
    case let .lucide(name, color):
      try c.encode("lucide", forKey: .kind)
      try c.encode(name, forKey: .name)
      try c.encode(color, forKey: .color)
    case let .emoji(emoji):
      try c.encode("emoji", forKey: .kind)
      try c.encode(emoji, forKey: .emoji)
    case let .monogram(text, color):
      try c.encode("monogram", forKey: .kind)
      try c.encode(text, forKey: .text)
      try c.encode(color, forKey: .color)
    case .unknown:
      break
    }
  }

  /// The icon a new personal assistant starts with.
  public static let personalAssistant = ProjectIconOverride.lucide(name: "concierge-bell", color: "violet")
}

/// Settings of a project's workspace: kind, goal, instructions and its coordinator.
public struct ProjectWorkspaceSettings: Codable, Hashable, Sendable {
  public var logicalProject: LogicalProject?
  public var coordinatorBinding: CoordinatorBinding?
  public var kind: WorkspaceKind
  public var environment: ProjectEnvironment
  /// Optimistic-concurrency revision; send it back as `expectedRevision`.
  public var revision: Int
  public var goal: String
  public var instructions: String
  public var coordinatorModelSelection: ModelSelection?
  /// Null means `project-coordinator:<projectId>`.
  public var coordinatorThreadId: String?
  public var paused: Bool
  public var archived: Bool
  public var autoResume: Bool
  public var workerMachine: WorkerMachine?
  public var temporarySessionId: String?
  /// "automated" for a project a check made for itself; absent on older projects.
  public var origin: ProjectOrigin?

  enum CodingKeys: String, CodingKey {
    case logicalProject, coordinatorBinding, kind, environment, revision, goal, instructions
    case coordinatorModelSelection, coordinatorThreadId, paused, archived, autoResume, workerMachine, temporarySessionId, origin
  }

  public init(kind: WorkspaceKind = .code, environment: ProjectEnvironment = ProjectEnvironment(), revision: Int = 0, goal: String = "", instructions: String = "", coordinatorModelSelection: ModelSelection? = nil, coordinatorThreadId: String? = nil, paused: Bool = false, archived: Bool = false, autoResume: Bool = false, logicalProject: LogicalProject? = nil, coordinatorBinding: CoordinatorBinding? = nil, workerMachine: WorkerMachine? = nil, temporarySessionId: String? = nil, origin: ProjectOrigin? = nil) {
    self.kind = kind
    self.environment = environment
    self.revision = revision
    self.goal = goal
    self.instructions = instructions
    self.coordinatorModelSelection = coordinatorModelSelection
    self.coordinatorThreadId = coordinatorThreadId
    self.paused = paused
    self.archived = archived
    self.autoResume = autoResume
    self.logicalProject = logicalProject
    self.coordinatorBinding = coordinatorBinding
    self.workerMachine = workerMachine
    self.temporarySessionId = temporarySessionId
    self.origin = origin
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    logicalProject = try? c.decodeIfPresent(LogicalProject.self, forKey: .logicalProject)
    coordinatorBinding = try? c.decodeIfPresent(CoordinatorBinding.self, forKey: .coordinatorBinding)
    kind = try c.decodeIfPresent(WorkspaceKind.self, forKey: .kind) ?? .code
    environment = (try? c.decodeIfPresent(ProjectEnvironment.self, forKey: .environment)) ?? ProjectEnvironment()
    revision = try c.decode(Int.self, forKey: .revision)
    goal = try c.decodeIfPresent(String.self, forKey: .goal) ?? ""
    instructions = try c.decodeIfPresent(String.self, forKey: .instructions) ?? ""
    coordinatorModelSelection = try c.decodeIfPresent(ModelSelection.self, forKey: .coordinatorModelSelection)
    coordinatorThreadId = try c.decodeIfPresent(String.self, forKey: .coordinatorThreadId)
    paused = try c.decodeIfPresent(Bool.self, forKey: .paused) ?? false
    archived = try c.decodeIfPresent(Bool.self, forKey: .archived) ?? false
    autoResume = try c.decodeIfPresent(Bool.self, forKey: .autoResume) ?? false
    workerMachine = try? c.decodeIfPresent(WorkerMachine.self, forKey: .workerMachine)
    temporarySessionId = try c.decodeIfPresent(String.self, forKey: .temporarySessionId)
    // A value from a newer server reads as unset, so its folder decides.
    origin = try? c.decodeIfPresent(ProjectOrigin.self, forKey: .origin)
  }

  /// True while the coordinator is handing off to another machine.
  public var isCoordinatorFenced: Bool {
    guard let state = coordinatorBinding?.state else { return false }
    return state != .active
  }
}

public struct ProjectEnvironment: Codable, Hashable, Sendable {
  public var additionalFolders: [String]
  public var repositories: [ProjectRepository]

  public init(additionalFolders: [String] = [], repositories: [ProjectRepository] = []) {
    self.additionalFolders = additionalFolders
    self.repositories = repositories
  }

  enum CodingKeys: String, CodingKey { case additionalFolders, repositories }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    additionalFolders = try c.decodeArray(String.self, forKey: .additionalFolders)
    repositories = try c.decodeLossyArray(ProjectRepository.self, forKey: .repositories)
  }
}

public struct ProjectRepository: Codable, Hashable, Sendable, Identifiable {
  public var id: String
  public var url: String
  public var localPath: String?

  public init(id: String, url: String, localPath: String? = nil) {
    self.id = id
    self.url = url
    self.localPath = localPath
  }
}

/// A project's identity across machines.
public struct LogicalProject: Codable, Hashable, Sendable {
  public var id: String
  public var title: String
  public var coordinatorId: String
  public var members: [LogicalProjectMember]

  public init(id: String, title: String, coordinatorId: String, members: [LogicalProjectMember] = []) {
    self.id = id
    self.title = title
    self.coordinatorId = coordinatorId
    self.members = members
  }
}

public struct LogicalProjectMember: Codable, Hashable, Sendable {
  public var environmentId: String
  public var projectId: String
  public var coordinatorThreadId: String

  public init(environmentId: String, projectId: String, coordinatorThreadId: String) {
    self.environmentId = environmentId
    self.projectId = projectId
    self.coordinatorThreadId = coordinatorThreadId
  }
}

public struct CoordinatorBinding: Codable, Hashable, Sendable {
  public var epoch: Int
  public var state: CoordinatorBindingState
  public var operationId: String?
  public var predecessor: LogicalProjectMember?
  public var successor: LogicalProjectMember?

  public init(epoch: Int, state: CoordinatorBindingState, operationId: String? = nil, predecessor: LogicalProjectMember? = nil, successor: LogicalProjectMember? = nil) {
    self.epoch = epoch
    self.state = state
    self.operationId = operationId
    self.predecessor = predecessor
    self.successor = successor
  }
}

/// Another of the user's machines the coordinator starts its workers on.
public struct WorkerMachine: Codable, Hashable, Sendable {
  public var machineId: String
  public var environmentId: String
  public var projectId: String?

  public init(machineId: String, environmentId: String, projectId: String? = nil) {
    self.machineId = machineId
    self.environmentId = environmentId
    self.projectId = projectId
  }
}

public struct ProjectScript: Codable, Hashable, Sendable, Identifiable {
  public var id: String
  public var name: String
  public var command: String
  /// `play`, `test`, `lint`, `configure`, `build` or `debug`.
  public var icon: String
  public var runOnWorktreeCreate: Bool

  public init(id: String, name: String, command: String, icon: String = "play", runOnWorktreeCreate: Bool = false) {
    self.id = id
    self.name = name
    self.command = command
    self.icon = icon
    self.runOnWorktreeCreate = runOnWorktreeCreate
  }

  enum CodingKeys: String, CodingKey { case id, name, command, icon, runOnWorktreeCreate }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    name = try c.decodeIfPresent(String.self, forKey: .name) ?? id
    command = try c.decodeIfPresent(String.self, forKey: .command) ?? ""
    icon = try c.decodeIfPresent(String.self, forKey: .icon) ?? "play"
    runOnWorktreeCreate = try c.decodeIfPresent(Bool.self, forKey: .runOnWorktreeCreate) ?? false
  }
}

/// The git repository a project's checkout belongs to.
public struct RepositoryIdentity: Codable, Hashable, Sendable {
  public struct Locator: Codable, Hashable, Sendable {
    public var source: String
    public var remoteName: String
    public var remoteUrl: String
  }

  /// The checkout's own `origin` remote, sent when it names a different
  /// repository than `canonicalKey` (which follows `upstream`), as for a fork.
  public struct Origin: Codable, Hashable, Sendable {
    public var canonicalKey: String
    public var displayName: String?

    public init(canonicalKey: String, displayName: String? = nil) {
      self.canonicalKey = canonicalKey
      self.displayName = displayName
    }
  }

  public var canonicalKey: String
  public var locator: Locator?
  public var webUrl: String?
  public var rootPath: String?
  public var displayName: String?
  public var provider: String?
  public var owner: String?
  public var name: String?
  public var origin: Origin?

  /// The key clients group checkouts by, as `repositoryGroupingKeyOf` in contracts:
  /// the checkout's own remote, so a fork stays apart from the repository it forked.
  public var groupingKey: String { origin?.canonicalKey ?? canonicalKey }

  /// The repository's label, matching `groupingKey` (`repositoryGroupingDisplayNameOf`).
  public var groupingDisplayName: String? {
    origin.map { $0.displayName ?? $0.canonicalKey } ?? displayName
  }

  public init(canonicalKey: String, displayName: String? = nil, owner: String? = nil, name: String? = nil, webUrl: String? = nil) {
    self.canonicalKey = canonicalKey
    self.displayName = displayName
    self.owner = owner
    self.name = name
    self.webUrl = webUrl
  }
}

// MARK: - Project RPC payloads

/// `projects.coordinatorSend`: a message for the project's coordinator.
public struct CoordinatorSendInput: Codable, Hashable, Sendable {
  public var projectId: String
  public var commandId: String
  /// At most 32,000 characters.
  public var prompt: String
  public var attachments: [ChatAttachment]?
  public var sourceThreadId: String?

  public init(projectId: String, commandId: String, prompt: String, attachments: [ChatAttachment]? = nil, sourceThreadId: String? = nil) {
    self.projectId = projectId
    self.commandId = commandId
    self.prompt = prompt
    self.attachments = attachments
    self.sourceThreadId = sourceThreadId
  }
}

/// `projects.coordinatorStart`: makes sure the coordinator thread exists, optionally with a prompt.
public struct CoordinatorStartInput: Codable, Hashable, Sendable {
  public var projectId: String
  public var commandId: String
  public var prompt: String?

  public init(projectId: String, commandId: String, prompt: String? = nil) {
    self.projectId = projectId
    self.commandId = commandId
    self.prompt = prompt
  }
}

/// Result of `projects.coordinatorSend` and `projects.coordinatorStart`.
public struct CoordinatorResult: Codable, Hashable, Sendable {
  public var threadId: String
  public var created: Bool

  public init(threadId: String, created: Bool) {
    self.threadId = threadId
    self.created = created
  }

  enum CodingKeys: String, CodingKey { case threadId, created }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    threadId = try c.decode(String.self, forKey: .threadId)
    created = try c.decodeIfPresent(Bool.self, forKey: .created) ?? false
  }
}

/// `projects.workspaceRead` payload.
public struct WorkspaceReadInput: Codable, Hashable, Sendable {
  public var projectId: String
  public init(projectId: String) { self.projectId = projectId }
}

/// `projects.workspaceRead` result: settings plus a summary of the project's memory files.
public struct WorkspaceReadResult: Codable, Hashable, Sendable {
  public struct Memory: Codable, Hashable, Sendable {
    public var files: [MemoryFile]
    public var totalBytes: Int

    public init(files: [MemoryFile] = [], totalBytes: Int = 0) {
      self.files = files
      self.totalBytes = totalBytes
    }

    enum CodingKeys: String, CodingKey { case files, totalBytes }

    public init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      files = try c.decodeLossyArray(MemoryFile.self, forKey: .files)
      totalBytes = try c.decodeIfPresent(Int.self, forKey: .totalBytes) ?? 0
    }
  }

  public struct MemoryFile: Codable, Hashable, Sendable {
    public var name: String
    public var revision: Int
    /// Free-form ISO string.
    public var updatedAt: String
    public var byteLength: Int

    public init(name: String, revision: Int, updatedAt: String, byteLength: Int) {
      self.name = name
      self.revision = revision
      self.updatedAt = updatedAt
      self.byteLength = byteLength
    }
  }

  public var settings: ProjectWorkspaceSettings
  public var memory: Memory

  public init(settings: ProjectWorkspaceSettings, memory: Memory = Memory()) {
    self.settings = settings
    self.memory = memory
  }

  enum CodingKeys: String, CodingKey { case settings, memory }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    settings = try c.decode(ProjectWorkspaceSettings.self, forKey: .settings)
    memory = try c.decodeIfPresent(Memory.self, forKey: .memory) ?? Memory()
  }
}

/// `project.update` patch of `workspaceSettings`. Only `expectedRevision` is required;
/// a stale revision fails with `ProjectWorkspaceError` code `conflict`.
public struct WorkspacePatch: Codable, Hashable, Sendable {
  public var expectedRevision: Int
  public var kind: WorkspaceKind?
  public var goal: String?
  public var instructions: String?
  public var coordinatorModelSelection: Nullable<ModelSelection>?
  public var paused: Bool?
  public var archived: Bool?
  public var autoResume: Bool?

  public init(expectedRevision: Int, kind: WorkspaceKind? = nil, goal: String? = nil, instructions: String? = nil, coordinatorModelSelection: Nullable<ModelSelection>? = nil, paused: Bool? = nil, archived: Bool? = nil, autoResume: Bool? = nil) {
    self.expectedRevision = expectedRevision
    self.kind = kind
    self.goal = goal
    self.instructions = instructions
    self.coordinatorModelSelection = coordinatorModelSelection
    self.paused = paused
    self.archived = archived
    self.autoResume = autoResume
  }

  enum CodingKeys: String, CodingKey { case expectedRevision, kind, goal, instructions, coordinatorModelSelection, paused, archived, autoResume }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    expectedRevision = try c.decode(Int.self, forKey: .expectedRevision)
    kind = try c.decodeIfPresent(WorkspaceKind.self, forKey: .kind)
    goal = try c.decodeIfPresent(String.self, forKey: .goal)
    instructions = try c.decodeIfPresent(String.self, forKey: .instructions)
    coordinatorModelSelection = try c.decodeNullable(ModelSelection.self, forKey: .coordinatorModelSelection)
    paused = try c.decodeIfPresent(Bool.self, forKey: .paused)
    archived = try c.decodeIfPresent(Bool.self, forKey: .archived)
    autoResume = try c.decodeIfPresent(Bool.self, forKey: .autoResume)
  }
}

/// `projects.mutate` with `type: "project.update"`. Returns the updated `ProjectShell`.
public struct ProjectUpdateCommand: Codable, Hashable, Sendable {
  public static let type = "project.update"

  public var commandId: String
  public var projectId: String
  public var title: String?
  public var workspaceSettings: WorkspacePatch?
  /// `.null` clears the icon back to the default.
  public var projectIcon: Nullable<ProjectIconOverride>?
  public var defaultModelSelection: Nullable<ModelSelection>?
  public var autoPull: Bool?

  public init(commandId: String, projectId: String, title: String? = nil, workspaceSettings: WorkspacePatch? = nil, projectIcon: Nullable<ProjectIconOverride>? = nil, defaultModelSelection: Nullable<ModelSelection>? = nil, autoPull: Bool? = nil) {
    self.commandId = commandId
    self.projectId = projectId
    self.title = title
    self.workspaceSettings = workspaceSettings
    self.projectIcon = projectIcon
    self.defaultModelSelection = defaultModelSelection
    self.autoPull = autoPull
  }

  enum CodingKeys: String, CodingKey { case type, commandId, projectId, title, workspaceSettings, projectIcon, defaultModelSelection, autoPull }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    let type = try c.decode(String.self, forKey: .type)
    guard type == Self.type else {
      throw DecodingError.dataCorruptedError(forKey: .type, in: c, debugDescription: "Expected \(Self.type), got \(type)")
    }
    commandId = try c.decode(String.self, forKey: .commandId)
    projectId = try c.decode(String.self, forKey: .projectId)
    title = try c.decodeIfPresent(String.self, forKey: .title)
    workspaceSettings = try c.decodeIfPresent(WorkspacePatch.self, forKey: .workspaceSettings)
    projectIcon = try c.decodeNullable(ProjectIconOverride.self, forKey: .projectIcon)
    defaultModelSelection = try c.decodeNullable(ModelSelection.self, forKey: .defaultModelSelection)
    autoPull = try c.decodeIfPresent(Bool.self, forKey: .autoPull)
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(Self.type, forKey: .type)
    try c.encode(commandId, forKey: .commandId)
    try c.encode(projectId, forKey: .projectId)
    try c.encodeIfPresent(title, forKey: .title)
    try c.encodeIfPresent(workspaceSettings, forKey: .workspaceSettings)
    try c.encodeIfPresent(projectIcon, forKey: .projectIcon)
    try c.encodeIfPresent(defaultModelSelection, forKey: .defaultModelSelection)
    try c.encodeIfPresent(autoPull, forKey: .autoPull)
  }
}

/// `projects.createNew`: a project in a new folder under the server's projects root.
/// With `kind: .personal` the server returns the existing assistant if there is one.
public struct CreateNewProjectInput: Codable, Hashable, Sendable {
  /// At most 200 characters.
  public var name: String
  public var kind: WorkspaceKind?
  public var parentPath: String?

  public init(name: String, kind: WorkspaceKind? = nil, parentPath: String? = nil) {
    self.name = name
    self.kind = kind
    self.parentPath = parentPath
  }
}

public struct CreateNewProjectResult: Codable, Hashable, Sendable {
  public var projectId: String
  public var workspaceRoot: String
  /// Why the first commit failed. The project exists either way.
  public var commitError: String?
  /// The folder was already a project and was used as is.
  public var existing: Bool?

  public init(projectId: String, workspaceRoot: String, commitError: String? = nil, existing: Bool? = nil) {
    self.projectId = projectId
    self.workspaceRoot = workspaceRoot
    self.commitError = commitError
    self.existing = existing
  }
}
