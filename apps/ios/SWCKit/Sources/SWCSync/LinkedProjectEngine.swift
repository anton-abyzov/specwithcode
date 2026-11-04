import Foundation
import SWCWire

/// What the phone reads and does for a project linked across machines. An
/// engine adopts it beside `AppEngine`; views ask `model.engine as? LinkedProjectEngine`.
/// Every call reuses an RPC the desktop app already makes.
@MainActor
public protocol LinkedProjectEngine: AnyObject {
  /// Each linked copy in the project's row, from the machines' project lists
  /// (live or saved). Empty for a project on one machine.
  func linkedCopies(of project: ProjectRef, in model: AppModel) -> [LinkedProjectResolver.Copy]
  /// `projectLink.syncStatus` on the copy's machine.
  func linkSyncStatus(of copy: ProjectRef) async throws -> ProjectLinkSyncStatus
  /// `projectLink.takeover` on the copy's machine: it becomes the coordinator
  /// above every known epoch, with the unreachable one as predecessor.
  func takeOverCoordinator(at copy: ProjectRef, knownEpoch: Int, predecessor: LogicalProjectMember) async throws -> ProjectTakeoverResult
  /// `projectLink.acceptStandby` with no standby below `epoch`: a standby armed
  /// for the old coordinator never fires after a person took over.
  func disarmStaleStandby(at copy: ProjectRef, logicalProjectId: String, belowEpoch: Int) async
}

extension ShellSummaries.LinkedCopy: CoordinatorCandidate {
  var candidateKey: String { "\(summary.ref.environmentId):\(summary.ref.projectId)" }
  var candidateBinding: CoordinatorBinding? { project.workspaceSettings?.coordinatorBinding }
}

extension LiveEngine: LinkedProjectEngine {
  public func linkedCopies(of project: ProjectRef, in model: AppModel) -> [LinkedProjectResolver.Copy] {
    let summary = model.project(project)
    let refs = (summary.map { [$0.ref] + $0.members.map(\.ref) } ?? [project])
    var seen = Set<ProjectRef>()
    let nicknames = fleetNicknames
    return refs.compactMap { ref in
      guard seen.insert(ref).inserted, let entry = machines[ref.environmentId],
            let shell = (entry.snapshot ?? entry.cachedSnapshot)?.projects.first(where: { $0.id == ref.projectId }),
            let settings = shell.workspaceSettings, let logical = settings.logicalProject else { return nil }
      let capabilities = entry.config?.environment.capabilities
      let scopes = entry.permissions ?? []
      let mayChange = scopes.isEmpty || (scopes.contains("settings:write") && scopes.contains("orchestration:operate"))
      return LinkedProjectResolver.Copy(
        ref: ref,
        machineLabel: displayName(entry, nicknames: nicknames),
        machineOnline: entry.isOnline,
        machineSwitchedOff: !entry.record.enabled,
        // A cold start shows the last-seen time from before the app closed;
        // the machine is unreachable only once this launch's attempt failed
        // or the loading wait ran out.
        machineSettled: entry.isOnline || entry.answered || loadingDeadlinePassed,
        lastSeenAt: entry.lastSeenAt,
        logicalProjectId: logical.id,
        listedMembers: logical.members,
        coordinatorThreadId: settings.coordinatorThreadId,
        binding: settings.coordinatorBinding,
        // Unknown until the machine's config arrives; the call itself is checked there.
        canTakeOver: mayChange && (capabilities.map { $0.has("coordinatorTakeover") } ?? false),
        canRearm: capabilities?.has("coordinatorRearm") ?? false
      )
    }
  }

  public func linkSyncStatus(of copy: ProjectRef) async throws -> ProjectLinkSyncStatus {
    let payload = try JSONValue.from(ProjectLinkSyncStatusInput(projectId: copy.projectId))
    return try await withRetry(copy.environmentId) { socket in
      try await Self.decode(ProjectLinkSyncStatus.self, from: socket.call(tag: ProjectLinkMethod.syncStatus.rawValue, payload: payload))
    }
  }

  public func takeOverCoordinator(at copy: ProjectRef, knownEpoch: Int, predecessor: LogicalProjectMember) async throws -> ProjectTakeoverResult {
    // One operation id for every retry, so a repeat is replayed, not run twice.
    let input = ProjectTakeoverInput(operationId: Self.newId(), projectId: copy.projectId, knownEpoch: knownEpoch, predecessor: predecessor)
    let payload = try JSONValue.from(input)
    return try await withRetry(copy.environmentId) { socket in
      try await Self.decode(ProjectTakeoverResult.self, from: socket.call(tag: ProjectLinkMethod.takeover.rawValue, payload: payload))
    }
  }

  public func disarmStaleStandby(at copy: ProjectRef, logicalProjectId: String, belowEpoch: Int) async {
    guard let payload = try? JSONValue.from(ProjectStandbyDisarmInput(projectId: copy.projectId, logicalProjectId: logicalProjectId, belowEpoch: belowEpoch)) else { return }
    _ = try? await withRetry(copy.environmentId) { socket in
      try await socket.call(tag: ProjectLinkMethod.acceptStandby.rawValue, payload: payload)
    }
  }
}
