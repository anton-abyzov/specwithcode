import Foundation
import Testing
import SWCSync
@testable import SWCFeatures

@Suite struct RecentChatGroupsTests {
  var calendar: Calendar {
    var c = Calendar(identifier: .gregorian)
    c.timeZone = TimeZone(identifier: "America/New_York")!
    return c
  }
  @Test func calendarBoundariesAndDST() {
    let now = calendar.date(from: DateComponents(year: 2026, month: 11, day: 2, hour: 0, minute: 5))!
    for (days, label) in [(-1, "Today"), (0, "Today"), (1, "Yesterday"), (2, "Previous 7 days"), (7, "Previous 7 days"), (8, "Previous 30 days"), (30, "Previous 30 days"), (31, "Older")] {
      let date = calendar.date(byAdding: .day, value: -days, to: now)!
      #expect(RecentChatGroups.bucket(date, now: now, calendar: calendar) == label)
    }
  }
  @Test func activityDatesAndEmptyGroups() {
    let now = Date()
    let row = ThreadSummary(ref: .init(environmentId: "m", threadId: "a"), title: "A", activity: .working,
      updatedAt: now, machineLabel: "M", machineOnline: true, activityAt: calendar.date(byAdding: .day, value: -4, to: now))
    #expect(RecentChatGroups([row], now: now, calendar: calendar).groups.map(\.label) == ["Previous 7 days"])
    #expect(RecentChatGroups([], now: now).groups.isEmpty)
  }
  @Test func activeAndHeldWorkOutrankSettlement() {
    var row = ThreadSummary(ref: .init(environmentId: "m", threadId: "a"), title: "A", activity: .working,
      updatedAt: .now, isResolved: true, machineLabel: "M", machineOnline: true)
    #expect(ThreadGroups([row]).working.count == 1)
    row.activity = .idle
    row.waitsOnUser = true
    #expect(ThreadGroups([row]).needsYou.count == 1)
    row.machineOnline = false
    #expect(ThreadGroups([row]).resolved.count == 1)
  }
}
