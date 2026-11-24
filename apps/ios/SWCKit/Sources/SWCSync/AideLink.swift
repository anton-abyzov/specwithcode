import Foundation
import SWCWire

/// One Percy for machines whose assistants are linked (1448). Percy is the
/// same on each machine where you turned it on; a chat stays on the machine
/// it was started on. Seats are linked when they share a `logicalProject.id`
/// that lists more than one member. A seat with no link, or alone in its
/// list, keeps its own row, as every seat did before machines linked them.
/// Pure, so it is tested without sockets.
public enum AideLink {
  /// One machine's assistant, as its project list holds it.
  struct Seat {
    var project: ProjectShell
    var summary: ProjectSummary
    /// The seat's own chats.
    var threads: [ThreadSummary]
    var lastSeenAt: Date?
    /// On a machine whose projects the phone lists (see `listedMachines`).
    var listed: Bool

    var ref: ProjectRef { summary.ref }
    var online: Bool { summary.machineOnline }
    /// Online, or still on its first attempt: its chats are listed.
    var reached: Bool { summary.machineOnline || summary.machineSettling }
    var routineOwner: Bool { project.workspaceSettings?.coordinatorBinding?.routineOwner == true }
  }

  struct Output {
    /// The Percy the phone lands on.
    var aide: ProjectSummary?
    /// The rows to list, `aide` first.
    var rows: [ProjectSummary] = []
    /// What each seat of a listed row shows as its chats.
    var threads: [ProjectRef: [ThreadSummary]] = [:]
  }

  /// The link a seat belongs to, or nil for a seat that is not linked.
  static func linkId(_ project: ProjectShell) -> String? {
    guard let logical = project.workspaceSettings?.logicalProject, logical.members.count > 1 else { return nil }
    return logical.id
  }

  /// - Parameters:
  ///   - seats: Every machine's assistant, in the order machines are visited:
  ///     listed machines by environment id, then the others.
  ///   - machines: Every machine the phone knows, to name a linked seat whose
  ///     machine has not sent its projects.
  static func rows(_ seats: [Seat], machines: [ShellSummaries.Machine]) -> Output {
    let byId = Dictionary(machines.map { ($0.environmentId, $0) }, uniquingKeysWith: { first, _ in first })
    var links: [String] = []
    var linked: [String: [Seat]] = [:]
    var single: [Seat] = []
    for seat in seats {
      guard let id = linkId(seat.project) ?? staleLink(of: seat, among: seats) else {
        single.append(seat)
        continue
      }
      if linked[id] == nil { links.append(id) }
      linked[id, default: []].append(seat)
    }

    var output = Output()
    var units: [(row: ProjectSummary, listed: Bool)] = []
    for id in links {
      let group = linked[id] ?? []
      let merged = row(for: group, linkId: id, machines: byId)
      units.append((merged.row, group.contains(where: \.listed)))
      for seat in group { output.threads[seat.ref] = merged.threads }
    }
    for seat in single {
      units.append((seat.summary, seat.listed))
      output.threads[seat.ref] = seat.threads
    }

    // A linked Percy leads, then an active one beats an archived one, then a
    // listed machine's beats another's, then the lowest environment id wins
    // (seats arrive in that order), as the web's findPersonalAssistant.
    let listed = units.filter(\.listed).map(\.row)
    let others = units.filter { !$0.listed }.map(\.row)
    let aide = listed.first { !$0.archived } ?? others.first { !$0.archived } ?? listed.first ?? others.first
    // Each listed machine's live seat is offered. A machine the desktop does
    // not list (another person's, a bare worker) only shows its Percy when
    // that is the chosen one.
    let rest = listed.filter { !$0.archived && $0.ref != aide?.ref }
    var rows = (aide.map { [$0] } ?? [])
      + rest.filter(\.isLinkedAide)
      + rest.filter { !$0.isLinkedAide }.sorted { $0.machineLabel.localizedStandardCompare($1.machineLabel) == .orderedAscending }
    if rows.contains(where: \.isLinkedAide) {
      for index in rows.indices where !rows[index].isLinkedAide { rows[index].aideNotJoined = true }
    }
    output.aide = rows.first { $0.ref == aide?.ref } ?? aide
    output.rows = rows.filter { !$0.archived }
    let shown = Set(rows.flatMap { [$0.ref] + $0.members.map(\.ref) })
    output.threads = output.threads.filter { shown.contains($0.key) }
    return output
  }

  /// A seat the phone last saw before it joined: its machine is unreachable,
  /// its saved copy says nothing of a link, and a linked seat that is online
  /// lists it. It belongs to that link, not to a row of its own.
  private static func staleLink(of seat: Seat, among seats: [Seat]) -> String? {
    guard !seat.reached else { return nil }
    for other in seats where other.online {
      guard let id = linkId(other.project), let members = other.project.workspaceSettings?.logicalProject?.members else { continue }
      if members.contains(where: { $0.environmentId == seat.ref.environmentId && $0.projectId == seat.ref.projectId }) { return id }
    }
    return nil
  }

  /// The seat the phone talks to, for a new chat and for Percy's main
  /// conversation: the one that runs the routines while its machine is
  /// online, otherwise the first whose machine is online, by environment id.
  /// Never a seat on an offline machine while another is online; with none
  /// online the row stays, on the routine runner's seat, and nothing is sent.
  static func talkSeat(_ seats: [Seat]) -> Seat? {
    let ordered = seats.sorted { ($0.ref.environmentId, $0.ref.projectId) < ($1.ref.environmentId, $1.ref.projectId) }
    let online = ordered.filter(\.online)
    return online.first(where: \.routineOwner) ?? online.first ?? ordered.first(where: \.routineOwner) ?? ordered.first
  }

  /// One row for the seats of a link: the link's name, every seat as a member,
  /// the counts summed and the reached seats' chats in one list.
  private static func row(for group: [Seat], linkId: String, machines: [String: ShellSummaries.Machine]) -> (row: ProjectSummary, threads: [ThreadSummary]) {
    // An archived seat leads only when every seat is archived.
    let live = group.filter { !$0.summary.archived }
    let seats = live.isEmpty ? group : live
    let talk = talkSeat(seats) ?? group[0]
    // An unreachable seat's saved chats stay out: its line says they are back with it.
    let reached = seats.filter(\.reached)
    let threads = ShellSummaries.sortThreads(reached.flatMap(\.threads))

    var members = ([talk] + seats.filter { $0.ref != talk.ref }.sorted { $0.ref.environmentId < $1.ref.environmentId }).map { seat in
      var member = ProjectMember(ref: seat.ref, machineLabel: seat.summary.machineLabel, machineOnline: seat.online, lastSeenAt: seat.lastSeenAt, isCoordinator: seat.ref == talk.ref)
      member.machineSettling = seat.summary.machineSettling
      return member
    }
    // A seat the link names on a machine that has not sent its projects: it
    // is listed as away, so its machine can say why its chats are missing.
    var named = Set(group.map(\.ref.environmentId))
    for listed in seats.flatMap({ $0.project.workspaceSettings?.logicalProject?.members ?? [] }) {
      guard let machine = machines[listed.environmentId], !machine.online, named.insert(listed.environmentId).inserted else { continue }
      var member = ProjectMember(ref: ProjectRef(environmentId: listed.environmentId, projectId: listed.projectId), machineLabel: machine.displayName, machineOnline: false, lastSeenAt: machine.lastSeenAt)
      member.machineSettling = machine.settling
      members.append(member)
    }

    var row = talk.summary
    row.members = members
    row.logicalProjectId = linkId
    var others = Set([talk.ref.environmentId])
    row.linkedMachineIds = (talk.project.workspaceSettings?.logicalProject?.members ?? []).map(\.environmentId).filter { others.insert($0).inserted }
    row.archived = live.isEmpty
    row.workingCount = reached.reduce(0) { $0 + $1.summary.workingCount }
    row.hasUnread = reached.contains { $0.summary.hasUnread }
    return (row, threads)
  }
}

extension ProjectSummary {
  /// Percy linked across machines: one row for all of its seats.
  public var isLinkedAide: Bool { kind == .personal && logicalProjectId != nil }

  /// The name of Percy's row. A linked Percy shows the link's name; an
  /// assistant that is not part of a listed link says which machine it is on.
  public var aideRowTitle: String {
    if isLinkedAide { return title }
    return aideNotJoined && !machineLabel.isEmpty ? "Percy on \(machineLabel)" : "Percy"
  }

  /// The second line of Percy's row: nothing for a linked Percy, "not joined"
  /// beside one, and the machine's name when no machines are linked.
  public var aideRowSubtitle: String? {
    if isLinkedAide { return nil }
    if aideNotJoined { return "not joined" }
    return machineLabel.isEmpty ? nil : machineLabel
  }

  /// One quiet line per linked seat whose machine is offline.
  public var aideOfflineLines: [String] {
    guard isLinkedAide else { return [] }
    var seen = Set<String>()
    return members.filter { $0.showsMachineOffline && seen.insert($0.ref.environmentId).inserted }.map { AideLink.offlineLine(machine: $0.machineLabel) }
  }

  /// The seat of this Percy a chat should be on, given the one it shows now:
  /// that seat while its machine is still reachable, so an open chat never
  /// changes machines under someone typing; otherwise the seat the phone
  /// talks to.
  public func aideSeat(showing shown: ProjectRef?) -> ProjectRef {
    guard isLinkedAide, let shown, shown != ref, let member = members.first(where: { $0.ref == shown }), !member.showsMachineOffline else { return ref }
    return shown
  }
}

extension AideLink {
  /// Shown where a linked Percy lists chats from more than one machine.
  public static let sameOnEachMachine = "Percy is the same on each machine where you turned it on. A chat stays on the machine it was started on."

  /// Why a chat with Percy cannot move to another machine.
  public static let chatStaysOnItsMachine = "A chat with Percy stays on the machine it was started on, so it cannot be handed off."

  public static func offlineLine(machine: String) -> String {
    "\(machine.isEmpty ? "A machine" : machine) is offline: its chats appear when it is back"
  }
}
