import Foundation
import os
import SWCWire

/// What the phone keeps about its machines between launches, beside the
/// machine registry: the machines the user removed (so fleet linking never
/// adds them back), when each machine was last connected, and its last
/// thread list, so an unreachable machine's threads stay listed as unknown
/// instead of disappearing.
public actor FleetCache {
  public struct Cached: Sendable, Hashable {
    public var snapshot: ShellSnapshot?
    public var lastSeenAt: Date?
  }

  struct State: Codable, Hashable {
    var dismissed: Set<String> = []
    var lastSeen: [String: Date] = [:]
    /// Labels the main machine's roster reported, for machines never connected.
    var labels: [String: String] = [:]
  }

  static let log = Logger(subsystem: "com.specwithcode.ios", category: "fleet")

  public let directory: URL
  private var state: State?

  public init(directory: URL) {
    self.directory = directory
  }

  private var stateURL: URL { directory.appendingPathComponent("fleet.json") }

  private func shellURL(_ environmentId: String) -> URL {
    let safe = environmentId.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? environmentId
    return directory.appendingPathComponent("shells", isDirectory: true).appendingPathComponent("\(safe).json")
  }

  private func load() -> State {
    if let state { return state }
    let loaded = (try? Data(contentsOf: stateURL)).flatMap { try? WireCoding.decoder.decode(State.self, from: $0) } ?? State()
    state = loaded
    return loaded
  }

  private func change(_ body: (inout State) -> Void) {
    var next = load()
    body(&next)
    guard next != state else { return }
    state = next
    do {
      try write(WireCoding.encoder.encode(next), to: stateURL)
    } catch {
      Self.log.error("Could not save fleet.json: \(String(describing: error), privacy: .public)")
    }
  }

  // MARK: Dismissed machines

  public func dismissed() -> Set<String> { load().dismissed }

  public func dismiss(_ environmentId: String) {
    change { $0.dismissed.insert(environmentId) }
    try? FileManager.default.removeItem(at: shellURL(environmentId))
    change {
      $0.lastSeen[environmentId] = nil
      $0.labels[environmentId] = nil
    }
  }

  /// Pairing a machine by hand undoes its removal.
  public func undismiss(_ environmentId: String) {
    change { $0.dismissed.remove(environmentId) }
  }

  // MARK: Last seen and thread lists

  public func cached(_ environmentId: String) -> Cached {
    let snapshot = (try? Data(contentsOf: shellURL(environmentId))).flatMap { try? WireCoding.decoder.decode(ShellSnapshot.self, from: $0) }
    return Cached(snapshot: snapshot, lastSeenAt: load().lastSeen[environmentId])
  }

  public func lastSeen() -> [String: Date] { load().lastSeen }

  public func setLastSeen(_ date: Date, for environmentId: String) {
    change { $0.lastSeen[environmentId] = date }
  }

  public func saveSnapshot(_ snapshot: ShellSnapshot, for environmentId: String) {
    do {
      try write(WireCoding.encoder.encode(snapshot), to: shellURL(environmentId))
    } catch {
      Self.log.error("Could not cache the thread list of \(environmentId, privacy: .public): \(String(describing: error), privacy: .public)")
    }
  }

  public func labels() -> [String: String] { load().labels }

  public func setLabels(_ labels: [String: String]) {
    change { $0.labels.merge(labels) { _, new in new } }
  }

  private func write(_ data: Data, to url: URL) throws {
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    #if os(iOS)
    try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    #else
    try data.write(to: url, options: [.atomic])
    #endif
  }
}
