import Foundation

/// Whether Percy shows, and which machine creates it, from each machine's own
/// `aideEnabled` setting. Machines can disagree: the desktop writes the switch
/// only to the machines connected at the time. Pure, so it is tested without
/// sockets.
public enum AideSetting {
  /// What one paired machine says about Percy.
  public struct Machine: Sendable, Hashable {
    public var environmentId: String
    /// The name the person knows the machine by.
    public var displayName: String
    /// The pairing is switched on.
    public var enabled: Bool
    /// The machine's live setting; nil until its settings arrive.
    public var aideEnabled: Bool?
    /// The setting saved on the phone the last time the machine answered.
    public var cachedAideEnabled: Bool?
    public var canOperate: Bool
    /// The machine is connected or its thread list is saved on the phone, so
    /// its Percy may already be listed. A machine never reached has no say yet.
    public var listed: Bool

    public init(environmentId: String, displayName: String, enabled: Bool = true, aideEnabled: Bool?, cachedAideEnabled: Bool? = nil, canOperate: Bool = true, listed: Bool = true) {
      self.environmentId = environmentId
      self.displayName = displayName
      self.enabled = enabled
      self.aideEnabled = aideEnabled
      self.cachedAideEnabled = cachedAideEnabled
      self.canOperate = canOperate
      self.listed = listed
    }

    /// The live setting, or the saved one until it arrives.
    var known: Bool? { aideEnabled ?? cachedAideEnabled }
  }

  /// Any switched-on machine saying so shows Percy. While a switched-on machine that is
  /// connected or listed from the phone's cache has neither live nor saved
  /// settings, the previous answer stands, so Percy neither pops in nor
  /// vanishes on a cold start before every machine has answered.
  public static func visible(_ machines: [Machine], previous: Bool) -> Bool {
    if machines.contains(where: { $0.enabled && $0.known == true }) { return true }
    if machines.contains(where: { $0.enabled && $0.listed && $0.known == nil }) { return previous }
    return false
  }

  /// The machine that creates Percy: the lowest environment id whose own
  /// setting has Percy on, so the usual choice wins when it qualifies. Every
  /// machine given must have its live settings.
  /// - Throws: `aideDisabledOn` naming the lowest machine when none has it on,
  ///   `sendBlocked` when only read-only pairings have it on.
  public static func target(_ machines: [Machine], readOnlyReason: String) throws -> String {
    let sorted = machines.filter(\.enabled).sorted { $0.environmentId < $1.environmentId }
    let on = sorted.filter { $0.aideEnabled == true }
    guard !on.isEmpty else {
      let refusing = sorted.first(where: \.canOperate) ?? sorted.first
      if let refusing { throw SyncError.aideDisabledOn(label: refusing.displayName) }
      throw SyncError.aideDisabled
    }
    guard let target = on.first(where: \.canOperate) else { throw SyncError.sendBlocked(readOnlyReason) }
    return target.environmentId
  }
}
