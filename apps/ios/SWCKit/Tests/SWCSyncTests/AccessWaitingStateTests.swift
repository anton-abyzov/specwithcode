import Foundation
import Testing
import SWCWire
@testable import SWCSync

/// A thread whose pending request is an access card waits for the person, with its own subtitle.
@Suite struct AccessWaitingStateTests {
  static let accessId = "turn-item:access-request:thr_1:app"

  @Test func accessWaitWithoutSummaryUsesTheGenericSubtitle() throws {
    var thread = try TestData.thread()
    thread.pendingRuntimeRequest = PendingRuntimeRequestSummary(id: Self.accessId, kind: .permission, createdAt: Date())
    #expect(ShellSummaries.activity(thread) == .needsYou)
    #expect(ShellSummaries.preview(thread) == "Asking to use apps on your computer")
    let summary = ShellSummaries.threadSummary(thread, environmentId: "env", projectTitle: nil, machineLabel: "M4", machineOnline: true)
    #expect(summary.asksForAccess)
    #expect(summary.activity == .needsYou)
  }

  @Test func accessWaitWithSummaryNamesTheKind() throws {
    var thread = try TestData.thread()
    thread.pendingRuntimeRequest = PendingRuntimeRequestSummary(
      id: Self.accessId, kind: .permission, createdAt: Date(),
      access: PendingAccessSummary(accessTitle: "Use iPhone 17 Pro and Pixel 9", reason: "", subjects: [
        .init(kind: "device", label: "iPhone 17 Pro", hostLabel: "M1"),
        .init(kind: "device", label: "Pixel 9"),
      ])
    )
    #expect(ShellSummaries.preview(thread) == "Asking to control devices")
    #expect(ShellSummaries.threadSummary(thread, environmentId: "env", projectTitle: nil, machineLabel: "M4", machineOnline: true).asksForAccess)
  }

  @Test func anApprovalIsNotAnAccessWait() throws {
    var thread = try TestData.thread()
    thread.pendingRuntimeRequest = PendingRuntimeRequestSummary(id: "req_1", kind: .permission, createdAt: Date())
    #expect(ShellSummaries.preview(thread) == "Approval requested")
    #expect(!ShellSummaries.threadSummary(thread, environmentId: "env", projectTitle: nil, machineLabel: "M4", machineOnline: true).asksForAccess)
  }

  @Test func agentNameDropsTheToolSuffix() {
    #expect(ThreadIdentity(provider: "Claude Code", model: "Opus 5.5").agentName == "Claude")
    #expect(ThreadIdentity(provider: "Codex", model: "GPT").agentName == "Codex")
    #expect(ThreadIdentity(provider: "Gemini CLI", model: "x").agentName == "Gemini")
    #expect(ThreadIdentity(provider: "GitHub Copilot", model: "x").agentName == "GitHub Copilot")
    #expect(ThreadIdentity.unknown.agentName == nil)
  }

  @Test func accessRowCopyUsesThePort() {
    let row = AccessRequestRow(threadId: "thr_1", itemId: "ti", title: "Use SpecWithCode", reason: "", subjects: [
      .init(kind: "app", key: "app:notes", label: "Notes", detail: ""),
    ], state: .pending)
    #expect(row.headline(agent: "Claude") == "Claude wants to use Notes")
    #expect(row.headline(agent: nil) == "The agent wants to use Notes")
    #expect(row.note == "The agent can see your screen and click and type in these apps while it works.")
    #expect(row.tag(for: row.subjects[0]) == "All")
  }
}
