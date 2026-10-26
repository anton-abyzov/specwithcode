import Foundation
import Testing
import SWCWire
@testable import SWCSync

@Suite struct TranscriptMapperTests {
  func kind(_ id: String, requests: [String: RuntimeRequest] = [:]) throws -> TranscriptRow.Kind? {
    TranscriptMapper.kind(for: try TestData.turnItem(id), requests: requests, environmentId: "env")
  }

  @Test func queuedMessagesFollowTheTimelineInQueueOrder() throws {
    struct Snapshot: Decodable { let projection: ThreadProjection }
    var projection = try TestData.decode(Snapshot.self, FixtureJSON.threadSnapshot).projection
    let base = projection.runs[0]
    let message = projection.messages[0]
    func queue(_ n: Int, position: Int, held: Bool = false, text: String) {
      var run = base
      run.id = "run_\(n)"
      run.ordinal = n
      run.status = .queued
      run.userMessageId = "msg_\(n)"
      run.queuePosition = position
      run.queueHeld = held
      run.startedAt = nil
      projection.runs.append(run)
      var queued = message
      queued.id = "msg_\(n)"
      queued.runId = run.id
      queued.text = text
      projection.messages.append(queued)
    }
    queue(2, position: 2, text: "Then deploy")
    queue(3, position: 1, held: true, text: "Run the tests first")

    let rows = TranscriptMapper.rows(for: projection, environmentId: "env")
    #expect(rows.count == 3)
    #expect(rows[1] == TranscriptRow(id: "queued:run_3", kind: .user(text: "Run the tests first", state: .held)))
    #expect(rows[2] == TranscriptRow(id: "queued:run_2", kind: .user(text: "Then deploy", state: .queued)))
    // A sent message is matched while it waits, before it has a turn item.
    #expect(Set(TranscriptMapper.receivedUserMessages(projection).map(\.messageId)) == ["msg_1", "msg_2", "msg_3"])
    #expect(TranscriptMapper.queuedCount(projection) == 2)
  }

  @Test func messagesAndReasoning() throws {
    #expect(try kind("ti_user") == .user(text: "Fix the login bug"))
    #expect(try kind("ti_asst") == .assistant(markdown: "Looking at **auth.ts** now.", streaming: true))
    #expect(try kind("ti_reason") == .reasoning(text: "The token check runs before refresh.", streaming: false, seconds: 2))
  }

  @Test func settledThoughtCarriesItsDuration() throws {
    var item = try TestData.turnItem("ti_reason")
    let start = Date(timeIntervalSince1970: 1_800_000_000)
    item.startedAt = start
    item.completedAt = start.addingTimeInterval(12.4)
    #expect(TranscriptMapper.kind(for: item, environmentId: "env") == .reasoning(text: "The token check runs before refresh.", streaming: false, seconds: 12))
    // A replayed item settles in the instant it starts: no duration to show.
    item.completedAt = start.addingTimeInterval(0.2)
    #expect(TranscriptMapper.kind(for: item, environmentId: "env") == .reasoning(text: "The token check runs before refresh.", streaming: false))
  }

  @Test func plans() throws {
    #expect(try kind("ti_plan") == .proposedPlan(markdown: "1. Read\n2. Fix"))
    #expect(try kind("ti_todo") == .plan(steps: [
      TodoStep(id: "s1", text: "Read code", status: .completed),
      TodoStep(id: "s2", text: "Write fix", status: .running),
      TodoStep(id: "s3", text: "Test", status: .pending),
    ]))
  }

  @Test func tools() throws {
    #expect(try kind("ti_cmd") == .tool(title: "Ran npm test", detail: nil, symbol: "terminal", status: .failed))
    #expect(try kind("ti_file") == .tool(title: "Edited auth.ts", detail: "+12 −3", symbol: "pencil", status: .completed))
    #expect(try kind("ti_fsearch") == .tool(title: "Searched for refreshToken", detail: "1 result", symbol: "magnifyingglass", status: .completed))
    #expect(try kind("ti_wsearch") == .tool(title: "Searched the web for oauth refresh race", detail: "1 result", symbol: "globe", status: .completed))
    #expect(try kind("ti_tool") == .tool(title: "Start conversation", detail: "Tool: studio_thread_launch", symbol: "wrench.and.screwdriver", status: .completed))
  }

  @Test func technicalToolNamesAndFailures() throws {
    var item = try TestData.turnItem("ti_tool")
    item.content = .dynamicTool(.init(toolName: "studio-code.studio_thread_read"))
    #expect(TranscriptMapper.kind(for: item, environmentId: "env") == .tool(title: "Read conversation", detail: "Tool: studio-code.studio_thread_read", symbol: "wrench.and.screwdriver", status: .completed))
    item.content = .dynamicTool(.init(toolName: "studio-code.studio_thread_send", output: .object(["isError": .bool(true), "content": .array([.object(["text": .string("Permission denied")])])])))
    #expect(TranscriptMapper.kind(for: item, environmentId: "env") == .tool(title: "Send to conversation", detail: "Permission denied\nTool: studio-code.studio_thread_send", symbol: "wrench.and.screwdriver", status: .failed))
    #expect(ToolPresentation(name: "unknown.protocol", output: nil).detail == "Tool: unknown.protocol")
  }

  @Test func commandOutputAndExitCode() throws {
    var item = try TestData.turnItem("ti_cmd")
    guard case var .commandExecution(command) = item.content else { throw FixtureError("Expected a command") }
    command.input = "npm test\n--watch"
    command.output = "\nok\n"
    command.outputIndicatesFailure = nil
    command.exitCode = 0
    item.content = .commandExecution(command)
    item.status = .completed
    #expect(TranscriptMapper.kind(for: item, environmentId: "env") == .tool(title: "Ran npm test", detail: "ok", symbol: "terminal", status: .completed))

    command.exitCode = 2
    item.content = .commandExecution(command)
    #expect(TranscriptMapper.kind(for: item, environmentId: "env") == .tool(title: "Ran npm test", detail: "ok", symbol: "terminal", status: .failed))

    item.status = .running
    #expect(TranscriptMapper.kind(for: item, environmentId: "env") == .tool(title: "Ran npm test", detail: "ok", symbol: "terminal", status: .running))
  }

  @Test func severalFileChanges() throws {
    var item = try TestData.turnItem("ti_file")
    guard case var .fileChange(change) = item.content else { throw FixtureError("Expected a file change") }
    change.changes = [FileChangeDetail(operation: "update", path: "a.ts"), FileChangeDetail(operation: "add", path: "b.ts")]
    change.additions = nil
    change.deletions = nil
    item.content = .fileChange(change)
    #expect(TranscriptMapper.kind(for: item, environmentId: "env") == .tool(title: "Edited 2 files", detail: nil, symbol: "pencil", status: .completed))
  }

  @Test func requestsFollowTheItemWithoutRuntimeRequests() throws {
    #expect(try kind("ti_approval") == .approval(requestId: "req_1", prompt: "Run npm install?", resolved: false))
    #expect(try kind("ti_input") == .question(requestId: "req_2", prompt: "Which database?", resolved: false))
  }

  @Test func requestsResolveFromRuntimeRequests() throws {
    guard case var .runtimeRequest(approval) = try TestData.event(7).event.payload,
          case let .runtimeRequest(question) = try TestData.event(8).event.payload else {
      throw FixtureError("Expected runtime requests")
    }
    var requests = ["req_1": approval, "req_2": question]
    #expect(try kind("ti_approval", requests: requests) == .approval(requestId: "req_1", prompt: "Run npm install?", resolved: false))
    #expect(try kind("ti_input", requests: requests) == .question(requestId: "req_2", prompt: "Which database?", resolved: true))

    approval.status = .resolved
    requests["req_1"] = approval
    #expect(try kind("ti_approval", requests: requests) == .approval(requestId: "req_1", prompt: "Run npm install?", resolved: true))
  }

  @Test func approvalWithoutPromptGetsOne() throws {
    var item = try TestData.turnItem("ti_approval")
    guard case var .approvalRequest(request) = item.content else { throw FixtureError("Expected an approval") }
    request.prompt = nil
    item.content = .approvalRequest(request)
    #expect(TranscriptMapper.kind(for: item, environmentId: "env") == .approval(requestId: "req_1", prompt: "Allow this command?", resolved: false))
  }

  @Test func subagentErrorAndNotices() throws {
    #expect(try kind("ti_sub") == .subagent(title: "Audit the API", child: ThreadRef(environmentId: "env", threadId: "thr_child")))
    #expect(try kind("ti_err") == .error(message: "Usage limit reached"))
    #expect(try kind("ti_notice") == .notice(text: "Context compacted"))
    #expect(try kind("ti_note") == .notice(text: "Audit finished"))
  }

  @Test func unknownItemsAreSkipped() throws {
    #expect(try TestData.turnItem("ti_ckpt").isUnknown)
    #expect(try kind("ti_ckpt") == nil)
  }

  @Test func everyFixtureItemMaps() throws {
    let items = try TestData.turnItems()
    #expect(items.count == 18)
    let mapped = items.compactMap { TranscriptMapper.kind(for: $0, environmentId: "env") }
    #expect(mapped.count == items.filter { !$0.isUnknown }.count)
  }

  @Test func rowsFollowVisibleOrder() throws {
    var state = try TestData.threadState()
    for item in try TestData.threadEvents() { state.apply(item) }
    let projection = try #require(state.projection)
    let rows = TranscriptMapper.rows(for: projection, environmentId: "env")
    #expect(rows.map(\.id) == ["thr_1/ti_1", "thr_1/ti_asst"])
    #expect(rows.first?.kind == .tool(title: "Ran ls", detail: "a\nb", symbol: "terminal", status: .completed))
    #expect(TranscriptMapper.isRunning(projection))
    #expect(TranscriptMapper.queuedCount(projection) == 0)
  }

  @Test func composerStateFromTheProjection() throws {
    var state = try TestData.threadState()
    let snapshot = try #require(state.projection)
    #expect(TranscriptMapper.planProgress(snapshot) == PlanProgress(completed: 0, total: 1))
    #expect(TranscriptMapper.queuedCount(snapshot) == 0)

    let (sequence, event) = try TestData.event(2)
    state.apply(.event(sequence: sequence, event: event))
    #expect(TranscriptMapper.queuedCount(try #require(state.projection)) == 1)
  }
}
