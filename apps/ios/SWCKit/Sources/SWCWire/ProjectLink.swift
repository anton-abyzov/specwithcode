import Foundation

/// `projectLink.*` methods the app calls for a project linked across machines.
/// The server's own names; the phone reuses what the desktop app calls.
public enum ProjectLinkMethod: String, Sendable, CaseIterable {
  /// `ProjectTakeoverInput` -> `ProjectTakeoverResult`. Settings write and operate.
  case takeover = "projectLink.takeover"
  /// `ProjectAcceptStandbyInput` -> result ignored. Settings write and operate.
  case acceptStandby = "projectLink.acceptStandby"
  /// `ProjectLinkSyncStatusInput` -> `ProjectLinkSyncStatus`. Orchestration read.
  case syncStatus = "projectLink.syncStatus"
}

/// Member machine, while the coordinator's machine is unreachable: make this
/// copy the coordinator at the next epoch, with the old one as predecessor.
public struct ProjectTakeoverInput: Codable, Hashable, Sendable {
  /// A lowercase v4 UUID; a retry reuses it.
  public var operationId: String
  public var projectId: String
  /// The highest epoch any copy is known at; the new one is above it.
  public var knownEpoch: Int?
  /// The coordinator being replaced, as the app last saw it.
  public var predecessor: LogicalProjectMember?

  public init(operationId: String, projectId: String, knownEpoch: Int? = nil, predecessor: LogicalProjectMember? = nil) {
    self.operationId = operationId
    self.projectId = projectId
    self.knownEpoch = knownEpoch
    self.predecessor = predecessor
  }
}

public struct ProjectTakeoverResult: Codable, Hashable, Sendable {
  public var operationId: String
  public var logicalProject: LogicalProject
  public var coordinatorBinding: CoordinatorBinding
  /// When the replica this copy started from was taken; nil without one.
  public var replicaFrom: String?
  public var replayed: Bool

  public init(operationId: String, logicalProject: LogicalProject, coordinatorBinding: CoordinatorBinding, replicaFrom: String? = nil, replayed: Bool = false) {
    self.operationId = operationId
    self.logicalProject = logicalProject
    self.coordinatorBinding = coordinatorBinding
    self.replicaFrom = replicaFrom
    self.replayed = replayed
  }

  enum CodingKeys: String, CodingKey { case operationId, logicalProject, coordinatorBinding, replicaFrom, replayed }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    operationId = try c.decode(String.self, forKey: .operationId)
    logicalProject = try c.decode(LogicalProject.self, forKey: .logicalProject)
    coordinatorBinding = try c.decode(CoordinatorBinding.self, forKey: .coordinatorBinding)
    replicaFrom = try c.decodeIfPresent(String.self, forKey: .replicaFrom)
    replayed = try c.decodeIfPresent(Bool.self, forKey: .replayed) ?? false
  }
}

/// Disarms a standby registered for an older coordinator after a person took
/// over, as the desktop does: `standby` is sent as an explicit null.
public struct ProjectStandbyDisarmInput: Encodable, Hashable, Sendable {
  public var projectId: String
  public var logicalProjectId: String
  /// Disarm only a registration below this epoch; a newer one stays.
  public var belowEpoch: Int

  public init(projectId: String, logicalProjectId: String, belowEpoch: Int) {
    self.projectId = projectId
    self.logicalProjectId = logicalProjectId
    self.belowEpoch = belowEpoch
  }

  enum CodingKeys: String, CodingKey { case projectId, logicalProjectId, standby, belowEpoch }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(projectId, forKey: .projectId)
    try c.encode(logicalProjectId, forKey: .logicalProjectId)
    try c.encodeNil(forKey: .standby)
    try c.encode(belowEpoch, forKey: .belowEpoch)
  }
}

public struct ProjectLinkSyncStatusInput: Codable, Hashable, Sendable {
  public var projectId: String
  public init(projectId: String) { self.projectId = projectId }
}

/// The pairs one server keeps in step for one of its copies, and its standby re-arm.
public struct ProjectLinkSyncStatus: Codable, Hashable, Sendable {
  public var pairs: [LinkedServerSyncPair]
  /// Absent from older servers, and where this copy has no re-arm consent or run.
  public var standbyRearm: ProjectStandbyRearmStatus?

  public init(pairs: [LinkedServerSyncPair] = [], standbyRearm: ProjectStandbyRearmStatus? = nil) {
    self.pairs = pairs
    self.standbyRearm = standbyRearm
  }

  enum CodingKeys: String, CodingKey { case pairs, standbyRearm }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    pairs = try c.decodeLossyArray(LinkedServerSyncPair.self, forKey: .pairs)
    standbyRearm = try? c.decodeIfPresent(ProjectStandbyRearmStatus.self, forKey: .standbyRearm)
  }
}

public struct LinkedServerSyncPair: Codable, Hashable, Sendable {
  public var peerEnvironmentId: String
  public var peerProjectId: String
  /// "replica", "memory", "plan" or "supersede".
  public var kind: String
  /// The end of the last pass that left this pair in step.
  public var lastSuccessAt: String?
  public var lastAttemptAt: String?
  /// Nil after a successful pass.
  public var lastError: String?

  public init(peerEnvironmentId: String, peerProjectId: String, kind: String, lastSuccessAt: String? = nil, lastAttemptAt: String? = nil, lastError: String? = nil) {
    self.peerEnvironmentId = peerEnvironmentId
    self.peerProjectId = peerProjectId
    self.kind = kind
    self.lastSuccessAt = lastSuccessAt
    self.lastAttemptAt = lastAttemptAt
    self.lastError = lastError
  }
}

/// This machine's standby re-arm for one copy.
public struct ProjectStandbyRearmStatus: Codable, Hashable, Sendable {
  public struct Consent: Codable, Hashable, Sendable {
    public var chainId: String
    public var members: [LogicalProjectMember]
    public var afterMinutes: Int

    public init(chainId: String, members: [LogicalProjectMember], afterMinutes: Int) {
      self.chainId = chainId
      self.members = members
      self.afterMinutes = afterMinutes
    }
  }

  public struct Run: Codable, Hashable, Sendable {
    /// "pending", "verifying", "armed" or "stopped".
    public var state: String
    /// Why re-arming has not finished, or stopped.
    public var reason: String?
    public var detail: String?
    public var standby: LogicalProjectMember?
    public var epoch: Int
    public var since: String?

    public init(state: String, reason: String? = nil, detail: String? = nil, standby: LogicalProjectMember? = nil, epoch: Int = 0, since: String? = nil) {
      self.state = state
      self.reason = reason
      self.detail = detail
      self.standby = standby
      self.epoch = epoch
      self.since = since
    }
  }

  public var consent: Consent?
  /// Only for the epoch this copy coordinates at now.
  public var run: Run?

  public init(consent: Consent? = nil, run: Run? = nil) {
    self.consent = consent
    self.run = run
  }

  enum CodingKeys: String, CodingKey { case consent, run }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    consent = try? c.decodeIfPresent(Consent.self, forKey: .consent)
    run = try? c.decodeIfPresent(Run.self, forKey: .run)
  }
}
