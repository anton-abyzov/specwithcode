import Foundation
import SWCWire

/// Maps a thread projection to the rows and composer state a `ChatSession` shows.
public enum TranscriptMapper {
  /// Rows in timeline order, then messages waiting in the queue. Item types
  /// this build does not know are skipped.
  public static func rows(for projection: ThreadProjection, environmentId: String) -> [TranscriptRow] {
    let requests = Dictionary(projection.runtimeRequests.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
    let timeline = projection.visibleTurnItems
      .sorted { $0.position < $1.position }
      .compactMap { row in
        kind(for: row.item, requests: requests, environmentId: environmentId).map { TranscriptRow(id: row.id, kind: $0) }
      }
    return timeline + queuedRows(projection)
  }

  /// Messages you queued behind the active run. They have no turn item until
  /// their run starts, so they come from the runs and messages, in queue order,
  /// as the web client lists them. Automatic notification runs are left out.
  static func queuedRows(_ projection: ThreadProjection) -> [TranscriptRow] {
    let inTimeline = Set(userMessages(projection).map(\.messageId))
    let messages = Dictionary(projection.messages.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
    return projection.runs
      .filter { $0.status == .queued && !inTimeline.contains($0.userMessageId) }
      .sorted { ($0.queuePosition ?? $0.ordinal, $0.ordinal) < ($1.queuePosition ?? $1.ordinal, $1.ordinal) }
      .compactMap { run in
        let message = messages[run.userMessageId]
        if message?.notification != nil { return nil }
        let text = message?.text ?? "Queued message"
        return TranscriptRow(id: "queued:\(run.id)", kind: .user(text: text, state: run.queueHeld == true ? .held : .queued))
      }
  }

  public static func kind(for item: TurnItem, requests: [String: RuntimeRequest] = [:], environmentId: String) -> TranscriptRow.Kind? {
    switch item.content {
    case let .userMessage(message):
      return .user(text: message.text)

    case let .assistantMessage(message):
      return .assistant(markdown: message.text, streaming: message.streaming)

    case let .reasoning(reasoning):
      if reasoning.text.isEmpty, !reasoning.streaming { return nil }
      return .reasoning(text: reasoning.text, streaming: reasoning.streaming)

    case let .commandExecution(command):
      let failed = command.outputIndicatesFailure == true || (command.exitCode.map { $0 != 0 } ?? false)
      return .tool(title: "Ran \(firstLine(command.input))", detail: detail(command.output), symbol: "terminal", status: toolStatus(item.status, failed: failed))

    case let .fileChange(change):
      let count = change.changes?.count ?? 0
      let title = count > 1 ? "Edited \(count) files" : "Edited \(fileName(change.fileName))"
      return .tool(title: title, detail: lineCounts(additions: change.additions, deletions: change.deletions), symbol: "pencil", status: toolStatus(item.status))

    case let .fileSearch(search):
      let title = search.pattern.map { "Searched for \(firstLine($0))" } ?? "Searched files"
      let detail = search.results.map { $0.count == 1 ? "1 result" : "\($0.count) results" }
      return .tool(title: title, detail: detail, symbol: "magnifyingglass", status: toolStatus(item.status))

    case let .webSearch(search):
      let title = search.patterns?.first.map { "Searched the web for \(firstLine($0))" } ?? "Searched the web"
      let detail = search.results.map { $0.count == 1 ? "1 result" : "\($0.count) results" }
      return .tool(title: title, detail: detail, symbol: "globe", status: toolStatus(item.status))

    case let .dynamicTool(tool):
      let name = tool.toolName ?? item.title ?? item.toolSource?.name ?? "Tool"
      return .tool(title: name, detail: nil, symbol: "wrench.and.screwdriver", status: toolStatus(item.status))

    case let .todoList(list):
      return .plan(steps: list.steps.map(todoStep))

    case let .proposedPlan(plan):
      return .proposedPlan(markdown: plan.markdown)

    case let .approvalRequest(request):
      let resolved = requests[request.requestId].map { !$0.isPending } ?? !item.isInFlight
      return .approval(requestId: request.requestId, prompt: request.prompt ?? approvalPrompt(request.requestKind, appName: request.appName), resolved: resolved)

    case let .userInputRequest(request):
      let resolved = requests[request.requestId].map { !$0.isPending } ?? (request.isAnswered || !item.isInFlight)
      let prompt = request.questions.map(\.question).filter { !$0.isEmpty }.joined(separator: "\n")
      return .question(requestId: request.requestId, prompt: prompt.isEmpty ? "A question is waiting for your answer." : prompt, resolved: resolved)

    case let .subagent(subagent):
      let title = item.title ?? firstLine(subagent.prompt)
      return .subagent(title: title.isEmpty ? "Subagent" : title, child: subagent.childThreadId.map { ThreadRef(environmentId: environmentId, threadId: $0) })

    case let .error(report):
      return .error(message: report.failure.message.isEmpty ? "Something went wrong." : report.failure.message)

    case let .systemNotice(notice):
      return .notice(text: notice.message)

    case let .notification(notification):
      return .notice(text: notification.summary)

    case .unknown:
      return nil
    }
  }

  /// A run holds the thread now.
  public static func isRunning(_ projection: ThreadProjection) -> Bool {
    projection.activeRun != nil
  }

  public static func queuedCount(_ projection: ThreadProjection) -> Int {
    projection.runs.filter { $0.status == .queued }.count
  }

  /// Progress of the current todo list: the newest one not superseded.
  public static func planProgress(_ projection: ThreadProjection) -> PlanProgress? {
    for plan in projection.plans.reversed() where plan.status != .superseded {
      if case let .todoList(steps, _) = plan.content, !steps.isEmpty {
        return PlanProgress(completed: steps.filter { $0.status == .completed }.count, total: steps.count)
      }
    }
    return nil
  }

  /// User message item ids, for matching optimistic rows to their echo.
  static func userMessages(_ projection: ThreadProjection) -> [(id: String, messageId: String, text: String)] {
    projection.turnItems.compactMap { item in
      guard case let .userMessage(message) = item.content else { return nil }
      return (item.id, message.messageId, message.text)
    }
  }

  /// Every user message the machine holds: timeline items, then messages that
  /// have none yet (queued ones). Ids of the latter are prefixed so the two
  /// kinds never collide.
  static func receivedUserMessages(_ projection: ThreadProjection) -> [(id: String, messageId: String, text: String)] {
    let items = userMessages(projection)
    let inTimeline = Set(items.map(\.messageId))
    let waiting = projection.messages
      .filter { $0.role == .user && !inTimeline.contains($0.id) }
      .map { (id: "message:\($0.id)", messageId: $0.id, text: $0.text) }
    return items + waiting
  }

  // MARK: - Helpers

  static func todoStep(_ step: PlanStep) -> TodoStep {
    let status: TodoStep.Status = switch step.status.known {
    case .completed: .completed
    case .running: .running
    default: .pending
    }
    return TodoStep(id: step.id, text: step.text, status: status)
  }

  static func toolStatus(_ status: TurnItemStatus, failed: Bool = false) -> ToolStatus {
    switch status.known {
    case .pending, .running, .waiting: .running
    case .failed, .cancelled, .interrupted: .failed
    default: failed ? .failed : .completed
    }
  }

  static func approvalPrompt(_ kind: RuntimeRequestKind, appName: String?) -> String {
    switch kind.known {
    case .command: "Allow this command?"
    case .fileRead: "Allow reading these files?"
    case .fileChange: "Allow these file changes?"
    case .mcpElicitation: appName.map { "\($0) is asking for input." } ?? "A tool is asking for input."
    case .dynamicToolCall: "Allow this tool call?"
    default: "Allow this action?"
    }
  }

  static func lineCounts(additions: Int?, deletions: Int?) -> String? {
    switch (additions, deletions) {
    case (nil, nil): nil
    case let (a, d): "+\(a ?? 0) −\(d ?? 0)"
    }
  }

  static func fileName(_ path: String) -> String {
    let name = (path as NSString).lastPathComponent
    return name.isEmpty ? path : name
  }

  static func firstLine(_ text: String) -> String {
    let line = text.split(whereSeparator: \.isNewline).first.map(String.init) ?? text
    let trimmed = line.trimmingCharacters(in: .whitespaces)
    return trimmed.count > 200 ? String(trimmed.prefix(200)) + "…" : trimmed
  }

  static func detail(_ output: String?) -> String? {
    guard let output else { return nil }
    let trimmed = output.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }
    let limit = 2_000
    return trimmed.count > limit ? "…" + String(trimmed.suffix(limit)) : trimmed
  }
}
