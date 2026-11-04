import Foundation
import SWCWire

/// Sample linked copies for previews and simulator screenshots, built from the
/// fixture's own rows. `-SWCLinkedState` picks what they show:
/// `coordinator-away` (M4 unreachable for 25 minutes, Minis armed as standby),
/// `auto-takeover` (Minis took over and has no standby yet) or `switched-off`
/// (Minis is switched off on this phone). Nothing reaches a machine.
public enum FixtureLinkedState: String, Sendable {
  case live
  case coordinatorAway = "coordinator-away"
  case autoTakeover = "auto-takeover"
  case switchedOff = "switched-off"

  static var current: FixtureLinkedState {
    let arguments = ProcessInfo.processInfo.arguments
    guard let index = arguments.firstIndex(of: "-SWCLinkedState"), index + 1 < arguments.count else { return .live }
    return FixtureLinkedState(rawValue: arguments[index + 1]) ?? .live
  }
}

extension FixtureEngine: LinkedProjectEngine {
  public func linkedCopies(of project: ProjectRef, in model: AppModel) -> [LinkedProjectResolver.Copy] {
    guard let summary = model.project(project), summary.members.count > 1 else { return [] }
    let machines = { (environmentId: String) in
      model.machine(environmentId).map { (online: $0.status.isOnline, switchedOff: $0.isDisconnected) }
    }
    return Self.fleetCopies(of: summary, machine: machines, state: FixtureLinkedState.current, now: Date())
  }

  /// What each sample copy reports. The copy each machine first listed as
  /// coordinator (M4 in the fleet sample) holds epoch 3, whichever copy the
  /// row leads with now; `state` decides who is away and who took over.
  nonisolated static func fleetCopies(of summary: ProjectSummary, machine: (String) -> (online: Bool, switchedOff: Bool)?, state: FixtureLinkedState, now: Date) -> [LinkedProjectResolver.Copy] {
    guard summary.members.count > 1 else { return [] }
    let logical = summary.members.map {
      LogicalProjectMember(environmentId: $0.ref.environmentId, projectId: $0.ref.projectId, coordinatorThreadId: "project-coordinator:\($0.ref.projectId)")
    }
    let listedFirst = summary.contains(FixtureFleet.onM4) ? FixtureFleet.onM4 : nil
    let coordinator = summary.members.first { $0.ref == listedFirst } ?? summary.members.first(where: \.isCoordinator) ?? summary.members[0]
    let others = summary.members.filter { $0.ref != coordinator.ref }.sorted { $0.machineLabel.localizedStandardCompare($1.machineLabel) == .orderedAscending }
    let member = { (ref: ProjectRef) in logical.first { $0.environmentId == ref.environmentId && $0.projectId == ref.projectId }! }
    return summary.members.map { copy in
      let found = machine(copy.ref.environmentId)
      var online = found?.online ?? copy.machineOnline
      var switchedOff = found?.switchedOff ?? false
      var lastSeen = copy.lastSeenAt
      var binding: CoordinatorBinding
      let isCoordinator = copy.ref == coordinator.ref
      switch state {
      case .autoTakeover:
        // The first other copy took over from the coordinator 40 minutes ago.
        let successor = others.first?.ref
        if copy.ref == successor {
          binding = CoordinatorBinding(epoch: 4, state: .active, predecessor: member(coordinator.ref), takenOverAt: iso(now.addingTimeInterval(-40 * 60)), takenOverBy: "auto")
        } else if isCoordinator {
          online = false
          lastSeen = now.addingTimeInterval(-55 * 60)
          binding = CoordinatorBinding(epoch: 3, state: .active)
        } else {
          binding = CoordinatorBinding(epoch: 3, state: .transferred, successor: member(coordinator.ref))
        }
      default:
        if isCoordinator {
          let standby = others.first.map { CoordinatorStandby(member: member($0.ref), afterMinutes: 15) }
          binding = CoordinatorBinding(epoch: 3, state: .active, standby: standby)
          if state == .coordinatorAway {
            online = false
            lastSeen = now.addingTimeInterval(-25 * 60)
          }
        } else {
          binding = CoordinatorBinding(epoch: 3, state: .transferred, successor: member(coordinator.ref))
          if state == .switchedOff {
            online = false
            switchedOff = true
          }
        }
      }
      return LinkedProjectResolver.Copy(
        ref: copy.ref, machineLabel: copy.machineLabel, machineOnline: online, machineSwitchedOff: switchedOff,
        lastSeenAt: lastSeen, logicalProjectId: "fixture-\(coordinator.ref.projectId)", listedMembers: logical,
        binding: binding, canTakeOver: true, canRearm: true
      )
    }
  }

  public func linkSyncStatus(of copy: ProjectRef) async throws -> ProjectLinkSyncStatus {
    try await Task.sleep(for: latency)
    switch FixtureLinkedState.current {
    case .autoTakeover where copy.environmentId == FixtureFleet.minis:
      return ProjectLinkSyncStatus(standbyRearm: ProjectStandbyRearmStatus(run: .init(state: "pending", reason: "unreachable", detail: "M4", epoch: 4)))
    case .coordinatorAway where copy.environmentId == FixtureFleet.minis:
      let synced = Self.iso(Date().addingTimeInterval(-27 * 60))
      return ProjectLinkSyncStatus(pairs: [LinkedServerSyncPair(peerEnvironmentId: FixtureFleet.m4, peerProjectId: FixtureFleet.onM4.projectId, kind: "replica", lastSuccessAt: synced, lastAttemptAt: synced)])
    default:
      return ProjectLinkSyncStatus()
    }
  }

  public func takeOverCoordinator(at copy: ProjectRef, knownEpoch: Int, predecessor: LogicalProjectMember) async throws -> ProjectTakeoverResult {
    try await Task.sleep(for: latency * 2)
    return ProjectTakeoverResult(
      operationId: UUID().uuidString.lowercased(),
      logicalProject: LogicalProject(id: "fixture", title: "Sample", coordinatorId: copy.projectId),
      coordinatorBinding: CoordinatorBinding(epoch: knownEpoch + 1, state: .active, predecessor: predecessor, takenOverAt: Self.iso(Date()), takenOverBy: "person"),
      replicaFrom: Self.iso(Date().addingTimeInterval(-27 * 60))
    )
  }

  public func disarmStaleStandby(at copy: ProjectRef, logicalProjectId: String, belowEpoch: Int) async {}

  nonisolated static func iso(_ date: Date) -> String { ISO8601DateFormatter().string(from: date) }
}
