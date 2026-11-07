import Foundation
import Testing
@testable import SWCSync

/// The shared transcript detail rule (docs/transcript-detail.md). Web and
/// desktop run the same cases in apps/web/src/components/chat/transcriptDetailCases.test.ts.
@Suite struct TranscriptDetailCasesTests {
  struct Row: Decodable { let id: String; let kind: String; let running: Bool? }
  struct Case: Decodable {
    let name: String
    let running: Bool
    let platforms: [String]?
    let rows: [Row]
    let normal: [String]
    let concise: [String]
  }
  struct File: Decodable { let cases: [Case] }

  static let file: File = {
    let url = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent() // SWCSyncTests
      .deletingLastPathComponent() // Tests
      .deletingLastPathComponent() // SWCKit
      .deletingLastPathComponent() // ios
      .deletingLastPathComponent() // apps
      .deletingLastPathComponent() // repository
      .appendingPathComponent("packages/shared/src/transcriptDetail.cases.json")
    // swiftlint:disable:next force_try
    return try! JSONDecoder().decode(File.self, from: Data(contentsOf: url))
  }()

  static func transcript(_ rows: [Row]) -> [TranscriptRow] {
    rows.map { row in
      let status: ToolStatus = row.running == true ? .running : .completed
      switch row.kind {
      case "user": return TranscriptRow(id: row.id, kind: .user(text: "Do it"))
      case "note", "reply": return TranscriptRow(id: row.id, kind: .assistant(markdown: "\(row.kind) \(row.id)", streaming: false))
      case "thinking": return TranscriptRow(id: row.id, kind: .reasoning(text: "Thinking", streaming: false))
      case "command": return TranscriptRow(id: row.id, kind: .tool(title: "Ran ls", detail: nil, symbol: "terminal", status: status))
      case "tool": return TranscriptRow(id: row.id, kind: .tool(title: "Chrome snapshot", detail: nil, symbol: "wrench.and.screwdriver", status: status))
      case "failed": return TranscriptRow(id: row.id, kind: .tool(title: "Ran ls", detail: "exit 1", symbol: "terminal", status: .failed))
      case "approval": return TranscriptRow(id: row.id, kind: .approval(requestId: row.id, prompt: "npm publish", resolved: false))
      default: fatalError("Unknown row kind \(row.kind)")
      }
    }
  }

  static func tokens(_ rows: [TranscriptRow]) -> [String] {
    rows.map { row in
      if case let .fold(_, _, _, expanded, running) = row.kind {
        return (running ? "live" : "fold") + (expanded ? "-open" : "")
      }
      return row.id
    }
  }

  @Test func everyCaseHolds() {
    #expect(!Self.file.cases.isEmpty)
    for testCase in Self.file.cases where testCase.platforms?.contains("ios") ?? true {
      let rows = Self.transcript(testCase.rows)
      for (detail, expected) in [(TimelineDetail.normal, testCase.normal), (.concise, testCase.concise)] {
        let shown = TranscriptFolding.rows(rows, detail: detail, isRunning: testCase.running)
        #expect(Self.tokens(shown) == expected, "\(detail.rawValue): \(testCase.name)")
      }
      #expect(TranscriptFolding.rows(rows, detail: .verbose, isRunning: testCase.running) == rows, "verbose: \(testCase.name)")
    }
  }

  @Test func unnamedToolsReadFromTheirOwnName() {
    #expect(ToolPresentation(name: "mcp__studio-code__chrome_screenshot", output: nil).title == "Chrome screenshot")
    #expect(ToolPresentation(name: "mcp__studio-code__studio_thread_read", output: nil).title == "Read conversation")
    #expect(ToolPresentation(name: "", output: nil).title == "Use tool")
  }
}
