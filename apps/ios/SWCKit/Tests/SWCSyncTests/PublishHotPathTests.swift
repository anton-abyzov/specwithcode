import Foundation
import Testing
import SWCTransport
import SWCWire
@testable import SWCSync

/// A publish runs on the main actor for every machine's threads, so what it
/// costs per thread is what keeps the phone responsive.
@Suite struct PublishHotPathTests {
  static let blockers = [
    "Done.\n\nWaiting for CI on the branch.",
    "Blocked on review of PR 12",
    "Pick a logo.",
    "```\nwaiting for CI\n```\n\nNow waiting for subagents.",
    "Waiting on PR #12 to land.\n\n",
    "",
  ]

  /// 2,000 threads over two machines in every state a row reads: settled
  /// with a blocker, running, waiting on a label, with background work.
  static func machines(count: Int = 2_000) throws -> [ShellSummaries.Machine] {
    var threads: [[ThreadShell]] = [[], []]
    for index in 0..<count {
      var thread = try TestData.thread(id: "thr_\(index)")
      thread.reportedBlocker = blockers[index % blockers.count]
      switch index % 4 {
      case 0: thread.status = .completed
      case 1: thread.status = .running
      case 2:
        thread.status = .waiting
        thread.activeWork = ActiveWork(label: "Waiting for the build", startedAt: Date(timeIntervalSince1970: 0))
      default:
        thread.status = .completed
        thread.pendingBackgroundTasks = [PendingBackgroundTask(taskId: "task_\(index)", kind: .command)]
      }
      threads[index % 2].append(thread)
    }
    return try threads.enumerated().map { index, threads in
      ShellSummaries.Machine(environmentId: "env-\(index)", label: "M\(index)", online: true, snapshot: try TestData.shell(threads: threads))
    }
  }

  @Test func eachThreadsReportIsReadAtMostTwicePerBuild() async throws {
    let machines = try Self.machines()
    let counter = ThreadAttention.EvaluationCounter()
    let output = ThreadAttention.$evaluations.withValue(counter) { ShellSummaries.build(machines) }
    #expect(output.threadsByProject.values.reduce(0) { $0 + $1.count } >= 2_000)
    #expect(counter.count > 0)
    #expect(counter.count <= 2 * 2_000)
  }

  @Test func attentionMatchesTheSeparateRules() throws {
    for machine in try Self.machines(count: 48) {
      for thread in machine.snapshot?.threads ?? [] {
        let attention = ThreadAttention.attention(thread)
        #expect(attention.needsReply == ThreadAttention.needsReply(thread))
        #expect(attention.dependencyWait == ThreadAttention.dependencyWait(thread))
        #expect(ShellSummaries.preview(thread, attention: attention) == ShellSummaries.preview(thread))
      }
    }
  }

  /// The rules as they read before the patterns were compiled once, so every
  /// stored pattern is checked against its literal.
  static func referenceWaitReason(_ text: String) -> String? {
    let unfenced = text.replacing(/```[\s\S]*?```/, with: "")
    let prose = (unfenced.split(separator: /\n\s*\n/, omittingEmptySubsequences: false).last.map(String.init) ?? "")
      .trimmingCharacters(in: .whitespacesAndNewlines)
    if prose.hasPrefix(">") || prose.contains("?") { return nil }
    if prose.firstMatch(of: /(?i)\b(?:you|your|anton|approve|approval|permission|decision|sign[ -]?in|license|credential)\b/) != nil { return nil }
    let plain = prose.replacing(/[*_`]/, with: "")
    guard let wait = plain.firstMatch(of: /(?i)(?:^|[.!]\s+)(?:(?:blockers?|blocked)\s*:\s*)?(?:now\s+)?(?:waiting (?:on|for)|wait for|blocked (?:on|by))\s+(.+)/) else { return nil }
    let dependency = String(wait.1)
    if dependency.prefixMatch(of: /(?i)(?:the\s+)?(?:CI|checks?|builds?|tests?)(?:\b|$)/) != nil { return "Waiting for CI" }
    if dependency.prefixMatch(of: /(?i)(?:a\s+|the\s+|fresh\s+)*(?:review|reviewer)(?:\b|$)/) != nil { return "Waiting for review" }
    if dependency.prefixMatch(of: /(?i)(?:(?:the|a)\s+)?(?:PRs?|pull requests?)(?:\b|$)|(?:the\s+)?merge\b|#[0-9]+.*\bmerg/) != nil { return "Waiting for PR merge" }
    if dependency.prefixMatch(of: /(?i)(?:the\s+|my\s+)?(?:subagents?|agents?|workers?)(?:\b|$)/) != nil { return "Waiting for subagents" }
    return nil
  }

  @Test(arguments: [
    // Fences: a wait inside a code block is not the report's.
    "```\nWaiting for CI\n```", "Done.\n```\nlog\n```\nWaiting for CI.", "```a``` Waiting for review ```b```",
    // Paragraphs: only the last one counts, blank lines with spaces included.
    "Waiting for CI.\n \t\nPick a logo.", "Pick a logo.\n\nWaiting for CI.", "Waiting for CI.\n\n", "\n\n",
    // Asks of the person.
    "Waiting for your approval.", "Waiting for Anton.", "Blocked by a missing license.", "Waiting for sign-in.", "Waiting for signin.", "Waiting for credentials.",
    "> Waiting for CI.", "Waiting for CI?",
    // Emphasis is ignored.
    "**Waiting for** _CI_.", "`Waiting on` the build.",
    // Lead-ins.
    "Blockers: waiting on CI.", "Blocked: now waiting for the tests.", "Merged. Blocked on the reviewer.", "Shipped! Wait for the build.", "Ready, waiting for CI.",
    "Blocked by review.", "BLOCKED ON CHECKS", "waiting for",
    // Dependencies.
    "Waiting for checks to pass.", "Waiting for builds.", "Waiting for the test run.", "Waiting for testing.", "Waiting for CIs.",
    "Waiting for a fresh review.", "Waiting for the reviewer.", "Waiting for reviews.", "Waiting for reviewing.",
    "Waiting for PRs.", "Waiting for the pull request.", "Waiting for a pull requests sweep.", "Waiting for the merge.", "Waiting for merges.", "Waiting for #123 to be merged.", "Waiting for #12.",
    "Waiting for my workers.", "Waiting for the agent.", "Waiting for subagents.", "Waiting for agentic things.",
    "Waiting for the deploy.", "", "Pick a logo.",
  ])
  func storedPatternsMatchTheirLiterals(_ text: String) {
    #expect(ThreadAttention.reportWaitReason(text) == Self.referenceWaitReason(text))
  }

  @Test func reusesAMachinesRowsUntilItsInputsChange() throws {
    var machines = try Self.machines(count: 20)
    let cache = ShellSummaries.Cache()
    let first = ShellSummaries.build(machines, cache: cache)
    #expect(cache.summarized == ["env-0": 1, "env-1": 1])
    #expect(ShellSummaries.build(machines, cache: cache) == first)
    #expect(cache.summarized == ["env-0": 1, "env-1": 1])

    machines[0].snapshot?.threads[0].title = "Renamed"
    let renamed = ShellSummaries.build(machines, cache: cache)
    #expect(cache.summarized == ["env-0": 2, "env-1": 1])
    #expect(renamed.recentThreads.contains { $0.title == "Renamed" })
    #expect(renamed == ShellSummaries.build(machines))

    // Another machine's name is in this machine's rows (where a thread runs).
    machines[0].label = "Studio"
    _ = ShellSummaries.build(machines, cache: cache)
    #expect(cache.summarized == ["env-0": 3, "env-1": 2])
  }

  @Test func anOnlinePeersHeartbeatLeavesTheOthersRowsAlone() throws {
    var machines = try Self.machines(count: 20)
    machines[0].lastSeenAt = Date(timeIntervalSince1970: 100)
    let cache = ShellSummaries.Cache()
    _ = ShellSummaries.build(machines, cache: cache)
    machines[0].lastSeenAt = Date(timeIntervalSince1970: 130)
    let output = ShellSummaries.build(machines, cache: cache)
    #expect(cache.summarized == ["env-0": 1, "env-1": 1])
    #expect(output == ShellSummaries.build(machines))
  }

  @Test func anOfflinePeersLastSeenRebuildsTheRowsThatShowIt() throws {
    var machines = try Self.machines(count: 20)
    machines[0].online = false
    machines[0].lastSeenAt = Date(timeIntervalSince1970: 100)
    let cache = ShellSummaries.Cache()
    _ = ShellSummaries.build(machines, cache: cache)
    machines[0].lastSeenAt = Date(timeIntervalSince1970: 130)
    let output = ShellSummaries.build(machines, cache: cache)
    #expect(cache.summarized == ["env-0": 2, "env-1": 2])
    #expect(output == ShellSummaries.build(machines))
  }

  @Test(.enabled(if: ProcessInfo.processInfo.environment["SWC_PERF"] != nil)) func timesABuildOverTwoThousandThreads() throws {
    let machines = try Self.machines()
    _ = ShellSummaries.build(machines)
    let clock = ContinuousClock()
    let runs = 5
    let elapsed = clock.measure { for _ in 0..<runs { _ = ShellSummaries.build(machines) } }
    let cache = ShellSummaries.Cache()
    _ = ShellSummaries.build(machines, cache: cache)
    let reused = clock.measure { for _ in 0..<runs { _ = ShellSummaries.build(machines, cache: cache) } }
    print("PERF build over 2000 threads: \(elapsed / runs) fresh, \(reused / runs) reused")
  }
}

@MainActor @Suite struct PublishReuseTests {
  let base = LiveEngineTests()

  @Test func aChangeOnOneMachineLeavesTheOthersRowsAlone() async throws {
    let h = try await base.harness()
    defer { h.engine.setActive(false) }
    #expect(await base.loaded(h))
    let source = try #require(h.engine.machines["env-1"])
    let other = MachineEntry(record: MachineRecord(environmentId: "env-2", label: "Minis", routes: []), connection: source.connection)
    other.snapshot = try TestData.shell(threads: [TestData.thread(id: "thr_other", projectId: "proj_other", title: "On Minis")], projects: [TestData.project(id: "proj_other", title: "Other", root: "/Users/x/other")])
    h.engine.machines["env-2"] = other
    h.engine.machineOrder.append("env-2")
    h.engine.fleetHome = []
    h.engine.publishNow()
    #expect(h.model.recentThreads.contains { $0.title == "On Minis" })
    let before = h.engine.summaryCache.summarized

    h.engine.publishNow()
    #expect(h.engine.summaryCache.summarized == before)

    var snapshot = try #require(source.snapshot)
    snapshot.threads[0].title = "Renamed on M4"
    source.snapshot = snapshot
    h.engine.publishNow()
    #expect(h.model.recentThreads.contains { $0.title == "Renamed on M4" })
    #expect(h.engine.summaryCache.summarized["env-1"] == (before["env-1"] ?? 0) + 1)
    #expect(h.engine.summaryCache.summarized["env-2"] == before["env-2"])
  }
}
