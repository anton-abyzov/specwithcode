import Foundation
import Testing
import SWCWire
@testable import SWCSync

@Suite struct ThreadReducerTests {
  @Test func snapshotReplacesState() throws {
    let state = try TestData.threadState()
    #expect(state.sequence == 99)
    #expect(state.resumeSequence == 99)
    #expect(!state.partialTimeline)
    #expect(state.projection?.thread.id == "thr_1")
    #expect(state.projection?.visibleTurnItems.map(\.sourceItemId) == ["ti_1"])
  }

  @Test func eventsFromTheFixtureApplyInOrder() throws {
    var state = try TestData.threadState()
    for item in try TestData.threadEvents() {
      state.apply(item)
    }
    let projection = try #require(state.projection)
    #expect(state.sequence == 209)
    #expect(state.isSynchronized)
    #expect(projection.thread.isPinned)
    #expect(projection.runs.first { $0.id == "run_2" }?.status == .running)
    #expect(projection.messages.map(\.id).contains("msg_4"))
    #expect(projection.plans.map(\.id).contains("plan_p"))
    #expect(projection.runtimeRequests.map(\.id) == ["req_1", "req_2"])
    #expect(projection.runtimeRequest("req_2")?.isPending == false)
    // The streamed assistant message lands after the command (ordinal 1 after 0).
    #expect(projection.visibleTurnItems.map(\.sourceItemId) == ["ti_1", "ti_asst"])
    #expect(projection.visibleTurnItems.map(\.position) == [0, 1])
  }

  @Test func newItemIsOrderedByOrdinal() throws {
    var state = try TestData.threadState()
    var (sequence, event) = try TestData.event(5)
    var early = try TestData.turnItem("ti_user")
    early.threadId = "thr_1"
    early.runId = "run_1"
    early.ordinal = -1
    event.payload = .turnItem(early)
    let changed1 = state.apply(.event(sequence: sequence, event: event))
    #expect(changed1)
    #expect(state.projection?.visibleTurnItems.map(\.sourceItemId) == ["ti_user", "ti_1"])

    // Updating an existing item keeps one row.
    early.status = .failed
    event.payload = .turnItem(early)
    sequence += 1
    let changed2 = state.apply(.event(sequence: sequence, event: event))
    #expect(changed2)
    #expect(state.projection?.visibleTurnItems.count == 2)
    #expect(state.projection?.visibleTurnItems.first?.item.status == .failed)
    #expect(state.projection?.turnItems.count == 2)
  }

  @Test func rolledBackRunHidesItsItems() throws {
    var state = try TestData.threadState()
    let (sequence, original) = try TestData.event(3)
    var event = original
    var run = try #require(state.projection?.runs.first { $0.id == "run_1" })
    run.status = .rolledBack
    event.payload = .run(run)
    let changed3 = state.apply(.event(sequence: sequence, event: event))
    #expect(changed3)
    #expect(state.projection?.visibleTurnItems.isEmpty == true)
    #expect(state.projection?.turnItems.count == 1)
  }

  @Test func oldSequencesAreIgnored() throws {
    var state = try TestData.threadState()
    let (_, event) = try TestData.event(0)
    let changed4 = state.apply(.event(sequence: 99, event: event))
    #expect(!changed4)
    let changed5 = state.apply(.event(sequence: 50, event: event))
    #expect(!changed5)
    #expect(state.projection?.thread.isPinned == false)
    let changed6 = state.apply(.event(sequence: 100, event: event))
    #expect(changed6)
    #expect(state.projection?.thread.isPinned == true)
  }

  @Test func eventsBeforeTheSnapshotAreIgnored() throws {
    var state = ThreadState()
    let (sequence, event) = try TestData.event(0)
    let changed7 = state.apply(.event(sequence: sequence, event: event))
    #expect(!changed7)
    #expect(state.projection == nil)
    #expect(state.resumeSequence == nil)
  }

  @Test func otherThreadsEventsAreIgnored() throws {
    var state = try TestData.threadState()
    var (sequence, event) = try TestData.event(4)
    event.threadId = "thr_other"
    let changed8 = state.apply(.event(sequence: sequence, event: event))
    #expect(!changed8)
    #expect(state.projection?.messages.count == 1)
    #expect(state.sequence == sequence)
  }

  @Test func visitDoesNotBumpUpdatedAt() throws {
    var state = try TestData.threadState()
    let before = try #require(state.projection?.updatedAt)
    var (sequence, event) = try TestData.event(0)
    event.type = "thread.visited"
    let changed9 = state.apply(.event(sequence: sequence, event: event))
    #expect(changed9)
    #expect(state.projection?.updatedAt == before)

    event.type = "thread.pinned"
    let changed10 = state.apply(.event(sequence: sequence + 1, event: event))
    #expect(changed10)
    #expect(state.projection?.updatedAt == event.occurredAt)
  }

  @Test func unknownEventAdvancesTheSequence() throws {
    var state = try TestData.threadState()
    let (sequence, event) = try TestData.event(9)
    #expect(event.isUnknown)
    let changed11 = state.apply(.event(sequence: sequence, event: event))
    #expect(changed11)
    #expect(state.sequence == sequence)
    #expect(state.projection?.updatedAt == event.occurredAt)
  }

  @Test func boundedSnapshotDropsItemsOlderThanItsWindow() throws {
    guard case let .snapshot(snapshot) = try TestData.threadSnapshot() else { throw FixtureError("Expected a snapshot") }
    var bounded = snapshot
    bounded.hasMoreHistory = true
    bounded.latestLocalTurnOrdinal = 0
    var state = ThreadState()
    state.apply(.snapshot(bounded))
    #expect(state.partialTimeline)

    var (sequence, event) = try TestData.event(5)
    var old = try TestData.turnItem("ti_reason")
    old.threadId = "thr_1"
    old.runId = "run_1"
    old.ordinal = -5
    event.payload = .turnItem(old)
    let changed12 = state.apply(.event(sequence: sequence, event: event))
    #expect(!changed12)
    #expect(state.projection?.turnItems.count == 1)

    var fresh = old
    fresh.id = "ti_new"
    fresh.ordinal = 7
    event.payload = .turnItem(fresh)
    let changed13 = state.apply(.event(sequence: sequence + 1, event: event))
    #expect(changed13)
    #expect(state.projection?.visibleTurnItems.map(\.sourceItemId) == ["ti_1", "ti_new"])
  }

  @Test func completeBoundedSnapshotAppliesItemsBelowItsWatermark() throws {
    guard case let .snapshot(snapshot) = try TestData.threadSnapshot() else { throw FixtureError("Expected a snapshot") }
    // The server sends these keys on every bounded snapshot, also when nothing older remains.
    var complete = snapshot
    complete.hasMoreHistory = false
    complete.historyCursor = nil
    complete.latestLocalTurnOrdinal = 10
    var state = ThreadState()
    state.apply(.snapshot(complete))
    #expect(!state.partialTimeline)

    var (sequence, event) = try TestData.event(5)
    var late = try TestData.turnItem("ti_reason")
    late.id = "ti_late"
    late.threadId = "thr_1"
    late.runId = "run_1"
    late.ordinal = 3
    event.payload = .turnItem(late)
    let applied = state.apply(.event(sequence: sequence, event: event))
    #expect(applied)

    var older = late
    older.id = "ti_older"
    older.ordinal = -2
    event.payload = .turnItem(older)
    sequence += 1
    let appliedOlder = state.apply(.event(sequence: sequence, event: event))
    #expect(appliedOlder)
    #expect(state.projection?.visibleTurnItems.map(\.sourceItemId) == ["ti_older", "ti_1", "ti_late"])
  }

  @Test func snapshotIsCurrentButResumedEventsWaitForTheMarker() throws {
    var state = ThreadState()
    state.beginSubscription()
    state.apply(try TestData.threadSnapshot())
    #expect(state.isSynchronized)

    // A resume replays missed events; the projection is behind until the marker.
    state.beginSubscription()
    #expect(!state.isSynchronized)
    let (sequence, event) = try TestData.event(0)
    state.apply(.event(sequence: sequence, event: event))
    #expect(!state.isSynchronized)
    let marked = state.apply(.synchronized)
    #expect(marked)
    #expect(state.isSynchronized)
  }

  @Test func syncActorStartsOverForAnotherThread() async throws {
    let sync = ThreadSync()
    #expect(await sync.begin(threadId: "thr_1") == nil)
    let snapshot = try TestData.decode(JSONValue.self, FixtureJSON.threadSnapshot)
    let update = await sync.apply([snapshot, .object(["kind": .string("synchronized")])])
    #expect(update?.projection?.thread.id == "thr_1")
    #expect(update?.isSynchronized == true)
    #expect(await sync.begin(threadId: "thr_1") == 99)
    #expect(await sync.begin(threadId: "thr_2") == nil)
  }
}
