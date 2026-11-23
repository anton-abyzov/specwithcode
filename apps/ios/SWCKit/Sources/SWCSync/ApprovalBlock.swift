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

  /// True when the block stays one row: the person hid it less than 30 days
  /// ago and every machine waiting now was already waiting then. A new code,
  /// a reconnect or a restart keeps it hidden; a machine that was not waiting
  /// when it was hidden opens it again.
  public static func isCollapsed(waiting: [String], hide: ApprovalBlockHide?, now: Date) -> Bool {
    guard let hide, !waiting.isEmpty else { return false }
    guard now.timeIntervalSince(hide.hiddenAt) < hideLifetime else { return false }
    return Set(waiting).isSubset(of: hide.machineIds)
  }

  /// The record a Hide writes: the machines waiting now, plus those an earlier
  /// Hide that still counts already covered.
  public static func hide(waiting: [String], previous: ApprovalBlockHide?, now: Date) -> ApprovalBlockHide {
    var ids = Set(waiting)
    if let previous, now.timeIntervalSince(previous.hiddenAt) < hideLifetime { ids.formUnion(previous.machineIds) }
    return ApprovalBlockHide(hiddenAt: now, machineIds: ids)
  }
}

/// When the person hid the block and which machines were waiting then.
/// Machine ids only: a code is never stored.
public struct ApprovalBlockHide: Codable, Hashable, Sendable {
  public var hiddenAt: Date
  public var machineIds: Set<String>

  public init(hiddenAt: Date, machineIds: Set<String>) {
    self.hiddenAt = hiddenAt
    self.machineIds = machineIds
  }
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

  public func load(phone shortID: String?) -> ApprovalBlockHide? {
    _ = revision
    let key = Self.key(shortID)
    guard let defaults else { return memory[key] }
    guard let data = defaults.data(forKey: key) else { return nil }
    return try? JSONDecoder().decode(ApprovalBlockHide.self, from: data)
  }

  public func save(_ hide: ApprovalBlockHide?, phone shortID: String?) {
    defer { revision += 1 }
    let key = Self.key(shortID)
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
