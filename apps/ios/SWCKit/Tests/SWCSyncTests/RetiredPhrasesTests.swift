import Foundation
import Testing

/// Strings the iOS app no longer shows, written exactly as the source had
/// them (interpolation included). Phase 1 of 1390 retired the project roles:
/// Main, Copy as a role and Take over as an action. The test reads every
/// .swift file under SWCKit/Sources and fails on any retired string outside
/// a comment line.
@Suite struct RetiredPhrasesTests {
  static let retired: [String] = [
    "This project is not linked to another machine. Link it from the desktop app before handing off.",
    "Coordinator. Plans the work and can send it to every copy.",
    "Runs workers. Its own coordinator is read-only history until you start a coordinator here.",
    "Update SpecWithCode on \\(copy.machineLabel) to take over.",
    "\\(coordinator.machineLabel) has been unreachable for 10 minutes or more. This copy can take over the coordinator.",
    "\\(coordinator.machineLabel) is unreachable. This copy can take over the coordinator in \\(max(1, Int((availability.wait / 60).rounded(.up)))) min if it stays away.",
    "Review the coordinator turns this copy ran after that.",
    "This copy becomes the coordinator, starting from the notes",
    "has a copy of \\(project) and is switched off on this phone.",
    "machines with a copy of \\(project) are switched off on this phone.",
    "Coordinator on \\(viewing?.machineLabel ?? \"this machine\")",
    "Each machine keeps its own copy. One coordinates; the others run workers.",
    "Take over the coordinator on \\(confirming?.copy.machineLabel ?? \"this machine\")?",
    "Button(\"Take over\") {",
    "Take over coordinator here",
    "Another copy can take over this coordinator when its machine stops answering.",
    "Take over automatically on",
    "Check the machines and take over again if you still need to.",
    "Take over did not finish. Retry it.",
    // Equal coordinators: every machine runs its own, and none continues another's.
    "Coordinator. Plans the work and can start it on every machine.",
    "The coordinator is on another machine. An older conversation here is read-only history.",
    "Coordinator handoff pending.",
    "WeaveButton(\"Continue the coordinator here\"",
    "Continue the coordinator on \\(confirming?.copy.machineLabel ?? \"this machine\")?",
    "Each machine has the project's files. The coordinator conversation is on one of them.",
    "The coordinator can continue here.",
    "Continue automatically on",
    "Another machine can continue this coordinator when its machine stops answering.",
  ]

  static let sources: URL = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent() // SWCSyncTests
    .deletingLastPathComponent() // Tests
    .deletingLastPathComponent() // SWCKit
    .appendingPathComponent("Sources")

  static func swiftFiles() -> [URL] {
    let walker = FileManager.default.enumerator(at: sources, includingPropertiesForKeys: nil)
    var files: [URL] = []
    while let url = walker?.nextObject() as? URL {
      if url.pathExtension == "swift" { files.append(url) }
    }
    return files.sorted { $0.path < $1.path }
  }

  @Test func everyRetiredStringIsLongEnoughToMeanOneThing() {
    for phrase in Self.retired {
      #expect(phrase.count >= 20, "\(phrase) is too short to name one string")
    }
  }

  @Test func theSourcesAreRead() {
    // A wrong path would make the scan below pass on nothing.
    #expect(Self.swiftFiles().count > 50)
    #expect(Self.swiftFiles().contains { $0.lastPathComponent == "LinkedProjects.swift" })
  }

  @Test func noSourceFileHoldsARetiredString() throws {
    for file in Self.swiftFiles() {
      let text = try String(contentsOf: file, encoding: .utf8)
      let code = text.split(separator: "\n", omittingEmptySubsequences: false)
        .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
        .joined(separator: "\n")
      let relative = file.path.replacingOccurrences(of: Self.sources.path + "/", with: "")
      for phrase in Self.retired where code.contains(phrase) {
        Issue.record("\(relative) still holds the retired string: \(phrase)")
      }
    }
  }
}
