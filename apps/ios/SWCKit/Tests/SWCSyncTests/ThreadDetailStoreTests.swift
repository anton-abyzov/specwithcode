import Foundation
import Testing
@testable import SWCSync

/// A thread's own Show level, kept on the phone, and the chat menu's rule.
@Suite struct ThreadDetailStoreTests {
  let a = ThreadRef(environmentId: "m4", threadId: "a")
  let b = ThreadRef(environmentId: "m4", threadId: "b")
  let otherMachine = ThreadRef(environmentId: "m1", threadId: "a")

  func freshDefaults(_ name: String) -> UserDefaults {
    let defaults = UserDefaults(suiteName: "ThreadDetailStoreTests.\(name)")!
    defaults.removePersistentDomain(forName: "ThreadDetailStoreTests.\(name)")
    return defaults
  }

  @Test func aThreadKeepsItsOwnLevelKeyedByMachineAndThread() {
    let store = ThreadDetailStore().setting(.verbose, for: a)
    #expect(store.detail(for: a) == .verbose)
    #expect(store.detail(for: b) == nil)
    #expect(store.detail(for: otherMachine) == nil)
    #expect(ThreadDetailStore.key(a) == "m4:a")
    #expect(store.setting(nil, for: a).detail(for: a) == nil)
  }

  @Test func atMostThreeHundredThreadsAreRememberedOldestDroppedFirst() {
    var store = ThreadDetailStore()
    for index in 0...ThreadDetailStore.limit {
      store = store.setting(.concise, for: ThreadRef(environmentId: "m4", threadId: "t\(index)"))
    }
    #expect(store.entries.count == ThreadDetailStore.limit)
    #expect(store.detail(for: ThreadRef(environmentId: "m4", threadId: "t0")) == nil)
    #expect(store.detail(for: ThreadRef(environmentId: "m4", threadId: "t1")) == .concise)
    // Choosing again makes a thread the newest, so it outlives the others.
    store = store.setting(.verbose, for: ThreadRef(environmentId: "m4", threadId: "t1"))
    store = store.setting(.normal, for: ThreadRef(environmentId: "m4", threadId: "new"))
    #expect(store.detail(for: ThreadRef(environmentId: "m4", threadId: "t1")) == .verbose)
    #expect(store.detail(for: ThreadRef(environmentId: "m4", threadId: "t2")) == nil)
    #expect(store.entries.last?.key == "m4:new")
  }

  @Test func theStoreSurvivesARelaunchAndSkipsUnknownLevels() {
    let defaults = freshDefaults("relaunch")
    ThreadDetailStore().setting(.verbose, for: a).setting(.concise, for: b).save(to: defaults)
    #expect(ThreadDetailStore.stored(in: defaults).entries.map(\.key) == ["m4:a", "m4:b"])
    defaults.set([["m4:a", "huge"], ["m4:b", "normal"], ["broken"]], forKey: ThreadDetailStore.defaultsKey)
    let read = ThreadDetailStore.stored(in: defaults)
    #expect(read.detail(for: a) == nil)
    #expect(read.detail(for: b) == .normal)
  }

  @Test func aThreadFollowsThePhoneDefaultUntilItHasItsOwn() {
    let choice = TimelineDetailChoice(phoneDefault: .normal, threads: ThreadDetailStore())
    #expect(choice.resolved(for: a) == .normal)
    #expect(choice.scope(for: a) == .everyThread)
    let own = choice.choosing(.verbose, scope: .thisThread, for: a)
    #expect(own.resolved(for: a) == .verbose)
    #expect(own.resolved(for: b) == .normal)
    #expect(own.phoneDefault == .normal)
    #expect(own.scope(for: a) == .thisThread)
  }

  @Test func choosingUnderEveryThreadSetsTheDefaultAndTheThreadFollows() {
    let choice = TimelineDetailChoice(phoneDefault: .normal, threads: ThreadDetailStore().setting(.verbose, for: b))
    let next = choice.choosing(.concise, scope: .everyThread, for: a)
    #expect(next.phoneDefault == .concise)
    #expect(next.resolved(for: a) == .concise)
    #expect(next.scope(for: a) == .everyThread)
    // Another thread's own level is left alone.
    #expect(next.resolved(for: b) == .verbose)
  }

  @Test func switchingToEveryThreadDropsTheOwnLevelAndThisThreadPinsTheShownOne() {
    let pinned = TimelineDetailChoice(phoneDefault: .normal, threads: ThreadDetailStore().setting(.verbose, for: a))
    let dropped = pinned.changingScope(to: .everyThread, for: a)
    #expect(dropped.resolved(for: a) == .normal)
    #expect(dropped.scope(for: a) == .everyThread)
    #expect(dropped.phoneDefault == .normal)
    let pinnedAgain = dropped.changingScope(to: .thisThread, for: a)
    #expect(pinnedAgain.scope(for: a) == .thisThread)
    #expect(pinnedAgain.threads.detail(for: a) == .normal)
    // The default changing later leaves the pinned thread as it was.
    let later = pinnedAgain.choosing(.concise, scope: .everyThread, for: b)
    #expect(later.resolved(for: a) == .normal)
    #expect(later.resolved(for: b) == .concise)
  }

  @MainActor @Test func theModelResolvesEachChatByTheThreadItShows() {
    let defaults = freshDefaults("model")
    let model = AppModel(engine: FixtureEngine(scenario: .empty), defaults: defaults)
    let thread = ChatTarget.thread(a)
    let project = ChatTarget.project(ProjectRef(environmentId: "m4", projectId: "p"))
    let aide = ChatTarget.aide(ProjectRef(environmentId: "m4", projectId: "percy"))
    #expect(model.shownThread(for: project) == ThreadRef(environmentId: "m4", threadId: "project-coordinator:p"))

    model.chooseTimelineDetail(.verbose, scope: .thisThread, in: project)
    #expect(model.timelineDetail(for: project) == .verbose)
    #expect(model.timelineDetailScope(for: project) == .thisThread)
    #expect(model.timelineDetail(for: thread) == .normal)
    #expect(model.timelineDetail(for: aide) == .normal)

    model.chooseTimelineDetail(.concise, scope: .everyThread, in: thread)
    #expect(model.timelineDetail == .concise)
    #expect(model.timelineDetail(for: aide) == .concise)
    #expect(model.timelineDetail(for: project) == .verbose)

    model.chooseTimelineDetailScope(.everyThread, in: project)
    #expect(model.timelineDetail(for: project) == .concise)

    // Both settings are kept on the phone.
    model.chooseTimelineDetailScope(.thisThread, in: aide)
    let relaunched = AppModel(engine: FixtureEngine(scenario: .empty), defaults: defaults)
    #expect(relaunched.timelineDetail == .concise)
    #expect(relaunched.timelineDetailScope(for: aide) == .thisThread)
    #expect(relaunched.timelineDetailScope(for: project) == .everyThread)
  }
}
