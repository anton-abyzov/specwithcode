import Foundation
import Observation

/// The "Allow this phone" block every screen shows while machines wait to
/// allow this phone (1447): its words and when it opens by itself.
public enum ApprovalBlock {
  /// A Hide stops counting after this long, so the block opens by itself again.
  public static let hideLifetime: TimeInterval = 30 * 86_400

  public static let subtitle = "Type each code on its own machine."
  public static let stopAskingTitle = "Stop asking"
  public static let stopAskingQuestion = "Stop asking these machines?"
  public static let stopAskingMessage = "You can reconnect from each machine's page."

  /// "Allow this phone on m1", or "Allow this phone on 3 machines".
  public static func title(for waiting: [MachineSummary]) -> String {
    if waiting.count == 1, let only = waiting.first { return only.approvalTitle }
    return "Allow this phone on \(waiting.count) machines"
  }

  /// The one row the block keeps after Hide.
  public static func collapsedLine(count: Int) -> String {
    count == 1 ? "1 machine is waiting · Show codes" : "\(count) machines are waiting · Show codes"
  }

  /// True when the block stays one row: every machine waiting now was hidden
  /// less than 30 days ago. A new code, a reconnect or a restart keeps it
  /// hidden; a machine that was not waiting at its Hide opens it again.
  public static func isCollapsed(waiting: [String], hide: ApprovalBlockHide?, now: Date) -> Bool {
    guard let hide, !waiting.isEmpty else { return false }
    return waiting.allSatisfy { id in
      guard let at = hide.hiddenAt[id] else { return false }
      return now.timeIntervalSince(at) < hideLifetime
    }
  }

  /// The record a Hide writes: each machine waiting now is hidden from now;
  /// machines an earlier Hide covered keep their own time, so their 30 days
  /// are never stretched, and expired ones are dropped.
  public static func hide(waiting: [String], previous: ApprovalBlockHide?, now: Date) -> ApprovalBlockHide {
    var times = (previous?.hiddenAt ?? [:]).filter { now.timeIntervalSince($0.value) < hideLifetime }
    for id in waiting where times[id] == nil { times[id] = now }
    return ApprovalBlockHide(hiddenAt: times)
  }
}

/// When the person hid each machine's row. Machine ids and times only: a
/// code is never stored.
public struct ApprovalBlockHide: Codable, Hashable, Sendable {
  public var hiddenAt: [String: Date]

  public init(hiddenAt: [String: Date]) {
    self.hiddenAt = hiddenAt
  }

  public var machineIds: Set<String> { Set(hiddenAt.keys) }
}

/// Keeps the Hide on this phone, one record per phone short ID, so a phone
/// that pairs again under a new ID starts with the block open.
@MainActor @Observable
public final class ApprovalBlockHideStore {
  @ObservationIgnored private let defaults: UserDefaults?
  @ObservationIgnored private var memory: [String: ApprovalBlockHide] = [:]
  /// Bumped by `save`, so every block on screen reads the new Hide.
  private var revision = 0
  static let keyPrefix = "approvalBlock.hidden."

  /// `defaults` nil keeps the Hide in memory only (sample data, tests).
  public init(defaults: UserDefaults? = .standard) {
    self.defaults = defaults
  }

  /// A Hide made before this phone's short ID was known counts for it too.
  public func load(phone shortID: String?) -> ApprovalBlockHide? {
    _ = revision
    return read(Self.key(shortID)) ?? read(Self.key(nil))
  }

  private func read(_ key: String) -> ApprovalBlockHide? {
    guard let defaults else { return memory[key] }
    guard let data = defaults.data(forKey: key) else { return nil }
    return try? JSONDecoder().decode(ApprovalBlockHide.self, from: data)
  }

  /// Saving under the short ID retires a Hide kept before it was known.
  public func save(_ hide: ApprovalBlockHide?, phone shortID: String?) {
    defer { revision += 1 }
    let key = Self.key(shortID)
    if key != Self.key(nil) { write(nil, Self.key(nil)) }
    write(hide, key)
  }

  private func write(_ hide: ApprovalBlockHide?, _ key: String) {
    guard let defaults else { memory[key] = hide; return }
    if let hide, let data = try? JSONEncoder().encode(hide) {
      defaults.set(data, forKey: key)
    } else {
      defaults.removeObject(forKey: key)
    }
  }

  static func key(_ shortID: String?) -> String {
    let id = shortID?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return keyPrefix + (id.isEmpty ? "unknown" : id)
  }
}
