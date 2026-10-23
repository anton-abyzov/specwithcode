import Foundation
import SWCSync

/// Mirrors desktop shellModel.dateBucket, counting calendar days in the viewer's time zone.
nonisolated struct RecentChatGroups {
  static let labels = ["Today", "Yesterday", "Previous 7 days", "Previous 30 days", "Older"]
  let groups: [(label: String, threads: [ThreadSummary])]

  static func bucket(_ date: Date, now: Date, calendar: Calendar = .current) -> String {
    let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: date), to: calendar.startOfDay(for: now)).day ?? 31
    switch days {
    case ...0: return labels[0]
    case 1: return labels[1]
    case 2...7: return labels[2]
    case 8...30: return labels[3]
    default: return labels[4]
    }
  }

  init(_ threads: [ThreadSummary], now: Date = .now, calendar: Calendar = .current) {
    let sorted = threads.sorted {
      if $0.activityAt != $1.activityAt { return $0.activityAt > $1.activityAt }
      return ($0.ref.environmentId, $0.ref.threadId) < ($1.ref.environmentId, $1.ref.threadId)
    }
    let byDate = Dictionary(grouping: sorted) { Self.bucket($0.activityAt, now: now, calendar: calendar) }
    groups = Self.labels.compactMap { label in byDate[label].map { (label, $0) } }
  }
}
