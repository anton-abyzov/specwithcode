import Foundation
import Observation
import SWCSync
import SWCWire

/// The phone's view of one linked project: its copies, what each reachable
/// copy's server reports about keeping them in step, and the takeover the
/// person may start. Decisions come from `LinkedProjectResolver`; this only
/// gathers the inputs and runs the calls.
@MainActor
@Observable
final class LinkedProjectState {
  let project: ProjectRef
  /// `projectLink.syncStatus` from each reachable copy.
  private(set) var statuses: [ProjectRef: ProjectLinkSyncStatus] = [:]
  /// Moves the 10-minute wait and "last synced" along while the screen is open.
  private(set) var now = Date()
  private(set) var busy = false
  /// The epoch a takeover from this phone moved the project to, until the
  /// copies report it; the button stays disabled meanwhile.
  private(set) var takenOverAtEpoch: Int?
  var message: (text: String, isError: Bool)?

  /// When the phone first found a machine gone that it never saw connected,
  /// for this app session, as the desktop's `firstSeenGone`.
  private static var firstSeenGone: [String: Date] = [:]

  init(project: ProjectRef) {
    self.project = project
  }

  func copies(in model: AppModel) -> [LinkedProjectResolver.Copy] {
    (model.engine as? LinkedProjectEngine)?.linkedCopies(of: project, in: model) ?? []
  }

  /// Since when the coordinator's machine has been unreachable, or nil while
  /// it is reachable, switched off on this phone or still connecting.
  func unreachableSince(_ coordinator: LinkedProjectResolver.Copy) -> Date? {
    guard LinkedProjectResolver.reach(coordinator) != .checking, !coordinator.machineSwitchedOff else { return nil }
    return LinkedProjectResolver.unreachableSince(environmentId: coordinator.ref.environmentId, connected: coordinator.machineOnline, lastSeenAt: coordinator.lastSeenAt, firstSeenGone: &Self.firstSeenGone, now: now)
  }

  /// "M4 unreachable · last synced 2:05 PM" while the coordinator's machine is
  /// unreachable, or that it is switched off on this phone.
  func unreachableLine(_ copies: [LinkedProjectResolver.Copy]) -> String? {
    guard let coordinator = LinkedProjectResolver.coordinator(copies) else { return nil }
    switch LinkedProjectResolver.reach(coordinator) {
    case .reachable, .checking: return nil
    case .switchedOff: return LinkedProjectResolver.switchedOffCoordinatorLabel(machine: coordinator.machineLabel)
    case .unreachable:
      return LinkedProjectResolver.unreachableLabel(machine: coordinator.machineLabel, lastSyncedAt: LinkedProjectResolver.lastSynced(with: coordinator, statuses: statuses), now: now)
    }
  }

  /// A takeover from this phone is done but the copies do not show it yet.
  func awaitingTakeover(_ copies: [LinkedProjectResolver.Copy]) -> Bool {
    guard let epoch = takenOverAtEpoch else { return false }
    return LinkedProjectResolver.highestEpoch(copies) < epoch
  }

  func rows(_ copies: [LinkedProjectResolver.Copy]) -> [LinkedProjectResolver.Row] {
    let since = LinkedProjectResolver.coordinator(copies).flatMap { unreachableSince($0) }
    return LinkedProjectResolver.rows(copies, now: now, unreachableSince: since)
  }

  func standby(_ copies: [LinkedProjectResolver.Copy]) -> LinkedProjectResolver.Standby? {
    guard copies.count > 1, let coordinator = LinkedProjectResolver.coordinators(copies).coordinators.first else { return nil }
    return LinkedProjectResolver.standby(coordinator: coordinator, copies: copies, rearm: statuses[coordinator.ref]?.standbyRearm, now: now)
  }

  /// Reads each reachable copy's sync status, then every 30 seconds, while the view lives.
  func follow(model: AppModel) async {
    while !Task.isCancelled {
      now = Date()
      await refresh(model: model)
      try? await Task.sleep(for: .seconds(30))
    }
  }

  func refresh(model: AppModel) async {
    guard let engine = model.engine as? LinkedProjectEngine else { return }
    let reachable = copies(in: model).filter(\.machineOnline)
    for copy in reachable {
      if let status = try? await engine.linkSyncStatus(of: copy.ref) { statuses[copy.ref] = status }
    }
  }

  static let changedWhileConfirming = "The coordinator changed while you confirmed. Check the machines and take over again if you still need to."

  /// `projectLink.takeover` on `copy`'s machine, then disarm any standby armed
  /// for the old coordinator on the other reachable copies, as the desktop does.
  /// `coordinator` is the one the confirmation named; nothing is sent unless
  /// it still coordinates, is still unreachable past the wait, and `copy`
  /// still runs workers.
  func takeOver(at copy: LinkedProjectResolver.Copy, from coordinator: LinkedProjectResolver.Copy, model: AppModel) async {
    guard !busy, let engine = model.engine as? LinkedProjectEngine else { return }
    now = Date()
    let copies = copies(in: model)
    guard !awaitingTakeover(copies), Self.mayTakeOver(at: copy.ref, from: coordinator.ref, copies: copies, rows: rows(copies)) else {
      message = (Self.changedWhileConfirming, true)
      return
    }
    busy = true
    message = nil
    defer { busy = false }
    do {
      let result = try await engine.takeOverCoordinator(at: copy.ref, knownEpoch: LinkedProjectResolver.highestEpoch(copies), predecessor: coordinator.member)
      takenOverAtEpoch = result.coordinatorBinding.epoch
      for other in copies where other.ref.environmentId != copy.ref.environmentId && other.machineOnline && other.canRearm {
        await engine.disarmStaleStandby(at: other.ref, logicalProjectId: result.logicalProject.id, belowEpoch: result.coordinatorBinding.epoch)
      }
      let replica = result.replicaFrom.flatMap(LinkedProjectResolver.parseDate)
      message = (LinkedProjectResolver.takeoverDoneText(machine: copy.machineLabel, previous: coordinator.machineLabel, replicaFrom: replica, now: Date()), false)
      await refresh(model: model)
    } catch {
      message = (error.localizedDescription.isEmpty ? "Take over did not finish. Retry it." : error.localizedDescription, true)
    }
  }
}

extension LinkedProjectState {
  /// The copy whose settings a linked project's title, gear or Machines link
  /// opens: a connected copy when `opened`'s machine is unreachable.
  static func settingsTarget(_ opened: ProjectRef, in model: AppModel) -> ProjectRef {
    guard let engine = model.engine as? LinkedProjectEngine else { return opened }
    return LinkedProjectResolver.settingsCopy(opened: opened, copies: engine.linkedCopies(of: opened, in: model))
  }

  /// The coordinator named in the confirmation is still the one, and the
  /// tapped copy still offers a ready takeover.
  nonisolated static func mayTakeOver(at target: ProjectRef, from coordinator: ProjectRef, copies: [LinkedProjectResolver.Copy], rows: [LinkedProjectResolver.Row]) -> Bool {
    guard target != coordinator, LinkedProjectResolver.coordinator(copies)?.ref == coordinator,
          let row = rows.first(where: { $0.copy.ref == target }) else { return false }
    return row.role == .workers && row.takeover == .ready
  }
}

/// Which linked projects already asked to turn on their switched-off machines.
/// Asked once per project, remembered on this phone.
enum LinkedMachinesPromptMemory {
  static let key = "swc.linkedMachinesPrompted"

  static func asked(_ defaults: UserDefaults = .standard) -> Set<String> {
    Set(defaults.stringArray(forKey: key) ?? [])
  }

  static func remember(_ projectKey: String, _ defaults: UserDefaults = .standard) {
    var asked = asked(defaults)
    guard asked.insert(projectKey).inserted else { return }
    defaults.set(asked.sorted(), forKey: key)
  }

  /// The linked project's identity, so every copy's row shares one answer.
  static func projectKey(_ copies: [LinkedProjectResolver.Copy], fallback: ProjectRef) -> String {
    copies.lazy.compactMap(\.logicalProjectId).first ?? "\(fallback.environmentId):\(fallback.projectId)"
  }
}
