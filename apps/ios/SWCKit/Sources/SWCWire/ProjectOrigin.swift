import Foundation

/// Who a project is for, as the web's `@specweave-studio/shared/projectOrigin`.
/// Release checks, acceptance runs and handoff proofs make real projects; the person
/// never works in them, so the drawer lists them apart under "Automated". The flag is
/// saved when a check says so at creation or a temporary agent token makes the
/// project; any other project is judged by its folder each time. A saved choice wins.
public enum ProjectOrigin: String, Codable, Hashable, Sendable {
  case user
  case automated

  /// Folder-name words that only checks and fixtures use.
  static let automatedFolderWords: Set<String> = ["scratch", "verification", "acceptance", "fixture", "fixtures"]

  /// The app's own data folders; a project inside one was made by the app or an agent.
  static let appDataFolders: [[String]] = [
    [".specwithcode"],
    [".specweave-studio"],
    [".local", "share", "specweave"],
    [".local", "share", "specweave-studio"],
  ]

  static let tempPrefixes = ["/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/"]

  /// True when a folder is plainly a check's workspace. The app's projects folder
  /// (`<data>/<machine>/projects`) is always the person's, whatever the project is called.
  public static func isAutomatedWorkspaceRoot(_ workspaceRoot: String) -> Bool {
    let normalized = workspaceRoot.replacingOccurrences(of: "\\", with: "/")
    let lower = normalized.lowercased()
    if tempPrefixes.contains(where: { lower.hasPrefix($0) }) || lower.contains("/appdata/local/temp/") { return true }
    let lowered = normalized.split(separator: "/").map { $0.lowercased() }
    var inAppData = false
    for index in lowered.indices {
      guard let data = appDataFolders.first(where: { sequence in
        sequence.enumerated().allSatisfy { offset, part in
          index + offset < lowered.count && lowered[index + offset] == part
        }
      }) else { continue }
      let rest = Array(lowered.dropFirst(index + data.count))
      if rest.first == "projects" || (rest.count > 1 && rest[1] == "projects") { return false }
      inAppData = true
    }
    if inAppData { return true }
    return lowered.contains { segment in
      segment.split(whereSeparator: { "-_. ".contains($0) }).contains { automatedFolderWords.contains(String($0)) }
    }
  }
}

extension ProjectShell {
  /// The saved origin, else a temporary agent session, else the folder.
  public var origin: ProjectOrigin {
    if let saved = workspaceSettings?.origin { return saved }
    if workspaceSettings?.temporarySessionId != nil { return .automated }
    // The personal assistant is the person's own wherever its folder is.
    if isPersonal { return .user }
    return ProjectOrigin.isAutomatedWorkspaceRoot(workspaceRoot) ? .automated : .user
  }

  public var isAutomated: Bool { origin == .automated }
}
