import Foundation

/// Which threads a Show choice in a chat's menu changes.
public enum TimelineDetailScope: String, CaseIterable, Hashable, Sendable, Identifiable {
  /// The open thread gets its own level.
  case thisThread
  /// The phone's default, which every thread without its own level follows.
  case everyThread

  public var id: String { rawValue }

  public var label: String {
    switch self {
    case .thisThread: "This thread"
    case .everyThread: "Every thread"
    }
  }
}

/// Threads with their own Show level, kept on this phone. The same rule as
/// the desktop's `threadTimelineDetail` (apps/web/src/timelineDetail.ts): at
/// most `limit` threads are remembered and the oldest choice goes first.
public struct ThreadDetailStore: Hashable, Sendable {
  public struct Entry: Hashable, Sendable {
    public var key: String
    public var detail: TimelineDetail
    public init(key: String, detail: TimelineDetail) {
      self.key = key
      self.detail = detail
    }
  }

  public static let limit = 300
  public static let defaultsKey = "threadTimelineDetail"

  /// Oldest choice first, newest last.
  public private(set) var entries: [Entry]

  public init(entries: [Entry] = []) {
    self.entries = Array(entries.suffix(Self.limit))
  }

  /// The key a thread's level is kept under: its machine and thread id.
  public static func key(_ thread: ThreadRef) -> String {
    "\(thread.environmentId):\(thread.threadId)"
  }

  public func detail(for thread: ThreadRef) -> TimelineDetail? {
    let key = Self.key(thread)
    return entries.last { $0.key == key }?.detail
  }

  /// The store with the thread's own level set, as the newest choice, or
  /// removed for nil so the thread follows the default again.
  public func setting(_ detail: TimelineDetail?, for thread: ThreadRef) -> ThreadDetailStore {
    let key = Self.key(thread)
    var next = entries.filter { $0.key != key }
    if let detail { next.append(Entry(key: key, detail: detail)) }
    return ThreadDetailStore(entries: next)
  }

  /// The levels saved on this phone. Entries with an unknown level are dropped.
  public static func stored(in defaults: UserDefaults = .standard) -> ThreadDetailStore {
    let raw = defaults.array(forKey: defaultsKey) as? [[String]] ?? []
    return ThreadDetailStore(entries: raw.compactMap { pair in
      guard pair.count == 2, let detail = TimelineDetail(rawValue: pair[1]) else { return nil }
      return Entry(key: pair[0], detail: detail)
    })
  }

  public func save(to defaults: UserDefaults = .standard) {
    defaults.set(entries.map { [$0.key, $0.detail.rawValue] }, forKey: Self.defaultsKey)
  }
}

/// The Show level of one chat and how a choice in its menu changes it.
/// Pure, so the rule is tested apart from the views.
public struct TimelineDetailChoice: Hashable, Sendable {
  /// The phone's default for every thread.
  public var phoneDefault: TimelineDetail
  public var threads: ThreadDetailStore

  public init(phoneDefault: TimelineDetail, threads: ThreadDetailStore) {
    self.phoneDefault = phoneDefault
    self.threads = threads
  }

  /// The thread's own level, else the phone's default.
  public func resolved(for thread: ThreadRef?) -> TimelineDetail {
    thread.flatMap { threads.detail(for: $0) } ?? phoneDefault
  }

  /// "This thread" while the thread has its own level, else "Every thread".
  public func scope(for thread: ThreadRef?) -> TimelineDetailScope {
    guard let thread, threads.detail(for: thread) != nil else { return .everyThread }
    return .thisThread
  }

  /// Choosing a level: under "This thread" the thread gets its own level;
  /// under "Every thread" the default changes and the thread follows it.
  public func choosing(_ detail: TimelineDetail, scope: TimelineDetailScope, for thread: ThreadRef?) -> TimelineDetailChoice {
    var next = self
    switch (scope, thread) {
    case let (.thisThread, thread?):
      next.threads = threads.setting(detail, for: thread)
    case (.everyThread, _), (.thisThread, nil):
      next.phoneDefault = detail
      if let thread { next.threads = threads.setting(nil, for: thread) }
    }
    return next
  }

  /// Switching scope: "Every thread" drops the thread's own level; "This
  /// thread" pins the level it shows now.
  public func changingScope(to scope: TimelineDetailScope, for thread: ThreadRef?) -> TimelineDetailChoice {
    guard let thread else { return self }
    var next = self
    switch scope {
    case .everyThread: next.threads = threads.setting(nil, for: thread)
    case .thisThread: next.threads = threads.setting(resolved(for: thread), for: thread)
    }
    return next
  }
}
