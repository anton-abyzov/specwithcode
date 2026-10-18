import Foundation
import SWCWire

// Port of packages/client-runtime/src/state/shellReducer.ts.

public enum ShellReducer {
  /// Merges a full shell snapshot into prior state.
  ///
  /// An authoritative snapshot (no `resolvedRepositoryIdentityRoots`) replaces
  /// structure and sequence, even when lower than what is held, but keeps a
  /// prior non-nil repository identity while the new one is still unresolved
  /// for the same workspace root.
  ///
  /// An enrichment snapshot (roots present) only patches `repositoryIdentity`
  /// on current projects. It never replaces projects, threads, archives or the
  /// sequence, whatever its own sequence is.
  public static func merge(_ previous: ShellSnapshot?, _ next: ShellSnapshot, resolvedRepositoryIdentityRoots roots: [String]? = nil) -> ShellSnapshot {
    guard let previous else { return next }

    if let roots {
      let resolved = Set(roots)
      var byId: [String: ProjectShell] = [:]
      for project in next.projects where byId[project.id] == nil { byId[project.id] = project }
      var merged = previous
      merged.projects = previous.projects.map { project in
        guard let candidate = byId[project.id], candidate.workspaceRoot == project.workspaceRoot else { return project }
        if resolved.contains(project.workspaceRoot) {
          var patched = project
          patched.repositoryIdentity = candidate.repositoryIdentity
          return patched
        }
        if project.repositoryIdentity == nil, candidate.repositoryIdentity != nil {
          var patched = project
          patched.repositoryIdentity = candidate.repositoryIdentity
          return patched
        }
        return project
      }
      return merged
    }

    var priorById: [String: ProjectShell] = [:]
    for project in previous.projects where priorById[project.id] == nil { priorById[project.id] = project }
    var merged = next
    merged.projects = next.projects.map { retainRepositoryIdentity(priorById[$0.id], $0) }
    return merged
  }

  /// Applies one committed delta, keeping a thread in at most one of the active
  /// and archived lists. Snapshots, `synchronized`, unknown kinds and items at or
  /// below the snapshot sequence leave the snapshot unchanged.
  public static func apply(_ item: ShellStreamItem, to snapshot: ShellSnapshot) -> ShellSnapshot {
    switch item {
    case .synchronized, .snapshot, .unknown:
      return snapshot

    case let .projectUpdated(sequence, project):
      guard sequence > snapshot.snapshotSequence else { return snapshot }
      // Enrichment is async: a mutation can land with a nil identity after an
      // earlier snapshot resolved it. Keep it for the same workspace root.
      let previous = snapshot.projects.first { $0.id == project.id }
      var next = snapshot
      next.projects = upsert(snapshot.projects, retainRepositoryIdentity(previous, project))
      next.snapshotSequence = sequence
      return next

    case let .projectRemoved(sequence, projectId):
      guard sequence > snapshot.snapshotSequence else { return snapshot }
      var next = snapshot
      next.projects.removeAll { $0.id == projectId }
      next.snapshotSequence = sequence
      return next

    case let .threadUpdated(sequence, location, thread):
      guard sequence > snapshot.snapshotSequence else { return snapshot }
      var next = snapshot
      next.snapshotSequence = sequence
      if location == .active, let existing = snapshot.threads.first(where: { $0.id == thread.id }), existing == thread {
        return next
      }
      if location == .active {
        next.threads = upsert(snapshot.threads, thread)
      } else {
        next.threads.removeAll { $0.id == thread.id }
      }
      // The archive has its own bounded query. Archive-located deltas are
      // dropped from the normal shell instead of growing it.
      next.archivedThreads.removeAll { $0.id == thread.id }
      return next

    case let .threadRemoved(sequence, _, threadId):
      guard sequence > snapshot.snapshotSequence else { return snapshot }
      var next = snapshot
      next.threads.removeAll { $0.id == threadId }
      next.archivedThreads.removeAll { $0.id == threadId }
      next.snapshotSequence = sequence
      return next
    }
  }

  static func retainRepositoryIdentity(_ previous: ProjectShell?, _ next: ProjectShell) -> ProjectShell {
    guard next.repositoryIdentity == nil, let previous, let identity = previous.repositoryIdentity,
          previous.workspaceRoot == next.workspaceRoot else { return next }
    var kept = next
    kept.repositoryIdentity = identity
    return kept
  }

  static func upsert<T: Identifiable>(_ items: [T], _ item: T) -> [T] {
    var next = items
    if let index = next.firstIndex(where: { $0.id == item.id }) {
      next[index] = item
    } else {
      next.append(item)
    }
    return next
  }
}

/// One machine's shell as the stream builds it.
public struct ShellState: Sendable, Hashable {
  public private(set) var snapshot: ShellSnapshot?
  /// Catch-up finished on the current subscription.
  public private(set) var isSynchronized = false

  public init(snapshot: ShellSnapshot? = nil) {
    self.snapshot = snapshot
  }

  /// The sequence to resume from, when a snapshot is held.
  public var resumeSequence: Int? { snapshot?.snapshotSequence }

  /// Call before subscribing again on a new socket.
  public mutating func beginSubscription() {
    isSynchronized = false
  }

  /// Applies one stream item. Returns true when the snapshot or the
  /// synchronized flag changed.
  @discardableResult
  public mutating func apply(_ item: ShellStreamItem) -> Bool {
    switch item {
    case .synchronized:
      defer { isSynchronized = true }
      return !isSynchronized
    case let .snapshot(next, roots):
      let merged = ShellReducer.merge(snapshot, next, resolvedRepositoryIdentityRoots: roots)
      defer { snapshot = merged }
      return merged != snapshot
    case .unknown:
      return false
    default:
      // Deltas before the first snapshot have nothing to apply to.
      guard let current = snapshot else { return false }
      let next = ShellReducer.apply(item, to: current)
      defer { snapshot = next }
      return next != current
    }
  }
}
