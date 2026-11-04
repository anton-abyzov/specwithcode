import Foundation

/// How much of an agent's work a transcript shows. The same three levels as
/// the desktop app's Replies setting; the phone keeps its own choice.
public enum TimelineDetail: String, CaseIterable, Sendable, Identifiable {
  /// Results only: your messages, each turn's reply and one fold per turn.
  case concise
  /// Folded steps: finished turns fold; the running turn shows its steps.
  case normal
  /// Everything: every step, thought and message.
  case verbose

  public var id: String { rawValue }
  public static let `default`: TimelineDetail = .normal
  public static let defaultsKey = "timelineDetail"

  public var label: String {
    switch self {
    case .concise: "Results only"
    case .normal: "Folded steps"
    case .verbose: "Everything"
    }
  }

  public var summary: String {
    switch self {
    case .concise: "Hide thinking, tool runs and in-between messages; one line per turn, opened on tap"
    case .normal: "Fold finished turns; the running turn shows its steps"
    case .verbose: "Show every step, thought and message"
    }
  }

  /// The level saved on this device, or the default.
  public static func stored(in defaults: UserDefaults = .standard) -> TimelineDetail {
    defaults.string(forKey: defaultsKey).flatMap(TimelineDetail.init(rawValue:)) ?? .default
  }
}

/// Folds a transcript's steps to the chosen detail level. Pure, so every
/// engine (live, cached and fixture) shows the same thing.
public enum TranscriptFolding {
  /// The rows the chat shows. Turns are the rows after each of your messages.
  /// `isRunning` keeps the last turn open as the running one; a turn waiting on
  /// your approval or answer counts as running too. `expandedFolds` holds the
  /// fold row ids the person opened.
  public static func rows(
    _ rows: [TranscriptRow],
    detail: TimelineDetail,
    isRunning: Bool,
    expandedFolds: Set<String> = []
  ) -> [TranscriptRow] {
    guard detail != .verbose else { return rows }
    var segments: [[TranscriptRow]] = [[]]
    for row in rows {
      if row.isUser { segments.append([row]) } else { segments[segments.count - 1].append(row) }
    }
    var result: [TranscriptRow] = []
    for (index, segment) in segments.enumerated() {
      // Only the last turn runs; right after you send, the earlier turn is done.
      let running = isRunning && index == segments.count - 1
      let active = running || segment.contains(where: \.awaitsAnswer)
      result += fold(segment, detail: detail, active: active, running: running, expandedFolds: expandedFolds)
    }
    return result
  }

  /// The id of the fold row that stands for the turn starting at `firstRow`.
  public static func foldId(for firstRow: TranscriptRow?) -> String {
    "fold:\(firstRow?.id ?? "head")"
  }

  static func fold(
    _ segment: [TranscriptRow],
    detail: TimelineDetail,
    active: Bool,
    running: Bool,
    expandedFolds: Set<String>
  ) -> [TranscriptRow] {
    if active, detail == .normal { return segment }
    // Results only never shows thinking, opened or not.
    let rows = detail == .concise ? segment.filter { !$0.isReasoning } : segment
    let lastReply = rows.lastIndex { row in
      if case let .assistant(markdown, _) = row.kind { !markdown.isEmpty } else { false }
    }
    func isStep(_ row: TranscriptRow, at index: Int) -> Bool {
      switch row.kind {
      case .reasoning, .tool, .subagent: true
      case .assistant: index != lastReply
      default: false
      }
    }
    let steps = rows.enumerated().filter { isStep($0.element, at: $0.offset) }.map(\.element)
    let stepIds = Set(steps.map(\.id))
    guard !steps.isEmpty, let firstStep = rows.firstIndex(where: { stepIds.contains($0.id) }) else {
      return rows
    }
    let id = foldId(for: segment.first)
    let expanded = expandedFolds.contains(id)
    let foldRow = TranscriptRow(id: id, kind: .fold(
      label: running ? "Working" : "Worked",
      summary: summary(of: steps),
      failures: steps.count { if case .tool(_, _, _, .failed) = $0.kind { true } else { false } },
      expanded: expanded,
      running: running
    ))
    if active {
      // The running turn in Results only: its latest reply, then its live work.
      let kept = rows.filter { !stepIds.contains($0.id) }
      let tools = steps.filter { !$0.isAssistant }
      guard !tools.isEmpty else { return kept }
      return kept + [foldRow] + (expanded ? tools : [])
    }
    if expanded {
      var opened = rows
      opened.insert(foldRow, at: firstStep)
      return opened
    }
    var folded = rows.filter { !stepIds.contains($0.id) }
    let at = rows[..<firstStep].count { !stepIds.contains($0.id) }
    folded.insert(foldRow, at: at)
    return folded
  }

  /// "Ran 3 commands · Edited 1 file · 2 searches · 1 agent", or nil for thoughts and notes alone.
  static func summary(of steps: [TranscriptRow]) -> String? {
    var commands = 0, edits = 0, searches = 0, tools = 0, agents = 0
    for step in steps {
      switch step.kind {
      case let .tool(_, _, symbol, _):
        switch symbol {
        case "terminal": commands += 1
        case "pencil": edits += 1
        case "magnifyingglass", "globe": searches += 1
        default: tools += 1
        }
      case .subagent: agents += 1
      default: break
      }
    }
    func plural(_ count: Int, _ one: String, _ many: String) -> String { count == 1 ? "1 \(one)" : "\(count) \(many)" }
    var parts: [String] = []
    if commands > 0 { parts.append("Ran " + plural(commands, "command", "commands")) }
    if edits > 0 { parts.append("Edited " + plural(edits, "file", "files")) }
    if searches > 0 { parts.append(plural(searches, "search", "searches")) }
    if tools > 0 { parts.append(plural(tools, "tool call", "tool calls")) }
    if agents > 0 { parts.append(plural(agents, "agent", "agents")) }
    return parts.isEmpty ? nil : parts.joined(separator: " · ")
  }
}

extension TranscriptRow {
  var isUser: Bool { if case .user = kind { true } else { false } }
  var isAssistant: Bool { if case .assistant = kind { true } else { false } }
  var isReasoning: Bool { if case .reasoning = kind { true } else { false } }
  /// An approval, question or access request still waiting for the person.
  var awaitsAnswer: Bool {
    switch kind {
    case .approval(_, _, resolved: false, _, _), .question(_, _, resolved: false): true
    case let .access(request): request.awaitsAnswerHere
    default: false
    }
  }
}
