import Foundation
import Testing
import SWCWire
import Weave
@testable import SWCSync

@Suite struct AccessRequestMappingTests {
  static func item(status: String = "pending", scope: String? = nil, threadId: String = "thr_1") throws -> TurnItem {
    try TestData.decode(TurnItem.self, """
      {"id":"ti_a","threadId":"\(threadId)","ordinal":1,"status":"waiting","updatedAt":"2026-10-18T06:00:05.123Z",
       "type":"access_request","accessTitle":"Use Notes","reason":"Read the meeting notes","accessStatus":"\(status)"\(scope.map { ",\"accessScope\":\"\($0)\"" } ?? ""),
       "subjects":[{"kind":"app","key":"app:notes","label":"Notes","detail":"See and control its windows"}]}
      """)
  }

  func access(_ item: TurnItem) throws -> AccessRequestRow {
    guard case let .access(row)? = TranscriptMapper.kind(for: item, environmentId: "env") else {
      throw FixtureError("Not an access row")
    }
    return row
  }

  @Test func accessRequestMapsTheFixtureItem() throws {
    let row = try access(try TestData.turnItem("ti_access"))
    #expect(row.threadId == "thr_1")
    #expect(row.itemId == "ti_access")
    #expect(row.title == "Use Activity Monitor and iPhone 17 Pro")
    #expect(row.reason == "To see what keeps the Mac awake and check the fix on the phone.")
    #expect(row.state == .pending)
    #expect(row.isPending)
    #expect(row.subjects.map(\.kind) == ["app", "device"])
    #expect(row.subjects.map(\.key) == ["app:activity monitor", "device:iphone-17-pro"])
    #expect(row.subjects[0].iconPNG?.prefix(4) == Data([0x89, 0x50, 0x4E, 0x47]))
    #expect(row.subjects[1].iconPNG == nil)
    #expect(row.subjects[1].hostLabel == "M1")
    #expect(row.subjects[1].platform == "ios")
  }

  @Test func accessRequestOutcomesMap() throws {
    #expect(try access(Self.item(status: "allowed", scope: "thread")).state == .allowedInThread)
    #expect(try access(Self.item(status: "allowed", scope: "machine")).state == .allowedOnMachine)
    // An Allow without a scope lasted the thread.
    #expect(try access(Self.item(status: "allowed")).state == .allowedInThread)
    #expect(try access(Self.item(status: "denied")).state == .denied)
    #expect(try access(Self.item(status: "cancelled")).state == .ended)
    #expect(try access(Self.item(status: "expired")).state == .ended)
  }

  @Test func accessRequestAnswerGoesToTheItemsThread() throws {
    // An inherited item from a forked thread is answered on the thread that holds it.
    #expect(try access(Self.item(threadId: "thr_parent")).threadId == "thr_parent")
  }

  @Test func inheritedAccessRequestWaitsInTheOriginalThread() throws {
    let pending = TranscriptRow.Kind.access(try access(Self.item()))
    guard case let .access(local) = TranscriptMapper.placed(pending, visibility: .local),
          case let .access(inherited) = TranscriptMapper.placed(pending, visibility: .inherited),
          case let .access(synthetic) = TranscriptMapper.placed(pending, visibility: .synthetic)
    else { throw FixtureError("Not an access row") }
    #expect(!local.isInherited && local.awaitsAnswerHere)
    #expect(inherited.isInherited && inherited.isPending && !inherited.awaitsAnswerHere)
    #expect(synthetic.isInherited)
    // The fork does not hold its turn open for a request it cannot answer.
    #expect(!TranscriptRow(id: "a", kind: .access(inherited)).awaitsAnswer)
    #expect(AccessRequestCard.waitingElsewhereText == "Waiting for an answer in the original thread")
  }

  @Test func accessCardCountsTheRequestsWaiting() {
    #expect(AccessRequestCard.queueText(waitingCount: 1) == nil)
    #expect(AccessRequestCard.queueText(waitingCount: 3) == "1 of 3")
  }

  @Test func accessRequestKeepsItsTurnOpenUntilAnswered() throws {
    let pending = TranscriptRow(id: "a", kind: .access(try access(Self.item())))
    let answered = TranscriptRow(id: "a", kind: .access(try access(Self.item(status: "denied"))))
    #expect(pending.awaitsAnswer)
    #expect(!answered.awaitsAnswer)

    let rows = [
      TranscriptRow(id: "u", kind: .user(text: "Check my notes")),
      TranscriptRow(id: "t", kind: .tool(title: "Ran ls", detail: nil, symbol: "terminal", status: .completed)),
      pending,
    ]
    let shown = TranscriptFolding.rows(rows, detail: .normal, isRunning: false)
    #expect(shown.map(\.id) == ["u", "t", "a"])
    let folded = TranscriptFolding.rows([rows[0], rows[1], answered], detail: .normal, isRunning: false)
    #expect(folded.map(\.id) == ["u", TranscriptFolding.foldId(for: rows[0]), "a"])
  }

  @Test func accessRequestCardPicksAGlyphPerKind() {
    #expect(AccessRequestCard.symbol(kind: "app", platform: nil, label: "Notes") == "app.dashed")
    #expect(AccessRequestCard.symbol(kind: "device", platform: "ios", label: "iPhone 17 Pro") == "iphone")
    #expect(AccessRequestCard.symbol(kind: "device", platform: "ios", label: "Anton's iPad Pro") == "ipad")
    #expect(AccessRequestCard.symbol(kind: "device", platform: "android", label: "Pixel 9") == "smartphone")
    #expect(AccessRequestCard.symbol(kind: "machine", platform: nil, label: "M1") == "desktopcomputer")
    #expect(AccessRequestCard.symbol(kind: "folder", platform: nil, label: "src") == "folder")
  }

  @Test @MainActor func accessRequestCardOutcomeText() {
    #expect(AccessRequestCard.Outcome.allowedInThread.text == "Allowed for this session")
    #expect(AccessRequestCard.Outcome.allowedOnMachine.text == "Allowed on this machine")
    #expect(AccessRequestCard.Outcome.denied.text == "Denied")
    #expect(AccessRequestCard.Outcome.ended.text == "Request ended")
    #expect(AccessRequestCard.Scope.thread.label == "This thread")
    #expect(AccessRequestCard.Scope.machine.label == "Always on this machine")
  }
}
