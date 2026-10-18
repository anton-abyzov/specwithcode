import Foundation

/// The machine's projects and thread rows. Sent first on `orchestration.subscribeShell`
/// and by `GET /api/orchestration/shell`.
public struct ShellSnapshot: Codable, Hashable, Sendable {
  public var schemaVersion: Int
  /// Stream items with `sequence <= snapshotSequence` are already applied.
  public var snapshotSequence: Int
  public var threads: [ThreadShell]
  public var archivedThreads: [ThreadShell]
  public var projects: [ProjectShell]

  public init(schemaVersion: Int = 1, snapshotSequence: Int = 0, threads: [ThreadShell] = [], archivedThreads: [ThreadShell] = [], projects: [ProjectShell] = []) {
    self.schemaVersion = schemaVersion
    self.snapshotSequence = snapshotSequence
    self.threads = threads
    self.archivedThreads = archivedThreads
    self.projects = projects
  }

  enum CodingKeys: String, CodingKey { case schemaVersion, snapshotSequence, threads, archivedThreads, projects }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    schemaVersion = try c.decodeIfPresent(Int.self, forKey: .schemaVersion) ?? 1
    snapshotSequence = try c.decode(Int.self, forKey: .snapshotSequence)
    threads = try c.decodeArray(ThreadShell.self, forKey: .threads)
    archivedThreads = try c.decodeArray(ThreadShell.self, forKey: .archivedThreads)
    projects = try c.decodeArray(ProjectShell.self, forKey: .projects)
  }
}

/// One value of the `orchestration.subscribeShell` stream.
public enum ShellStreamItem: Codable, Hashable, Sendable {
  /// Initial catch-up is done; live updates follow.
  case synchronized
  /// A full snapshot. With `resolvedRepositoryIdentityRoots` it is a metadata patch
  /// for those roots, never a replacement.
  case snapshot(ShellSnapshot, resolvedRepositoryIdentityRoots: [String]?)
  case projectUpdated(sequence: Int, project: ProjectShell)
  case projectRemoved(sequence: Int, projectId: String)
  case threadUpdated(sequence: Int, location: ThreadLocation, thread: ThreadShell)
  case threadRemoved(sequence: Int, location: ThreadLocation, threadId: String)
  /// A kind this build does not know. Skip it.
  case unknown(kind: String, raw: JSONValue)

  enum CodingKeys: String, CodingKey {
    case kind, snapshot, resolvedRepositoryIdentityRoots, sequence, project, projectId, location, thread, threadId
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    let kind = try c.decode(String.self, forKey: .kind)
    switch kind {
    case "synchronized":
      self = .synchronized
    case "snapshot":
      self = .snapshot(
        try c.decode(ShellSnapshot.self, forKey: .snapshot),
        resolvedRepositoryIdentityRoots: try c.decodeIfPresent([String].self, forKey: .resolvedRepositoryIdentityRoots))
    case "project.updated":
      self = .projectUpdated(sequence: try c.decode(Int.self, forKey: .sequence), project: try c.decode(ProjectShell.self, forKey: .project))
    case "project.removed":
      self = .projectRemoved(sequence: try c.decode(Int.self, forKey: .sequence), projectId: try c.decode(String.self, forKey: .projectId))
    case "thread.updated":
      self = .threadUpdated(
        sequence: try c.decode(Int.self, forKey: .sequence),
        location: try c.decodeIfPresent(ThreadLocation.self, forKey: .location) ?? .active,
        thread: try c.decode(ThreadShell.self, forKey: .thread))
    case "thread.removed":
      self = .threadRemoved(
        sequence: try c.decode(Int.self, forKey: .sequence),
        location: try c.decodeIfPresent(ThreadLocation.self, forKey: .location) ?? .active,
        threadId: try c.decode(String.self, forKey: .threadId))
    default:
      self = .unknown(kind: kind, raw: try JSONValue(from: decoder))
    }
  }

  public func encode(to encoder: Encoder) throws {
    if case let .unknown(_, raw) = self {
      try raw.encode(to: encoder)
      return
    }
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(kind, forKey: .kind)
    switch self {
    case .synchronized, .unknown:
      break
    case let .snapshot(snapshot, roots):
      try c.encode(snapshot, forKey: .snapshot)
      try c.encodeIfPresent(roots, forKey: .resolvedRepositoryIdentityRoots)
    case let .projectUpdated(sequence, project):
      try c.encode(sequence, forKey: .sequence)
      try c.encode(project, forKey: .project)
    case let .projectRemoved(sequence, projectId):
      try c.encode(sequence, forKey: .sequence)
      try c.encode(projectId, forKey: .projectId)
    case let .threadUpdated(sequence, location, thread):
      try c.encode(sequence, forKey: .sequence)
      try c.encode(location, forKey: .location)
      try c.encode(thread, forKey: .thread)
    case let .threadRemoved(sequence, location, threadId):
      try c.encode(sequence, forKey: .sequence)
      try c.encode(location, forKey: .location)
      try c.encode(threadId, forKey: .threadId)
    }
  }

  /// The wire `kind`.
  public var kind: String {
    switch self {
    case .synchronized: "synchronized"
    case .snapshot: "snapshot"
    case .projectUpdated: "project.updated"
    case .projectRemoved: "project.removed"
    case .threadUpdated: "thread.updated"
    case .threadRemoved: "thread.removed"
    case let .unknown(kind, _): kind
    }
  }

  /// The event sequence: the snapshot's for a snapshot, nil for `synchronized`.
  public var sequence: Int? {
    switch self {
    case .synchronized: nil
    case let .snapshot(snapshot, _): snapshot.snapshotSequence
    case let .projectUpdated(sequence, _), let .projectRemoved(sequence, _): sequence
    case let .threadUpdated(sequence, _, _), let .threadRemoved(sequence, _, _): sequence
    case let .unknown(_, raw): raw["sequence"]?.intValue
    }
  }
}
