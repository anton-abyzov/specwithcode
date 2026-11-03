import Foundation
import Testing
@testable import SWCSync

@Suite struct TranscriptFoldingTests {
  func user(_ id: String) -> TranscriptRow { TranscriptRow(id: id, kind: .user(text: "Do it")) }
  func reply(_ id: String, streaming: Bool = false) -> TranscriptRow { TranscriptRow(id: id, kind: .assistant(markdown: "Reply \(id)", streaming: streaming)) }
  func thought(_ id: String) -> TranscriptRow { TranscriptRow(id: id, kind: .reasoning(text: "Thinking", streaming: false, seconds: 3)) }
  func command(_ id: String, status: ToolStatus = .completed) -> TranscriptRow {
    TranscriptRow(id: id, kind: .tool(title: "Ran pkcheck", detail: "pkcheck: not authorized", symbol: "terminal", status: status))
  }
  func edit(_ id: String) -> TranscriptRow { TranscriptRow(id: id, kind: .tool(title: "Edited a.ts", detail: "+1 −1", symbol: "pencil", status: .completed)) }

  var settled: [TranscriptRow] {
    [user("u1"), thought("t1"), reply("note"), command("c1"), command("c2", status: .failed), edit("e1"), reply("final")]
  }

  @Test func everythingShowsEveryRow() {
    #expect(TranscriptFolding.rows(settled, detail: .verbose, isRunning: false) == settled)
  }

  @Test func foldedStepsFoldsAFinishedTurnBehindOneRow() {
    let rows = TranscriptFolding.rows(settled, detail: .normal, isRunning: false)
    #expect(rows.map(\.id) == ["u1", "fold:u1", "final"])
    #expect(rows[1].kind == .fold(label: "Worked", summary: "Ran 2 commands · Edited 1 file", failures: 1, expanded: false, running: false))
  }

  @Test func openingAFoldShowsTheStepsUnderIt() {
    let rows = TranscriptFolding.rows(settled, detail: .normal, isRunning: false, expandedFolds: ["fold:u1"])
    #expect(rows.map(\.id) == ["u1", "fold:u1", "t1", "note", "c1", "c2", "e1", "final"])
    let concise = TranscriptFolding.rows(settled, detail: .concise, isRunning: false, expandedFolds: ["fold:u1"])
    // Results only never shows thinking, opened or not.
    #expect(concise.map(\.id) == ["u1", "fold:u1", "note", "c1", "c2", "e1", "final"])
  }

  @Test func aJustSentMessageFoldsTheEarlierTurn() {
    let rows = [user("u1"), command("c1"), reply("final"), user("u2")]
    #expect(TranscriptFolding.rows(rows, detail: .normal, isRunning: true).map(\.id) == ["u1", "fold:u1", "final", "u2"])
    #expect(TranscriptFolding.rows(rows, detail: .concise, isRunning: true).map(\.id) == ["u1", "fold:u1", "final", "u2"])
  }

  @Test func foldedStepsKeepsTheRunningTurnOpen() {
    let running = [user("u1"), reply("note"), command("c1"), command("c2", status: .running)]
    #expect(TranscriptFolding.rows(running, detail: .normal, isRunning: true) == running)
  }

  @Test func resultsOnlyShowsTheLatestReplyAndOneLiveRowWhileRunning() {
    let running = [user("u1"), thought("t1"), reply("note"), command("c1"), reply("latest"), command("c2", status: .running)]
    let rows = TranscriptFolding.rows(running, detail: .concise, isRunning: true)
    #expect(rows.map(\.id) == ["u1", "latest", "fold:u1"])
    #expect(rows[2].kind == .fold(label: "Working", summary: "Ran 2 commands", failures: 0, expanded: false, running: true))
    let opened = TranscriptFolding.rows(running, detail: .concise, isRunning: true, expandedFolds: ["fold:u1"])
    #expect(opened.map(\.id) == ["u1", "latest", "fold:u1", "c1", "c2"])
  }

  @Test func earlierTurnsFoldWhileTheLastOneRuns() {
    let rows = settled + [user("u2"), command("c3", status: .running)]
    let shown = TranscriptFolding.rows(rows, detail: .normal, isRunning: true)
    #expect(shown.map(\.id) == ["u1", "fold:u1", "final", "u2", "c3"])
  }

  @Test func aTurnWaitingOnAnApprovalStaysOpen() {
    let waiting = [user("u1"), command("c1"), TranscriptRow(id: "a1", kind: .approval(requestId: "r", prompt: "npm publish", resolved: false))]
    #expect(TranscriptFolding.rows(waiting, detail: .normal, isRunning: false) == waiting)
    let concise = TranscriptFolding.rows(waiting, detail: .concise, isRunning: false)
    #expect(concise.map(\.id) == ["u1", "a1", "fold:u1"])
  }

  @Test func turnsWithoutStepsNeverFold() {
    let plain = [user("u1"), reply("final"), user("u2"), reply("final2")]
    #expect(TranscriptFolding.rows(plain, detail: .concise, isRunning: false) == plain)
    let onlyThought = [user("u1"), thought("t1"), reply("final")]
    #expect(TranscriptFolding.rows(onlyThought, detail: .concise, isRunning: false).map(\.id) == ["u1", "final"])
    #expect(TranscriptFolding.rows(onlyThought, detail: .normal, isRunning: false).map(\.id) == ["u1", "fold:u1", "final"])
  }

  @Test func stepsBeforeAnyMessageFoldToo() {
    let head = [command("c0"), reply("r0"), user("u1"), reply("final")]
    #expect(TranscriptFolding.rows(head, detail: .concise, isRunning: false).map(\.id) == ["fold:c0", "r0", "u1", "final"])
  }

  @Test func storedLevelReadsThisDevicesChoice() {
    let defaults = UserDefaults(suiteName: "TranscriptFoldingTests")!
    defaults.removeObject(forKey: TimelineDetail.defaultsKey)
    #expect(TimelineDetail.stored(in: defaults) == .normal)
    defaults.set("concise", forKey: TimelineDetail.defaultsKey)
    #expect(TimelineDetail.stored(in: defaults) == .concise)
    defaults.set("huge", forKey: TimelineDetail.defaultsKey)
    #expect(TimelineDetail.stored(in: defaults) == .normal)
  }
}
