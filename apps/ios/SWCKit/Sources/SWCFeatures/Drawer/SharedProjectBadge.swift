import SwiftUI
import SWCSync
import Weave

/// How a project linked across machines reads in the sidebar, as the desktop's
/// `sharedProjectBadge`: shared from the copy the row opens, or handed off
/// when that copy's coordinator runs on another machine.
struct SharedProjectBadge: Equatable {
  enum Role: Equatable {
    /// The row's copy runs the coordinator.
    case coordinator
    /// Its coordinator is on another machine; this copy runs workers.
    case workers
  }

  let role: Role
  let label: String

  var symbol: String {
    role == .coordinator ? "point.3.connected.trianglepath.dotted" : "arrow.left.arrow.right"
  }

  /// The badge for a project row, named by machine; nil for a personal project
  /// or one linked to no other machine. Reads the linked project's own member
  /// list and the row's linked copies, never how many machines are paired, so
  /// it shows with one paired machine and not for an unlinked same-folder copy.
  static func of(_ project: ProjectSummary, nameOf: (String) -> String) -> SharedProjectBadge? {
    guard project.kind != .personal else { return nil }
    let here = project.ref.environmentId
    var seen = Set([here])
    let others = (project.linkedMachineIds + project.members.filter(\.isLinked).map(\.ref.environmentId))
      .filter { seen.insert($0).inserted }
    guard !others.isEmpty else { return nil }
    if let coordinator = project.coordinatorElsewhereId {
      return SharedProjectBadge(role: .workers, label: "Handed off: coordinator on \(nameOf(coordinator)), \(nameOf(here)) runs workers")
    }
    return SharedProjectBadge(role: .coordinator, label: "Shared from \(nameOf(here)) with \(others.map(nameOf).joined(separator: ", "))")
  }
}

extension AppModel {
  /// A machine's name for a shared project's badge: its nickname here, else the
  /// name a copy of the project carries, else "another machine".
  func sharedProjectBadge(_ project: ProjectSummary) -> SharedProjectBadge? {
    SharedProjectBadge.of(project) { id in
      if let machine = machine(id) { return machine.displayName }
      if let label = project.members.first(where: { $0.ref.environmentId == id })?.machineLabel, !label.isEmpty { return label }
      return id == project.ref.environmentId && !project.machineLabel.isEmpty ? project.machineLabel : "another machine"
    }
  }
}

/// The small trailing glyph a shared project row wears.
struct SharedProjectGlyph: View {
  let badge: SharedProjectBadge

  var body: some View {
    Image(systemName: badge.symbol)
      .font(.system(size: 12, weight: .semibold))
      .foregroundStyle(Color.weave.iris)
      .accessibilityHidden(true)
  }
}
