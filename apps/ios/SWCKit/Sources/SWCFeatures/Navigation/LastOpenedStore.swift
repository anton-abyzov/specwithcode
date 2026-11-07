import Foundation
import SWCSync

/// The chat at the root of the main stack and the thread pushed on it, kept
/// so a cold start opens them again.
nonisolated struct LastOpened: Codable, Equatable, Sendable {
  var root: ChatTarget
  var thread: ThreadRef?
}

/// Keeps the last opened chat in UserDefaults. Only the app's own router has
/// one, so tests and sample data never write it.
struct LastOpenedStore {
  static let key = "swc.lastOpened"
  let defaults: UserDefaults

  init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
  }

  func load() -> LastOpened? {
    guard let data = defaults.data(forKey: Self.key) else { return nil }
    return try? JSONDecoder().decode(LastOpened.self, from: data)
  }

  func save(_ value: LastOpened?) {
    guard let value, let data = try? JSONEncoder().encode(value) else {
      defaults.removeObject(forKey: Self.key)
      return
    }
    defaults.set(data, forKey: Self.key)
  }
}
