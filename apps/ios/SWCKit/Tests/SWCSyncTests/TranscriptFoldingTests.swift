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

  @Test func foldedStepsFoldsTheRunningTurnsStepsIntoOneLiveRow() {
    let running = [user("u1"), reply("note"), command("c1"), thought("t1"), command("c2", status: .running)]
    let rows = TranscriptFolding.rows(running, detail: .normal, isRunning: true)
    #expect(rows.map(\.id) == ["u1", "note", "fold-live:c1"])
    #expect(rows[2].kind == .fold(label: "Working", summary: "Ran 2 commands", failures: 0, expanded: false, running: true))
    let opened = TranscriptFolding.rows(running, detail: .normal, isRunning: true, expandedFolds: ["fold-live:c1"])
    #expect(opened.map(\.id) == ["u1", "note", "fold-live:c1", "c1", "t1", "c2"])
  }

  @Test func foldedStepsKeepsNotesAndFailuresBetweenStepRuns() {
    let running = [user("u1"), command("c1"), command("c2"), reply("note"), command("f1", status: .failed), command("c3"), command("c4", status: .running)]
    let rows = TranscriptFolding.rows(running, detail: .normal, isRunning: true)
    #expect(rows.map(\.id) == ["u1", "fold-live:c1", "note", "f1", "fold-live:c3"])
    #expect(rows[1].kind == .fold(label: "Worked", summary: "Ran 2 commands", failures: 0, expanded: false, running: false))
  }

  @Test func resultsOnlyShowsTheLatestReplyAndOneLiveRowWhileRunning() {
    let running = [user("u1"), thought("t1"), reply("note"), command("c1"), reply("latest"), command("c2", status: .running)]
    let rows = TranscriptFolding.rows(running, detail: .concise, isRunning: true)
    #expect(rows.map(\.id) == ["u1", "latest", "fold-live:u1"])
    #expect(rows[2].kind == .fold(label: "Working", summary: "Ran 2 commands", failures: 0, expanded: false, running: true))
    let opened = TranscriptFolding.rows(running, detail: .concise, isRunning: true, expandedFolds: ["fold-live:u1"])
    #expect(opened.map(\.id) == ["u1", "latest", "fold-live:u1", "c1", "c2"])
  }

  @Test func earlierTurnsFoldWhileTheLastOneRuns() {
    let rows = settled + [user("u2"), command("c3", status: .running)]
    let shown = TranscriptFolding.rows(rows, detail: .normal, isRunning: true)
    #expect(shown.map(\.id) == ["u1", "fold:u1", "final", "u2", "fold-live:c3"])
  }

  @Test func aTurnWaitingOnAnApprovalStaysOpen() {
    let waiting = [user("u1"), command("c1"), TranscriptRow(id: "a1", kind: .approval(requestId: "r", prompt: "npm publish", resolved: false))]
    #expect(TranscriptFolding.rows(waiting, detail: .normal, isRunning: false) == waiting)
    let twoSteps = [user("u1"), command("c1"), edit("e1"), waiting[2]]
    #expect(TranscriptFolding.rows(twoSteps, detail: .normal, isRunning: false).map(\.id) == ["u1", "fold-live:c1", "a1"])
    let concise = TranscriptFolding.rows(waiting, detail: .concise, isRunning: false)
    #expect(concise.map(\.id) == ["u1", "a1", "fold-live:u1"])
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

  @Test func aFoldOpenedWhileRunningIsClosedOnceTheTurnSettles() {
    let running = [user("u1"), command("c1"), reply("latest"), command("c2", status: .running)]
    let live = TranscriptFolding.foldId(for: running[0], inProgress: true)
    let open = TranscriptFolding.rows(running, detail: .concise, isRunning: true, expandedFolds: [live])
    #expect(open.map(\.id) == ["u1", "latest", live, "c1", "c2"])
    let settledRows = [user("u1"), command("c1"), reply("note"), command("c2"), reply("final")]
    let settled = TranscriptFolding.rows(settledRows, detail: .concise, isRunning: false, expandedFolds: [live])
    #expect(settled.map(\.id) == ["u1", "fold:u1", "final"])
    #expect(settled[1].kind == .fold(label: "Worked", summary: "Ran 2 commands", failures: 0, expanded: false, running: false))
  }

  @Test func stepsBeforeAnyMessageOpenedWhileRunningAreClosedOnceSettled() {
    let head = [command("c0"), command("c1", status: .running)]
    let live = TranscriptFolding.foldId(for: head[0], inProgress: true)
    let open = TranscriptFolding.rows(head, detail: .normal, isRunning: true, expandedFolds: [live])
    #expect(open.map(\.id) == [live, "c0", "c1"])
    let done = [command("c0"), command("c1"), reply("r0")]
    let settled = TranscriptFolding.rows(done, detail: .normal, isRunning: false, expandedFolds: [live])
    #expect(settled.map(\.id) == ["fold:c0", "r0"])
    #expect(settled[0].kind == .fold(label: "Worked", summary: "Ran 2 commands", failures: 0, expanded: false, running: false))
  }

  @Test func anAgentStillAtWorkStaysVisibleAtEveryLevel() {
    let agent = TranscriptRow(id: "a1", kind: .subagent(title: "Reviewer", child: nil, isRunning: true))
    let finished = TranscriptRow(id: "a0", kind: .subagent(title: "Explorer", child: nil, isRunning: false))
    let settledRows = [user("u1"), command("c1"), finished, agent, reply("final")]
    for detail in [TimelineDetail.concise, .normal] {
      let rows = TranscriptFolding.rows(settledRows, detail: detail, isRunning: false)
      #expect(rows.map(\.id) == ["u1", "fold:u1", "a1", "final"], "\(detail)")
      #expect(rows[1].kind == .fold(label: "Worked", summary: "Ran 1 command · 1 agent", failures: 0, expanded: false, running: false), "\(detail)")
    }
    let running = [user("u1"), command("c1"), agent, command("c2", status: .running)]
    let concise = TranscriptFolding.rows(running, detail: .concise, isRunning: true)
    #expect(concise.map(\.id) == ["u1", "a1", "fold-live:u1"])
    let normal = TranscriptFolding.rows(running, detail: .normal, isRunning: true)
    #expect(normal.map(\.id) == ["u1", "c1", "a1", "fold-live:c2"])
    // The agents button reveals a row the chat shows.
    for shown in [concise, normal] { #expect(shown.contains { $0.isRunningSubagent }) }
  }

  @MainActor @Test func aTranscriptCachedMidRunShowsAsSettled() {
    let session = ChatSession(id: .thread(ThreadRef(environmentId: "m4", threadId: "t")), title: "T", subtitle: "", machineLabel: "M4", machineOnline: false)
    session.rows = [user("u1"), command("c1"), reply("note"), command("c2", status: .running)]
    session.isRunning = true
    session.isStale = true
    #expect(!session.showsRunning)
    let rows = TranscriptFolding.rows(session.rows, detail: .normal, isRunning: session.showsRunning)
    #expect(rows.map(\.id) == ["u1", "fold:u1", "note"])
    #expect(!rows.contains { if case .fold(_, _, _, _, true) = $0.kind { true } else { false } })
    session.isStale = false
    #expect(session.showsRunning)
    #expect(TranscriptFolding.rows(session.rows, detail: .normal, isRunning: session.showsRunning).map(\.id) == ["u1", "c1", "note", "fold-live:c2"])
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
