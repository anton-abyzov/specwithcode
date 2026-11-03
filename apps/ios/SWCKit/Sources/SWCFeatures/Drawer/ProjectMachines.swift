import SwiftUI
import SWCSync
import Weave

/// One machine a project is on, and how that machine is doing.
struct ProjectMachine: Identifiable, Hashable {
  let id: String
  let name: String
  let status: WeaveStatus
  let statusLabel: String
}

extension AppModel {
  /// The machines a project is on, the coordinator's first, once each even
  /// when a machine holds several checkouts of it.
  func machines(of project: ProjectSummary) -> [ProjectMachine] {
    let copies = project.members.isEmpty
      ? [(project.ref.environmentId, project.machineLabel, project.machineOnline)]
      : project.members.map { ($0.ref.environmentId, $0.machineLabel, $0.machineOnline) }
    var seen = Set<String>()
    return copies.compactMap { id, label, online in
      guard seen.insert(id).inserted else { return nil }
      if let machine = machine(id) {
        return ProjectMachine(id: id, name: machine.displayName, status: machine.displayStatus, statusLabel: machine.statusLabel)
      }
      let status: WeaveStatus = online ? .online : .offline
      return ProjectMachine(id: id, name: label, status: status, statusLabel: status.label)
    }
  }

  /// The projects a machine chip keeps: those with a copy on that machine.
  func projectsOn(_ machine: String?, among projects: [ProjectSummary]) -> [ProjectSummary] {
    guard let machine else { return projects }
    return projects.filter { $0.ref.environmentId == machine || $0.members.contains { $0.ref.environmentId == machine } }
  }
}

extension [ProjectMachine] {
  /// "On m1, online; m4, offline", for VoiceOver.
  var spoken: String {
    isEmpty ? "" : "On " + map { "\($0.name), \($0.statusLabel.lowercased())" }.joined(separator: "; ")
  }
}

/// A project's machines on one line, each with its status dot. When the row
/// is too narrow for all of them, the last ones fold into "+N"; at the largest
/// text sizes the names wrap instead, so every name stays readable.
struct ProjectMachinesLine: View {
  let machines: [ProjectMachine]
  @Environment(\.dynamicTypeSize) private var typeSize

  var body: some View {
    if typeSize.isAccessibilitySize {
      wrapped
    } else {
      ViewThatFits(in: .horizontal) {
        ForEach(Array(stride(from: machines.count, through: 1, by: -1)), id: \.self) { shown in
          line(shown)
        }
        wrapped
      }
    }
  }

  private func line(_ shown: Int) -> some View {
    HStack(spacing: WeaveSpacing.s2) {
      ForEach(machines.prefix(shown)) { machine in
        HStack(spacing: 4) {
          StatusDot(machine.status, size: 7)
          Text(machine.name).lineLimit(1)
        }
        .fixedSize()
      }
      if shown < machines.count {
        Text("+\(machines.count - shown)").fixedSize()
      }
    }
    .font(.weave(.footnote))
    .foregroundStyle(Color.weave.muted)
  }

  private var wrapped: some View {
    Text(machines.map(\.name).joined(separator: ", "))
      .font(.weave(.footnote))
      .foregroundStyle(Color.weave.muted)
      .fixedSize(horizontal: false, vertical: true)
  }
}
