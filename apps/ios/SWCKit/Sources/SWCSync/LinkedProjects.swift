import Foundation
import SWCWire

/// A copy of a linked project as the coordinator decisions see it.
public protocol CoordinatorCandidate {
  /// `environmentId:projectId`.
  var candidateKey: String { get }
  var candidateBinding: CoordinatorBinding? { get }
}

/// The decisions behind a project linked across machines, as the desktop app
/// makes them (`logicalCoordinators`, `takeoverAvailability`,
/// `remoteOrchestratorOfflineLabel`, `rearmStatusText`): which copy
/// coordinates, when another may take over, and what the phone says about it.
/// Pure, so every rule is tested without a machine.
public enum LinkedProjectResolver {
  // MARK: - Copies

  /// One machine's copy of a linked project, with what the phone knows of it.
  public struct Copy: Identifiable, Hashable, Sendable, CoordinatorCandidate {
    public var id: ProjectRef { ref }
    public let ref: ProjectRef
    public var machineLabel: String
    /// Connected from this phone right now.
    public var machineOnline: Bool
    /// The phone has this machine's connection turned off.
    public var machineSwitchedOff: Bool
    /// The phone's connection to the machine connected, or failed, at least
    /// once since launch. Until then "unreachable" is not yet known.
    public var machineSettled: Bool
    /// When the phone last had the machine connected.
    public var lastSeenAt: Date?
    public var logicalProjectId: String?
    /// The members this copy's identity lists.
    public var listedMembers: [LogicalProjectMember]
    public var coordinatorThreadId: String?
    public var binding: CoordinatorBinding?
    /// The machine is new enough to take over and the phone may change its settings.
    public var canTakeOver: Bool
    /// The machine keeps a standby re-arm list (`coordinatorRearm`).
    public var canRearm: Bool

    public init(ref: ProjectRef, machineLabel: String, machineOnline: Bool, machineSwitchedOff: Bool = false, machineSettled: Bool = true, lastSeenAt: Date? = nil, logicalProjectId: String? = nil, listedMembers: [LogicalProjectMember] = [], coordinatorThreadId: String? = nil, binding: CoordinatorBinding? = nil, canTakeOver: Bool = true, canRearm: Bool = false) {
      self.ref = ref
      self.machineLabel = machineLabel
      self.machineOnline = machineOnline
      self.machineSwitchedOff = machineSwitchedOff
      self.machineSettled = machineSettled
      self.lastSeenAt = lastSeenAt
      self.logicalProjectId = logicalProjectId
      self.listedMembers = listedMembers
      self.coordinatorThreadId = coordinatorThreadId
      self.binding = binding
      self.canTakeOver = canTakeOver
      self.canRearm = canRearm
    }

    public var candidateKey: String { "\(ref.environmentId):\(ref.projectId)" }
    public var candidateBinding: CoordinatorBinding? { binding }

    /// The member entry this copy is listed under (`linkMemberOf`).
    public var member: LogicalProjectMember {
      listedMembers.first { $0.environmentId == ref.environmentId && $0.projectId == ref.projectId }
        ?? LogicalProjectMember(environmentId: ref.environmentId, projectId: ref.projectId, coordinatorThreadId: coordinatorThreadId ?? "project-coordinator:\(ref.projectId)")
    }
  }

  // MARK: - Which copy coordinates

  public struct Coordinators<T> {
    /// Every copy that coordinates now: newest epoch first, then by machine.
    public var coordinators: [T]
    /// Copies mid-handoff that nothing has superseded yet.
    public var pending: [T]
    /// Active copies a newer coordinator took over from.
    public var superseded: [T]
    /// A coordinator and the successor that took over from it at the same epoch.
    public var contested: [T]
  }

  public static let pendingProblem = "Coordinator handoff is pending. Reconnect the source and destination to confirm the transfer."
  public static let contestedProblem = "Two coordinators claim the same epoch, one as the other's successor."
  public static let unavailableProblem = "The active coordinator is unavailable. Reconnect its machine; the project will not switch automatically."

  /// The coordinators of a linked project, as the desktop's `logicalCoordinators`:
  /// several active copies are not a conflict; only a copy whose own successor
  /// took over at a newer epoch is superseded.
  public static func coordinators<T: CoordinatorCandidate>(_ copies: [T]) -> Coordinators<T> {
    let byKey = Dictionary(copies.map { ($0.candidateKey, $0) }, uniquingKeysWith: { first, _ in first })
    func epoch(_ copy: T) -> Int { copy.candidateBinding?.epoch ?? 0 }
    var superseded = Set<String>()
    var contested = Set<String>()
    for copy in copies where copy.candidateBinding?.state == .active {
      var seen: Set<String> = [copy.candidateKey]
      var predecessor = copy.candidateBinding?.predecessor
      while let link = predecessor {
        let key = "\(link.environmentId):\(link.projectId)"
        guard seen.insert(key).inserted, let ancestor = byKey[key] else { break }
        if epoch(ancestor) < epoch(copy) {
          superseded.insert(key)
        } else if epoch(ancestor) == epoch(copy), ancestor.candidateBinding?.state == .active,
                  copy.candidateBinding?.predecessor == link {
          contested.insert(key)
          contested.insert(copy.candidateKey)
        }
        predecessor = ancestor.candidateBinding?.predecessor
      }
    }
    func sorted(_ items: [T]) -> [T] {
      items.sorted { epoch($0) != epoch($1) ? epoch($0) > epoch($1) : $0.candidateKey < $1.candidateKey }
    }
    let live = { (copy: T) in !superseded.contains(copy.candidateKey) }
    return Coordinators(
      coordinators: sorted(copies.filter { $0.candidateBinding?.state == .active && live($0) }),
      pending: sorted(copies.filter { $0.candidateBinding?.state == .transferring && live($0) }),
      superseded: sorted(copies.filter { $0.candidateBinding?.state == .active && !live($0) }),
      contested: sorted(copies.filter { contested.contains($0.candidateKey) })
    )
  }

  /// The copy a linked project opens on: the active coordinator with the
  /// highest epoch, else a copy mid-handoff, else none.
  public static func coordinator<T: CoordinatorCandidate>(_ copies: [T]) -> T? {
    let found = coordinators(copies)
    return found.coordinators.first ?? found.pending.first
  }

  /// Why no single coordinator can be named, or nil.
  public static func coordinatorProblem<T: CoordinatorCandidate>(_ copies: [T]) -> String? {
    let found = coordinators(copies)
    if let first = found.coordinators.first {
      return found.contested.contains { $0.candidateKey == first.candidateKey } ? contestedProblem : nil
    }
    return found.pending.isEmpty ? unavailableProblem : pendingProblem
  }

  /// The highest coordinator epoch among the copies; a takeover goes above it.
  public static func highestEpoch(_ copies: [Copy]) -> Int {
    copies.map { $0.binding?.epoch ?? 0 }.max() ?? 0
  }

  // MARK: - Reach

  /// What the phone can tell about the coordinator's machine.
  public enum Reach: Hashable, Sendable {
    case reachable
    /// Switched off on this phone: the phone cannot tell whether it still coordinates.
    case switchedOff
    /// Still connecting since launch.
    case checking
    case unreachable
  }

  public static func reach(_ copy: Copy) -> Reach {
    if copy.machineOnline { return .reachable }
    if copy.machineSwitchedOff { return .switchedOff }
    return copy.machineSettled ? .unreachable : .checking
  }

  /// Which copy's settings open for a linked project opened as `opened`: that
  /// copy while its machine is connected, else a connected copy, one that can
  /// take over first, so Machines and "Take over coordinator here" stay in
  /// reach. `opened` when no other copy is connected or it is not linked.
  public static func settingsCopy(opened: ProjectRef, copies: [Copy]) -> ProjectRef {
    guard let current = copies.first(where: { $0.ref == opened }), !current.machineOnline else { return opened }
    let reachable = copies.filter { $0.machineOnline && $0.ref != opened }
    return (reachable.first(where: \.canTakeOver) ?? reachable.first)?.ref ?? opened
  }

  /// "M4 is switched off on this phone", shown where "unreachable" would be.
  public static func switchedOffCoordinatorLabel(machine: String) -> String {
    "\(machine) is switched off on this phone. Turn it on to check its coordinator."
  }

  // MARK: - Takeover

  /// How long the coordinator's machine must be unreachable before a member may take over.
  public static let takeoverWait: TimeInterval = 10 * 60

  public struct TakeoverAvailability: Hashable, Sendable {
    public var available: Bool
    public var wait: TimeInterval
  }

  /// Never while the coordinator's machine is connected, and only after it
  /// has been unreachable from this phone for 10 minutes.
  public static func takeoverAvailability(coordinatorConnected: Bool, unreachableSince: Date?, now: Date) -> TakeoverAvailability {
    guard !coordinatorConnected, let since = unreachableSince else { return TakeoverAvailability(available: false, wait: takeoverWait) }
    let wait = max(0, since.addingTimeInterval(takeoverWait).timeIntervalSince(now))
    return TakeoverAvailability(available: wait == 0, wait: wait)
  }

  /// Since when the machine has been unreachable from this phone: when it was
  /// last seen connected, else when the phone first found it gone. A
  /// connected machine clears its first-seen-gone time.
  public static func unreachableSince(environmentId: String, connected: Bool, lastSeenAt: Date?, firstSeenGone: inout [String: Date], now: Date) -> Date? {
    if connected {
      firstSeenGone[environmentId] = nil
      return nil
    }
    if let lastSeenAt { return lastSeenAt }
    if let first = firstSeenGone[environmentId] { return first }
    firstSeenGone[environmentId] = now
    return now
  }

  /// "M4 unreachable · last synced 2:05 PM", or "· last synced: Unknown".
  public static func unreachableLabel(machine: String, lastSyncedAt: Date?, now: Date, calendar: Calendar = .current, locale: Locale = .current) -> String {
    guard let lastSyncedAt else { return "\(machine) unreachable · last synced: Unknown" }
    return "\(machine) unreachable · last synced \(ThreadPlacement.seenTime(lastSyncedAt, now: now, calendar: calendar, locale: locale))"
  }

  /// When the coordinator's notes, goal and instructions last reached another
  /// copy: the newest successful `replica` pass a reachable copy's server
  /// reports with the coordinator. Without any replica report, when the phone
  /// last had the coordinator's machine connected, as the desktop shows it.
  public static func lastSynced(with coordinator: Copy, statuses: [ProjectRef: ProjectLinkSyncStatus]) -> Date? {
    let replicas = statuses.filter { $0.key != coordinator.ref }.values.flatMap(\.pairs).filter {
      $0.kind == "replica" && $0.peerEnvironmentId == coordinator.ref.environmentId && $0.peerProjectId == coordinator.ref.projectId
    }
    guard !replicas.isEmpty else { return coordinator.lastSeenAt }
    return replicas.compactMap { $0.lastSuccessAt.flatMap(parseDate) }.max()
  }

  public static func parseDate(_ string: String) -> Date? {
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return fractional.date(from: string) ?? ISO8601DateFormatter().date(from: string)
  }

  // MARK: - Rows

  public enum Role: String, Sendable { case coordinator, workers, pending }

  public static func roleText(_ role: Role) -> String {
    switch role {
    case .coordinator: "Coordinator. Plans the work and can send it to every copy."
    case .workers: "Runs workers. Its own coordinator is read-only history until you start a coordinator here."
    case .pending: "Coordinator handoff pending."
    }
  }

  /// What "Take over coordinator here" shows on one copy's row.
  public enum TakeoverButton: Hashable, Sendable {
    /// No button: the coordinator is reachable, or this copy coordinates.
    case hidden
    /// Disabled until the 10 minutes pass.
    case waiting(minutes: Int)
    case ready
    /// Disabled, with why.
    case unavailable(String)
  }

  public struct Row: Identifiable, Hashable, Sendable {
    public var id: ProjectRef { copy.ref }
    public var copy: Copy
    public var role: Role
    public var isStandby: Bool
    /// What a takeover means for this row, if anything.
    public var note: String?
    public var takeover: TakeoverButton
  }

  /// One row per copy, coordinator first.
  public static func rows(_ copies: [Copy], now: Date, unreachableSince: Date?) -> [Row] {
    let found = coordinators(copies)
    let coordinating = Set(found.coordinators.map(\.candidateKey))
    let coordinator = found.coordinators.first
    let standby = coordinator?.binding?.state == .active ? coordinator?.binding?.standby?.member : nil
    let reach = coordinator.map(reach) ?? .reachable
    let availability = coordinator.flatMap { _ in reach == .unreachable ? takeoverAvailability(coordinatorConnected: false, unreachableSince: unreachableSince, now: now) : nil }
    let ordered = copies.sorted { a, b in
      let ra = a.candidateKey == coordinator?.candidateKey ? 0 : 1, rb = b.candidateKey == coordinator?.candidateKey ? 0 : 1
      return ra != rb ? ra < rb : a.machineLabel.localizedStandardCompare(b.machineLabel) == .orderedAscending
    }
    return ordered.map { copy in
      let role: Role = coordinating.contains(copy.candidateKey) ? .coordinator : copy.binding?.state == .transferring ? .pending : .workers
      let isStandby = standby.map { $0.environmentId == copy.ref.environmentId && $0.projectId == copy.ref.projectId } ?? false
      var takeover = TakeoverButton.hidden
      var note: String?
      if role == .workers, reach == .switchedOff, let coordinator {
        takeover = .unavailable("Turn on \(coordinator.machineLabel) on this phone first.")
        note = "\(coordinator.machineLabel) is switched off on this phone, so the phone cannot tell whether it still coordinates."
      } else if role == .workers, let availability, let coordinator {
        if !copy.machineOnline {
          takeover = .unavailable("Connect \(copy.machineLabel) first.")
        } else if !copy.canTakeOver {
          takeover = .unavailable("Update SpecWithCode on \(copy.machineLabel) to take over.")
        } else if availability.available {
          takeover = .ready
        } else {
          takeover = .waiting(minutes: max(1, Int((availability.wait / 60).rounded(.up))))
        }
        note = availability.available
          ? "\(coordinator.machineLabel) has been unreachable for 10 minutes or more. This copy can take over the coordinator."
          : "\(coordinator.machineLabel) is unreachable. This copy can take over the coordinator in \(max(1, Int((availability.wait / 60).rounded(.up)))) min if it stays away."
      }
      if let binding = copy.binding, let at = binding.takenOverAt.flatMap(parseDate) {
        if role == .coordinator, let previous = binding.predecessor.flatMap({ p in copies.first { $0.ref.environmentId == p.environmentId && $0.ref.projectId == p.projectId } }) {
          note = "Took over from \(previous.machineLabel) \(clock(at, now: now)). \(previous.machineLabel) gives way when it is reachable again."
        } else if role == .workers, let successor = binding.successor.flatMap({ s in copies.first { $0.ref.environmentId == s.environmentId && $0.ref.projectId == s.projectId } }) {
          note = "\(successor.machineLabel) took over \(clock(at, now: now)). Review the coordinator turns this copy ran after that."
        }
      }
      // A copy taken over from while it was away still thinks it coordinates.
      if found.superseded.contains(where: { $0.candidateKey == copy.candidateKey }),
         let successor = copies.first(where: { $0.binding?.predecessor?.environmentId == copy.ref.environmentId && $0.binding?.predecessor?.projectId == copy.ref.projectId }) {
        note = "\(successor.machineLabel) took over while this machine was unreachable. It gives way when both machines are reachable."
      }
      return Row(copy: copy, role: role, isStandby: isStandby, note: note, takeover: takeover)
    }
  }

  static func clock(_ date: Date, now: Date) -> String {
    ThreadPlacement.seenTime(date, now: now, calendar: .current, locale: .current)
  }

  /// The confirmation before a takeover, in the desktop's words.
  public static func takeoverConfirmation(coordinator: String) -> String {
    "\(coordinator) has been unreachable for at least 10 minutes. This copy becomes the coordinator, starting from the notes, goal and instructions last copied from \(coordinator). When \(coordinator) is back it stops coordinating and lists any coordinator turns it ran meanwhile for you to review. Nothing is merged on its own; code stays in git on each machine."
  }

  /// What the phone says after a takeover finished.
  public static func takeoverDoneText(machine: String, previous: String, replicaFrom: Date?, now: Date) -> String {
    let start = replicaFrom.map { "It starts from \(previous)'s notes, goal and instructions as copied \(clock($0, now: now))." }
      ?? "No copy of \(previous)'s notes reached it, so it starts from its own."
    return "\(machine) now coordinates this project. \(start) When \(previous) is back, it gives way and lists any coordinator turns it ran meanwhile."
  }

  // MARK: - Standby and re-arm

  /// What the phone shows of automatic takeover. Arming it stays on the desktop.
  public struct Standby: Hashable, Sendable {
    /// "If M4 goes quiet".
    public var title: String
    /// The armed standby's machine, or nil when automatic takeover is off.
    public var standbyMachine: String?
    /// "15 minutes", or nil when off.
    public var after: String?
    /// "If it takes over, arm next: Minis, Build box".
    public var armNext: String?
    /// How re-arming after an automatic takeover goes, or nil.
    public var rearmStatus: String?
    /// "Minis took over from M4 at 2:05 PM. M4 went quiet."
    public var tookOver: String?
  }

  public static func standby(coordinator: Copy, copies: [Copy], rearm: ProjectStandbyRearmStatus?, now: Date) -> Standby {
    func label(_ environmentId: String) -> String {
      copies.first { $0.ref.environmentId == environmentId }?.machineLabel ?? "Another machine"
    }
    let binding = coordinator.binding?.state == .active ? coordinator.binding : nil
    let armed = binding?.standby
    let listed: [String] = rearm?.consent?.members.map(\.environmentId) ?? []
    let order = listed.filter { $0 != armed?.member.environmentId }
    var tookOver: String?
    if binding?.takenOverBy == "auto", let predecessor = binding?.predecessor, let at = binding?.takenOverAt.flatMap(parseDate) {
      tookOver = "\(coordinator.machineLabel) took over from \(label(predecessor.environmentId)) at \(clock(at, now: now)). \(label(predecessor.environmentId)) went quiet."
    }
    return Standby(
      title: "If \(coordinator.machineLabel) goes quiet",
      standbyMachine: armed.map { label($0.member.environmentId) },
      after: armed.map { "\($0.afterMinutes) minutes" },
      armNext: armed == nil || order.isEmpty ? nil : "If it takes over, arm next: " + order.map { label($0) }.joined(separator: ", "),
      rearmStatus: rearmStatusText(rearm?.run, label: label),
      tookOver: tookOver
    )
  }

  /// Why the machine that took over has no standby yet (`rearmReasonText`).
  public static func rearmReasonText(_ reason: String, machine: String) -> String {
    switch reason {
    case "unreachable": "\(machine) did not answer."
    case "needs_grant": "This machine needs access to \(machine). Prepare machines again."
    case "needs_update": "\(machine) needs an update."
    case "not_member": "\(machine) still runs its own coordinator."
    case "no_consent": "\(machine) is not on your current list. Save the list again."
    case "team_rules": "Team rules stop machines working together."
    case "lease_failed": "\(machine) did not answer its first check."
    case "standby_missing": "\(machine) stopped standing by."
    case "no_candidates": "No other machine on your list."
    default: "\(machine) did not take the standby role."
    }
  }

  /// The re-arm status line on the machine that took over automatically, or
  /// nil when there is nothing to say (`rearmStatusText`).
  public static func rearmStatusText(_ run: ProjectStandbyRearmStatus.Run?, label: (String) -> String) -> String? {
    guard let run else { return nil }
    let machine = run.standby.map { label($0.environmentId) } ?? (run.detail.flatMap { $0.isEmpty ? nil : $0 } ?? "The next machine")
    switch run.state {
    case "pending":
      if run.standby != nil {
        return "\(machine) is still named as the standby: \(rearmReasonText(run.reason ?? "lease_failed", machine: machine)) Trying again later."
      }
      let waitsForOwner = run.reason == "needs_grant" || run.reason == "no_consent"
      return "No standby armed yet: \(rearmReasonText(run.reason ?? "no_candidates", machine: machine)) \(waitsForOwner ? "Waiting for you." : "Trying again.")"
    case "verifying": return "Checking \(machine)."
    case "armed": return "Armed \(machine) automatically after taking over."
    default: return nil
    }
  }

  // MARK: - Switched-off machines

  /// Linked copies on machines the phone has switched off, once per machine.
  public static func switchedOffMachines(_ copies: [Copy]) -> [Copy] {
    var seen = Set<String>()
    return copies.filter { $0.machineSwitchedOff && seen.insert($0.ref.environmentId).inserted }
  }

  /// The prompt to turn them on shows once per linked project.
  public static func shouldPromptSwitchedOff(projectKey: String, copies: [Copy], asked: Set<String>) -> Bool {
    !asked.contains(projectKey) && !switchedOffMachines(copies).isEmpty
  }

  /// "Turn on M4 and Minis?"
  public static func switchedOffPromptTitle(_ machines: [Copy]) -> String {
    let names = machines.map(\.machineLabel)
    let list = names.count <= 1 ? names.joined() : names.dropLast().joined(separator: ", ") + " and " + names.last!
    return "Turn on \(list)?"
  }

  public static func switchedOffPromptMessage(_ machines: [Copy], project: String) -> String {
    if machines.count == 1 {
      return "\(machines[0].machineLabel) has a copy of \(project) and is switched off on this phone. Turn it on to see its threads and coordinator."
    }
    return "\(machines.count) machines with a copy of \(project) are switched off on this phone. Turn them on to see their threads and coordinators."
  }
}
