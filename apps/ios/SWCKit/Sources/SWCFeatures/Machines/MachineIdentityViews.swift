import SwiftUI
import SWCSync
import Weave

// A machine's color and icon, as the desktop shows them: the color always
// comes with the machine's name or icon, never alone.

extension MachineColor {
  /// The hue the desktop gives the same palette id (`[data-machine-color]`).
  var color: Color {
    switch self {
    case .violet: Color(red: 0x73 / 255, green: 0x57 / 255, blue: 0xE6 / 255)
    case .teal: Color(red: 0x0E / 255, green: 0x81 / 255, blue: 0x77 / 255)
    case .amber: Color(red: 0xA8 / 255, green: 0x65 / 255, blue: 0x0A / 255)
    case .rose: Color(red: 0xCC / 255, green: 0x3A / 255, blue: 0x66 / 255)
    case .blue: Color(red: 0x2F / 255, green: 0x6F / 255, blue: 0xD6 / 255)
    case .green: Color(red: 0x2F / 255, green: 0x80 / 255, blue: 0x40 / 255)
    case .orange: Color(red: 0xC2 / 255, green: 0x56 / 255, blue: 0x1A / 255)
    case .slate: Color(red: 0x5D / 255, green: 0x68 / 255, blue: 0x78 / 255)
    }
  }
}

extension MachineKind {
  var symbol: String {
    switch self {
    case .server: "server.rack"
    case .cloud: "cloud"
    case .linux: "terminal"
    case .desktop: "desktopcomputer"
    case .laptop: "laptopcomputer"
    case .macMini: "macmini"
    case .macStudio: "macstudio"
    }
  }
}

extension MachineSummary {
  /// The picked or detected hardware, else a guess from the platform.
  var symbol: String {
    if let kind { return kind.symbol }
    let platform = platform?.lowercased() ?? ""
    return platform.contains("linux") || platform.contains("windows") ? "server.rack" : "laptopcomputer"
  }
}

extension AppModel {
  /// Every machine's color: the fleet's, or the defaults for the machines listed here.
  var machineIdentities: MachineIdentities {
    identities ?? MachineIdentities(known: machines.map(\.id))
  }

  func machineTint(_ environmentId: String) -> Color {
    machineIdentities.color(environmentId).color
  }

  /// The color of a machine a row names. Rows built without ids (a name
  /// alone) match a machine by that name; nil when none has it.
  func machineTint(id: String?, named name: String) -> Color? {
    if let id { return machineTint(id) }
    return machines.first { ThreadSummary.sameMachine($0.displayName, name) }.map { machineTint($0.id) }
  }

  /// What runs on a machine: "2 working · 5 projects", or that a machine
  /// that never answered is not counted.
  func activityLine(_ machine: MachineSummary) -> String {
    let working = allThreads.filter { $0.ref.environmentId == machine.id && $0.activity == .working && !$0.isResolved && !$0.isUnknown }.count
    return MachineActivity.line(counted: machine.isCounted, working: working, projects: projectsOn(machine.id, among: projects).count)
  }

  /// "■ M4", or "■ M4 → ■ Minis" for a thread that runs away from home.
  func placementText(_ thread: ThreadSummary) -> Text {
    let owner = MachineMark.text(thread.placement.owner, tint: machineTint(id: thread.ownerMachineId, named: thread.placement.owner))
    guard let runsOn = thread.placement.runsOn else { return owner }
    return Text("\(owner) → \(MachineMark.text(runsOn, tint: machineTint(id: thread.runsOnMachineId, named: runsOn)))")
  }

  /// `placementText`, then the rest of `ThreadPlacement.subtitle()`.
  func placementSubtitle(_ thread: ThreadSummary) -> Text {
    guard let unknown = thread.placement.unknownLabel() else { return placementText(thread) }
    return Text("\(placementText(thread)) · \(unknown)")
  }
}

/// A machine's name after a small square of its color, as the desktop's
/// sidebar and Overview name a machine.
struct MachineMark: View {
  let name: String
  let tint: Color?

  var body: some View {
    HStack(spacing: 4) {
      if let tint {
        RoundedRectangle(cornerRadius: 2, style: .continuous)
          .fill(tint)
          .frame(width: 7, height: 7)
          .accessibilityHidden(true)
      }
      Text(name).lineLimit(1)
    }
  }

  /// The same mark inside a line of text.
  static func text(_ name: String, tint: Color?) -> Text {
    guard let tint else { return Text(verbatim: name) }
    let square = Text(Image(systemName: "square.fill")).font(.system(size: 7)).baselineOffset(1.5).foregroundStyle(tint).accessibilityHidden(true)
    return Text("\(square) \(Text(verbatim: name))")
  }

  /// Several machines on one line: "■ M4 · ■ Minis".
  static func text(_ machines: [ProjectMachine]) -> Text {
    machines.enumerated().reduce(Text(verbatim: "")) { line, item in
      let mark = text(item.element.name, tint: item.element.tint)
      return item.offset == 0 ? mark : Text("\(line) · \(mark)")
    }
  }
}
