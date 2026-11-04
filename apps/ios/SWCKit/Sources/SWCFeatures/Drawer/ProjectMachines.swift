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

  /// The machines a project's threads can be narrowed to, by name: the
  /// project's own, then any other machine one of its threads runs on.
  func threadMachines(of project: ProjectSummary, threads: [ThreadSummary]) -> [ProjectMachine] {
    var list: [ProjectMachine] = []
    for machine in machines(of: project) where !list.contains(where: { ThreadSummary.sameMachine($0.id, machine.name) }) {
      list.append(ProjectMachine(id: machine.name, name: machine.name, status: machine.status, statusLabel: machine.statusLabel))
    }
    for thread in threads where !list.contains(where: { thread.runs(on: $0.id) }) {
      let name = thread.runsOnMachine
      if let machine = machines.first(where: { ThreadSummary.sameMachine($0.displayName, name) }) {
        list.append(ProjectMachine(id: name, name: machine.displayName, status: machine.displayStatus, statusLabel: machine.statusLabel))
      } else {
        // Online describes where the thread lives; a machine it runs on that
        // this phone doesn't know reads as offline.
        let status: WeaveStatus = thread.placement.runsOn == nil && thread.machineOnline ? .online : .offline
        list.append(ProjectMachine(id: name, name: name, status: status, statusLabel: status.label))
      }
    }
    return list
  }

  /// The projects a machine chip keeps: those with a copy on that machine.
  func projectsOn(_ machine: String?, among projects: [ProjectSummary]) -> [ProjectSummary] {
    guard let machine else { return projects }
    return projects.filter { $0.ref.environmentId == machine || $0.members.contains { $0.ref.environmentId == machine } }
  }
}

extension ThreadSummary {
  /// The machine the thread runs on: where it lives unless it runs elsewhere.
  var runsOnMachine: String { placement.runsOn ?? placement.owner }

  /// Whether it runs on the machine with this name.
  func runs(on machine: String) -> Bool { Self.sameMachine(runsOnMachine, machine) }

  /// "Anton's M4" and "m4" name the same machine.
  static func sameMachine(_ a: String, _ b: String) -> Bool {
    MachineNickname.shortName(a).lowercased() == MachineNickname.shortName(b).lowercased()
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

/// All, then one chip per machine a project's threads run on, scrolling
/// sideways when they don't fit, like the status chips beside them.
struct ThreadMachineFilter: View {
  let machines: [ProjectMachine]
  @Binding var selection: String?

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: WeaveSpacing.s1) {
        chip(nil) { Text("All").font(.weave(.callout, weight: .medium)) }
        ForEach(machines) { machine in
          chip(machine.id) {
            HStack(spacing: WeaveSpacing.s1) {
              MachineBadge(status: machine.status, size: 15)
              Text(machine.name).font(.weave(.callout, weight: .medium))
            }
          }
          .accessibilityLabel("\(machine.name), \(machine.statusLabel)")
        }
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("threads.machine-chips")
  }

  /// The selection while it is one of the chips shown, else all of them.
  static func active(_ selection: String?, in machines: [ProjectMachine]) -> String? {
    guard let selection, machines.count > 1, machines.contains(where: { $0.id == selection }) else { return nil }
    return selection
  }

  private func chip<Label: View>(_ id: String?, @ViewBuilder label: () -> Label) -> some View {
    ColumnChip(selected: selection == id) {
      withAnimation(.snappy) { selection = id }
    } label: {
      label()
    }
  }
}
