import Foundation
import Testing

/// The assistant's name is the personal project's title. A quoted old or default
/// name in a view would show instead of the name the user chose, as the drawer
/// row once did. Previews and sample data may use the default.
@Suite struct AssistantNameSourceTests {
  @Test func viewsNeverHardcodeTheAssistantName() throws {
    let sources = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      .appendingPathComponent("Sources")
    let allowed: Set<String> = ["AideSetting.swift", "FixtureEngine.swift", "DrawerContainer.swift", "ProjectAvatar.swift"]
    var hits: [String] = []
    let files = FileManager.default.enumerator(at: sources, includingPropertiesForKeys: nil)
    while let file = files?.nextObject() as? URL {
      guard file.pathExtension == "swift", !allowed.contains(file.lastPathComponent) else { continue }
      let text = try String(contentsOf: file, encoding: .utf8)
      for (index, line) in text.split(separator: "\n", omittingEmptySubsequences: false).enumerated() {
        let code = line.components(separatedBy: "//").first ?? ""
        if code.contains("\"Aide\"") || code.contains("\"Percy\"") || code.contains("\"Set up Aide\"") {
          hits.append("\(file.lastPathComponent):\(index + 1)")
        }
      }
    }
    #expect(hits.isEmpty, "Use the assistant's title or AideSetting.defaultName: \(hits)")
  }
}
