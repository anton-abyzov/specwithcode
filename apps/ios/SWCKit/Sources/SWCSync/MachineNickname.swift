import Foundation
import SWCWire

/// The short name a machine goes by on thread rows, the orchestrator switcher
/// and notices ("M4", "Minis"). Mirrors the web's `resolveMachineNickname`:
/// the user's nickname for the machine's environment id when one is set, else
/// its short name. Never shorten a resolved name again.
public enum MachineNickname {
  /// Longest nickname the user can set.
  public static let maximumLength = 16

  /// Every machine's nickname, from the settings of all the machines the phone
  /// knows. Mirrors the shared `mergeMachineNicknames`: the newest stamp wins,
  /// and equal stamps keep the greater name so every device agrees.
  public static func merge(_ maps: [[String: MachineNicknameEntry]]) -> [String: String] {
    var merged: [String: MachineNicknameEntry] = [:]
    for map in maps {
      for (environmentId, entry) in map {
        merged[environmentId] = newer(merged[environmentId], entry)
      }
    }
    return merged.mapValues(\.name)
  }

  static func newer(_ current: MachineNicknameEntry?, _ incoming: MachineNicknameEntry) -> MachineNicknameEntry {
    guard let current else { return incoming }
    let difference = stamp(incoming) - stamp(current)
    if difference != 0 { return difference > 0 ? incoming : current }
    // JavaScript compares strings by UTF-16 code unit.
    return current.name.utf16.lexicographicallyPrecedes(incoming.name.utf16) ? incoming : current
  }

  /// Milliseconds, as `Date.parse`; an unreadable stamp loses to any real one.
  private static func stamp(_ entry: MachineNicknameEntry) -> Double {
    guard let date = WireCoding.parseDate(entry.updatedAt) else { return 0 }
    return (date.timeIntervalSince1970 * 1000).rounded()
  }

  /// The machine's nickname, else its label without the owner, else its id.
  public static func resolve(environmentId: String, label: String, nicknames: [String: String] = [:]) -> String {
    known(environmentId: environmentId, label: label, nicknames: nicknames) ?? environmentId
  }

  /// The nickname or the label without the owner; nil when neither names it.
  public static func known(environmentId: String, label: String, nicknames: [String: String] = [:]) -> String? {
    let nickname = normalize(nicknames[environmentId] ?? "")
    if !nickname.isEmpty { return nickname }
    let name = shortName(label)
    return name.isEmpty ? nil : name
  }

  /// Mirrors the shared `normalizeMachineNickname`: trims, collapses inner
  /// whitespace and keeps the first 16 UTF-16 units, as JavaScript's `slice`.
  public static func normalize(_ name: String) -> String {
    let collapsed = name.trimmingCharacters(in: .whitespacesAndNewlines)
      .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
    var units = 0
    var kept = String.UnicodeScalarView()
    for scalar in collapsed.unicodeScalars {
      units += scalar.utf16.count
      guard units <= maximumLength else { break }
      kept.append(scalar)
    }
    return String(kept).trimmingCharacters(in: .whitespacesAndNewlines)
  }

  /// Drops a possessive owner prefix: "Sam's MacBook M4MAX" reads "MacBook
  /// M4MAX". Every machine is the user's own, so the owner adds nothing.
  public static func shortName(_ label: String) -> String {
    let trimmed = label.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let range = trimmed.range(of: #"^[^\s'’]+['’]s\s+"#, options: .regularExpression) else { return trimmed }
    let rest = trimmed[range.upperBound...]
    return rest.isEmpty ? trimmed : String(rest)
  }
}

/// Where a thread lives and runs, by machine nickname.
public struct ThreadPlacement: Hashable, Sendable {
  /// The machine the thread lives on.
  public var owner: String
  /// The machine it runs on, when that is another machine.
  public var runsOn: String?
  /// Set when the machine that answers for the thread is unreachable: its
  /// state is unknown, never idle or missing.
  public var unknown: Unknown?

  public struct Unknown: Hashable, Sendable {
    /// The unreachable machine.
    public var machine: String
    /// When the phone last had it connected; nil when it never did.
    public var lastSeenAt: Date?

    public init(machine: String, lastSeenAt: Date?) {
      self.machine = machine
      self.lastSeenAt = lastSeenAt
    }
  }

  public init(owner: String, runsOn: String? = nil, unknown: Unknown? = nil) {
    self.owner = owner
    self.runsOn = runsOn
    self.unknown = unknown
  }

  /// "M4", or "M4 → Minis" when it lives on M4 and runs on Minis.
  public var label: String {
    guard let runsOn else { return owner }
    return "\(owner) → \(runsOn)"
  }

  /// "Unknown · last seen 2:05 PM" while the machine that answers for the
  /// thread is unreachable. Names that machine when the row's label ends with
  /// another one: "Unknown · M4 last seen 2:05 PM" on "M4 → Minis".
  public func unknownLabel(now: Date = .now, calendar: Calendar = .current, locale: Locale = .current) -> String? {
    guard let unknown else { return nil }
    let named = unknown.machine == (runsOn ?? owner) ? "" : "\(unknown.machine) "
    guard let seen = unknown.lastSeenAt else { return "Unknown · \(named)not reached yet" }
    return "Unknown · \(named)last seen \(Self.seenTime(seen, now: now, calendar: calendar, locale: locale))"
  }

  /// The row subtitle: "M4 → Minis", or "M4 · Unknown · last seen 2:05 PM".
  public func subtitle(now: Date = .now, calendar: Calendar = .current, locale: Locale = .current) -> String {
    guard let unknown = unknownLabel(now: now, calendar: calendar, locale: locale) else { return label }
    return "\(label) · \(unknown)"
  }

  /// A clock time today, else the date and time.
  public static func seenTime(_ date: Date, now: Date, calendar: Calendar, locale: Locale) -> String {
    var style = Date.FormatStyle(date: .omitted, time: .shortened, locale: locale, calendar: calendar, timeZone: calendar.timeZone)
    if !calendar.isDate(date, inSameDayAs: now) {
      style = Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone).month(.abbreviated).day().hour().minute()
    }
    return date.formatted(style)
  }
}
