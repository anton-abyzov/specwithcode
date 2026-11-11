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
  /// Only a block a harness writes counts. `<Button>` or `<T>` is a title a person typed.
  public static func isHarnessMarkup(_ title: String) -> Bool {
    let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.range(of: #"^#+ AGENTS\.md instructions"#, options: .regularExpression) != nil { return true }
    guard trimmed.first == "<" else { return false }
    let rest = trimmed.dropFirst()
    // ASCII only, as the server's `\w` reads a tag name.
    guard let first = rest.first, first.isASCII, first.isLetter else { return false }
    let name = rest.prefix { $0.isASCII && ($0.isLetter || $0.isNumber || "_:-".contains($0)) }
    // The name ends the title (cut off by its length) or the tag goes on.
    if let next = rest.dropFirst(name.count).first, !">/ \t".contains(next) { return false }
    if let attribute = harnessAttribute[String(name)] {
      return trimmed == "<\(name)>" || trimmed.hasPrefix("<\(name) \(attribute)")
    }
    return harnessBlocks.contains(String(name)) || name.hasPrefix("command-")
  }

  /// Block names that are also words a person types count only with the attribute
  /// their harness always writes, or as the whole title.
  private static let harnessAttribute = ["wake": "reason=", "relay": "from=", "image": "name="]

  /// Blocks a harness writes and a person does not, in the case every harness writes them.
  private static let harnessBlocks: Set<String> = [
    "environment_context", "system-reminder", "system_reminder", "user_instructions", "skills_instructions",
    "collaboration_mode", "turn_aborted", "subagent_notification", "task-notification", "scheduled-task",
    "wake", "relay", "local-command-stdout", "local-command-stderr", "local-command-caveat",
    "bash-input", "bash-stdout", "bash-stderr", "user-prompt-submit-hook", "session-start-hook",
    "ide_opened_file", "ide_selection", "image",
  ]
}
