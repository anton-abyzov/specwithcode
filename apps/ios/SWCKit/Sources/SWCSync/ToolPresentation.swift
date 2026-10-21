import Foundation
import SWCWire

/// Human-facing activity titles. The exact provider tool name remains available
/// in the disclosure, including for unknown tools. Never infer success from text.
struct ToolPresentation {
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
    title = names[key] ?? "Use tool"
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
    detail = failure.map { "\($0)\nTool: \(name)" } ?? "Tool: \(name)"
  }
}
