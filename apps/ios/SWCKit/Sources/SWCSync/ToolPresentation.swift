import Foundation
import SWCWire

/// Human-facing activity titles. The tool's name remains available in the
/// disclosure, including for unknown tools: a SpecWithCode tool by its own
/// name, any other by the exact provider name. Never infer success from text.
struct ToolPresentation {
  static let toolLinePrefix = "Tool: "

  let title: String
  let detail: String
  let failed: Bool

  init(name: String, output: JSONValue?, failed itemFailed: Bool = false) {
    let action = name.components(separatedBy: ".").last ?? name
    let key = action.components(separatedBy: "__").last ?? action
    let names = [
      "studio_thread_list": "Find conversations",
      "studio_thread_read": "Read conversation",
      "studio_thread_send": "Send to conversation",
      "studio_thread_launch": "Start conversation",
      "studio_project_list": "Find projects",
      "studio_project_memory_read": "Read project notes",
      "studio_project_memory_write": "Save project note",
      "studio_project_knowledge_search": "Search project knowledge",
      "studio_project_knowledge_read": "Read project knowledge",
      "update_plan": "Update provider checklist",
      "request_user_input": "Ask a question",
      "exec_command": "Run command",
      "apply_patch": "Edit files",
    ]
    title = names[key] ?? ToolPresentation.readableName(key)
    var failure: String?
    if case let .object(object) = output, itemFailed || object["isError"] == .bool(true) {
      if case let .array(content) = object["content"] {
        failure = content.compactMap { value -> String? in
          guard case let .object(block) = value, case let .string(text) = block["text"] else { return nil }
          return text
        }.joined(separator: "\n")
      }
      if failure?.isEmpty != false, case let .string(message) = object["message"] { failure = message }
      if failure?.isEmpty != false { failure = "The tool reported an error." }
    }
    if failure == nil, itemFailed {
      if case let .string(message) = output { failure = message }
      else if let output, let data = try? JSONEncoder().encode(output) { failure = String(data: data, encoding: .utf8) }
    }
    failed = itemFailed || failure != nil
    let toolLine = Self.toolLinePrefix + Self.disclosedName(name, key: key)
    detail = failure.map { "\($0)\n\(toolLine)" } ?? toolLine
  }

  /// `mcp__studio-code__studio_thread_launch` and `studio-code.studio_thread_launch`
  /// read `studio_thread_launch`; another server's tool keeps its full name.
  static func disclosedName(_ name: String, key: String) -> String {
    let servers = ["studio-code", "studio_code", "studiocode", "studio"]
    let isStudio = servers.contains { name == "mcp__\($0)__\(key)" || name == "\($0).\(key)" }
    return isStudio ? key : name
  }

  /// What a failed row shows before it is opened: the reason, without the
  /// tool line. Nil when the detail is the tool line alone.
  static func failureReason(inDetail detail: String?) -> String? {
    guard let detail, let range = detail.range(of: "\n" + toolLinePrefix, options: .backwards) else { return nil }
    let reason = String(detail[..<range.lowerBound])
    return reason.isEmpty ? nil : reason
  }

  /// A tool without a hand-written title, named from its own name:
  /// `chrome_screenshot` reads "Chrome screenshot".
  static func readableName(_ key: String) -> String {
    let words = key
      .replacingOccurrences(of: "_", with: " ")
      .replacingOccurrences(of: "-", with: " ")
      .split(separator: " ")
      .joined(separator: " ")
    guard let first = words.first else { return "Use tool" }
    return first.uppercased() + words.dropFirst()
  }
}

public extension TranscriptRow {
  /// A failed tool row's reason alone, for the row before it is opened.
  static func toolFailureReason(inDetail detail: String?) -> String? {
    ToolPresentation.failureReason(inDetail: detail)
  }
}
