import Foundation

/// The title a thread row shows.
public enum ThreadTitle {
  /// The thread's title, "New thread" when it has none, and "Imported session"
  /// when a desktop that predates the import fix stored a session's first raw
  /// line, such as `<environment_context>`. That desktop renames the thread
  /// once it updates; until then the row must not print markup.
  public static func shown(_ raw: String) -> String {
    let title = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    if title.isEmpty { return "New thread" }
    return isHarnessMarkup(title) ? "Imported session" : title
  }

  /// Mirrors the server's `isHarnessMarkupTitle`; both run packages/shared/src/threadList.cases.json.
  public static func isHarnessMarkup(_ title: String) -> Bool {
    let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.range(of: #"^#+ AGENTS\.md instructions"#, options: .regularExpression) != nil { return true }
    guard let tag = trimmed.range(of: #"^<[A-Za-z][\w:-]*(\s[^<>]*)?/?>?"#, options: .regularExpression) else { return false }
    // The whole title is one tag, closed or cut off by the title's length.
    if tag.upperBound == trimmed.endIndex { return true }
    guard trimmed[tag].hasSuffix(">") else { return false }
    let name = trimmed.dropFirst().prefix { $0.isLetter || $0.isNumber || "_:-".contains($0) }.lowercased()
    return setupBlocks.contains(name) || name.hasPrefix("command-")
  }

  /// Blocks that only ever hold harness text, never the person's words.
  private static let setupBlocks: Set<String> = [
    "environment_context", "system-reminder", "system_reminder", "user_instructions", "instructions",
    "permissions", "skills_instructions", "collaboration_mode", "turn_aborted", "subagent_notification",
    "task-notification", "local-command-stdout", "local-command-stderr", "local-command-caveat",
    "command-message", "command-stdout", "command-stderr", "bash-input", "bash-stdout", "bash-stderr",
    "user-prompt-submit-hook", "session-start-hook", "ide_opened_file", "ide_selection", "image",
  ]
}
