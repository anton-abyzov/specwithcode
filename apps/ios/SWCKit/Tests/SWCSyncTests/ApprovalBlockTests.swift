import Foundation
import Testing
@testable import SWCSync

/// The "Allow this phone" block on every screen (1447 AC-01 to AC-03).
@Suite struct ApprovalBlockTests {
  let now = Date(timeIntervalSince1970: 1_795_000_000)
  let day: TimeInterval = 86_400

  private func waiting(_ id: String, _ label: String, code: String = "6X9SF6") -> MachineSummary {
    var machine = MachineSummary(id: id, label: label, status: .offline)
    machine.deviceApprovalCode = code
    return machine
  }

  @Test func titleNamesOneMachineOrCountsSeveral() {
    #expect(ApprovalBlock.title(for: [waiting("a", "m1")]) == "Allow this phone on m1")
    #expect(ApprovalBlock.title(for: [waiting("a", "m1"), waiting("b", "M5")]) == "Allow this phone on 2 machines")
    #expect(ApprovalBlock.subtitle == "Type each code on its own machine.")
    #expect(ApprovalBlock.collapsedLine(count: 1) == "1 machine is waiting · Show codes")
    #expect(ApprovalBlock.collapsedLine(count: 3) == "3 machines are waiting · Show codes")
    #expect(ApprovalBlock.stopAskingQuestion == "Stop asking these machines?")
    #expect(ApprovalBlock.stopAskingMessage == "You can reconnect from each machine's page.")
  }

  @Test func opensByItselfUntilHidden() {
    #expect(!ApprovalBlock.isCollapsed(waiting: ["m1"], hide: nil, now: now))
    let hide = ApprovalBlock.hide(waiting: ["m1", "m5"], previous: nil, now: now)
    #expect(hide.machineIds == ["m1", "m5"])
    #expect(ApprovalBlock.isCollapsed(waiting: ["m1", "m5"], hide: hide, now: now))
    // A machine that allowed the phone leaves; the rest stay folded.
    #expect(ApprovalBlock.isCollapsed(waiting: ["m5"], hide: hide, now: now.addingTimeInterval(3600)))
  }

  @Test func onlyANewMachineOrThirtyDaysOpenItAgain() {
    let hide = ApprovalBlock.hide(waiting: ["m1"], previous: nil, now: now)
    #expect(!ApprovalBlock.isCollapsed(waiting: ["m1", "m5"], hide: hide, now: now.addingTimeInterval(60)))
    #expect(ApprovalBlock.isCollapsed(waiting: ["m1"], hide: hide, now: now.addingTimeInterval(29 * day)))
    #expect(!ApprovalBlock.isCollapsed(waiting: ["m1"], hide: hide, now: now.addingTimeInterval(30 * day)))
  }

  @Test func hidingAgainNeverStretchesAnEarlierMachinesThirtyDays() {
    let first = ApprovalBlock.hide(waiting: ["m1"], previous: nil, now: now)
    let second = ApprovalBlock.hide(waiting: ["m1", "m5"], previous: first, now: now.addingTimeInterval(20 * day))
    #expect(second.hiddenAt == ["m1": now, "m5": now.addingTimeInterval(20 * day)])
    // m1's own 30 days run out first, and the block opens for it.
    #expect(ApprovalBlock.isCollapsed(waiting: ["m1", "m5"], hide: second, now: now.addingTimeInterval(29 * day)))
    #expect(!ApprovalBlock.isCollapsed(waiting: ["m1", "m5"], hide: second, now: now.addingTimeInterval(30 * day)))
    #expect(ApprovalBlock.isCollapsed(waiting: ["m5"], hide: second, now: now.addingTimeInterval(30 * day)))
    // An expired entry is dropped and its machine starts a new 30 days.
    let late = ApprovalBlock.hide(waiting: ["m1"], previous: second, now: now.addingTimeInterval(31 * day))
    #expect(late.hiddenAt == ["m1": now.addingTimeInterval(31 * day), "m5": now.addingTimeInterval(20 * day)])
  }

  @MainActor @Test func theHideIsKeptPerPhoneAndHoldsNoCode() throws {
    let suite = "approval-block-tests-\(UUID().uuidString)"
    let defaults = try #require(UserDefaults(suiteName: suite))
    defer { defaults.removePersistentDomain(forName: suite) }
    let store = ApprovalBlockHideStore(defaults: defaults)
    let hide = ApprovalBlock.hide(waiting: ["m1"], previous: nil, now: now)
    store.save(hide, phone: "7KQ2")
    // A new store reads the same disk, as after an app restart.
    #expect(ApprovalBlockHideStore(defaults: defaults).load(phone: "7KQ2") == hide)
    #expect(store.load(phone: "9ZZ1") == nil)
    let stored = try #require(defaults.data(forKey: "approvalBlock.hidden.7KQ2"))
    let text = String(decoding: stored, as: UTF8.self)
    #expect(text.contains("m1") && !text.contains("6X9SF6"))
    store.save(nil, phone: "7KQ2")
    #expect(store.load(phone: "7KQ2") == nil)
    // A Hide made before the short ID arrived still counts once it does,
    // and moves under the short ID at the next save.
    store.save(hide, phone: nil)
    #expect(store.load(phone: "7KQ2") == hide)
    store.save(hide, phone: "7KQ2")
    #expect(defaults.data(forKey: "approvalBlock.hidden.unknown") == nil)
  }

  /// Allowed, refused or paused machines leave; an unreachable one keeps its row.
  @MainActor @Test func theListHoldsEveryMachineStillWaiting() {
    let model = AppModel(engine: FixtureEngine(scenario: .empty))
    var unreachable = waiting("far", "Travel laptop", code: "5F5646")
    unreachable.approvalReachable = false
    var paused = waiting("off", "old")
    paused.isDisconnected = true
    var allowed = waiting("ok", "m4")
    allowed.status = .connected
    let refused = MachineSummary(id: "no", label: "m2", status: .offline)
    model.machines = [waiting("m1", "m1", code: "K7QX2M"), unreachable, paused, allowed, refused]
    let list = model.machinesAwaitingApproval()
    #expect(list.map(\.id) == ["m1", "far"])
    #expect(list.map(\.deviceApprovalCode) == ["K7QX2M", "5F5646"])
    #expect(list[1].approvalUnreachableNote == "Travel laptop isn't reachable right now.")
    // A new code shows as soon as the model has it.
    model.machines[0].deviceApprovalCode = "BWQ35F"
    #expect(model.machinesAwaitingApproval().first?.deviceApprovalCode == "BWQ35F")
  }

  /// The sample data the screenshots use: the Office Mac allowed, two waiting.
  @MainActor @Test func theApprovalFixtureKeepsOneMachineAllowed() {
    let model = AppModel(engine: FixtureEngine(scenario: .approval))
    let ids = model.machinesAwaitingApproval().map(\.id)
    #expect(ids == ["env-build-box", "env-travel-laptop"])
    #expect(model.thisPhoneLine == "This phone: iPhone 16 Pro · ID 7KQ2")
  }
}
