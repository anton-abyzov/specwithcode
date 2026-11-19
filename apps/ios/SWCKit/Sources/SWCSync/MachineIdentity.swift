import Foundation
import SWCWire

/// The eight hues a machine can wear, in the order every device shares
/// (`MACHINE_COLOR_IDS` in packages/contracts/src/settings.ts). The order
/// decides a machine's default color, so it never changes.
public enum MachineColor: String, CaseIterable, Hashable, Sendable {
  case violet, teal, amber, rose, blue, green, orange, slate
}

/// The hardware a machine is drawn as (`ENVIRONMENT_MACHINE_KINDS`).
public enum MachineKind: String, CaseIterable, Hashable, Sendable {
  case server, cloud, linux, desktop, laptop
  case macMini = "mac-mini"
  case macStudio = "mac-studio"
}

/// What a machine is told apart by: its name, color and icon.
public struct MachineIdentity: Hashable, Sendable {
  public var environmentId: String
  /// The nickname, else the host label without its owner.
  public var name: String
  public var color: MachineColor
  /// Nil when nobody picked one and the machine reports no hardware shape.
  public var icon: MachineKind?

  public init(environmentId: String, name: String, color: MachineColor, icon: MachineKind? = nil) {
    self.environmentId = environmentId
    self.name = name
    self.color = color
    self.icon = icon
  }
}

/// Every known machine's color and chosen icon. Mirrors the web's
/// `resolveMachineIdentities`, so a machine has one color on every device.
public struct MachineIdentities: Hashable, Sendable {
  /// Machines this phone knows: paired here or named by a fleet list.
  public var known: [String]
  /// The fleet's nickname entries, by environment id.
  public var entries: [String: MachineNicknameEntry]
  public private(set) var colors: [String: MachineColor]

  public init(known: [String] = [], entries: [String: MachineNicknameEntry] = [:]) {
    self.known = known
    self.entries = entries
    self.colors = Self.assignColors(known, entries: entries)
  }

  /// The machine's color. One first seen here (a handed-off thread's origin)
  /// still gets a stable color, stepping past the ones already taken.
  public func color(_ environmentId: String) -> MachineColor {
    colors[environmentId] ?? Self.assignColors(known + [environmentId], entries: entries)[environmentId] ?? .violet
  }

  /// The icon someone picked for the machine, when this build knows it.
  public func chosenIcon(_ environmentId: String) -> MachineKind? {
    entries[environmentId]?.icon.flatMap(MachineKind.init(rawValue:))
  }

  /// Mirrors the shared `assignMachineColors`: the color chosen for a machine,
  /// else a default from its id, stepping past colors already taken so no two
  /// machines share one while there are colors left. Machines in the nickname
  /// map settle first, from that map alone, which is synced across the fleet:
  /// a device's other machines never move them.
  public static func assignColors(_ environmentIds: [String], entries: [String: MachineNicknameEntry]) -> [String: MachineColor] {
    let named = entries.keys.sorted(by: precedes)
    let others = Set(environmentIds).filter { entries[$0] == nil }.sorted(by: precedes)
    var colors: [String: MachineColor] = [:]
    var taken = Set<MachineColor>()
    for id in named {
      guard let chosen = entries[id]?.color.flatMap(MachineColor.init(rawValue:)) else { continue }
      colors[id] = chosen
      taken.insert(chosen)
    }
    let palette = MachineColor.allCases
    for id in named + others where colors[id] == nil {
      let start = Int(hash(id) % UInt32(palette.count))
      let color = (0..<palette.count).lazy.map { palette[(start + $0) % palette.count] }.first { !taken.contains($0) } ?? palette[start]
      colors[id] = color
      taken.insert(color)
    }
    return colors
  }

  /// FNV-1a over UTF-16 code units, as the shared `hashMachineId`.
  static func hash(_ environmentId: String) -> UInt32 {
    var hash: UInt32 = 0x811c_9dc5
    for unit in environmentId.utf16 {
      hash ^= UInt32(unit)
      hash = hash &* 0x0100_0193
    }
    return hash
  }

  /// JavaScript's default sort: by UTF-16 code unit.
  private static func precedes(_ a: String, _ b: String) -> Bool {
    a.utf16.lexicographicallyPrecedes(b.utf16)
  }
}

/// What a machine's row says runs there (the web's `machineActivity`).
public enum MachineActivity {
  /// "2 working · 5 projects", "Nothing running · 1 project", or, for a
  /// machine that never answered, that its counts are unknown, not zero.
  public static func line(counted: Bool, working: Int, projects: Int) -> String {
    guard counted else { return "Chats and projects not counted" }
    let running = working == 0 ? "Nothing running" : "\(working) working"
    return "\(running) · \(projects) \(projects == 1 ? "project" : "projects")"
  }

  /// The state of a machine that never answered and is being tried again.
  public static let unreachable = "Can\u{2019}t reach it · retrying"
}
