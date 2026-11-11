import XCTest

@MainActor
final class ThreadListParityUITests: SWCUITestCase {
  func testRecentDateGroupsAndProviderLabels() throws { try verifyRecents(appearance: "light") }
  func testRecentDateGroupsDark() throws { try verifyRecents(appearance: "dark") }

  private func verifyRecents(appearance: String) throws {
    launch(fixture: "thread-lists", route: "drawer", appearance: appearance)
    waitFor(text(startingWith: "Recents"))
    XCTAssertTrue(button(startingWith: "Release 3.1 checklist").label.contains("Claude Code · Opus 5.5"))
    XCTAssertTrue(button(startingWith: "Write handoff docs").label.contains("Codex · GPT-6.1 Sol"))
    // Scroll through the real drawer, retaining the same chronological order.
    for label in ["Today", "Yesterday", "Previous 7 days", "Previous 30 days", "Older"] {
      let heading = text(startingWith: label)
      for _ in 0..<5 where !heading.isHittable { app.swipeUp() }
      waitForHittable(heading)
      attachScreenshot("Recents-\(appearance)-\(label)")
    }
    XCTAssertFalse(text(startingWith: "Unknown").exists)
  }

  func testProjectGroupsAndModelBadgesLight() throws { try verifyProject(appearance: "light") }
  func testProjectGroupsAndModelBadgesDark() throws { try verifyProject(appearance: "dark") }

  private func verifyProject(appearance: String) throws {
    launch(fixture: "thread-lists", route: "overview", appearance: appearance)
    waitFor(text(startingWith: "Needs you"))
    waitFor(text(startingWith: "Working"))
    XCTAssertTrue(button(startingWith: "Release 3.1 checklist").label.contains("Claude Code · Opus 5.5"))
    XCTAssertTrue(button(startingWith: "Write handoff docs").label.contains("Codex · GPT-6.1 Sol"))
    XCTAssertTrue(button(startingWith: "Fix ledger merge conflicts").label.contains("GitHub Copilot · Opus 5.5"))
    attachScreenshot("Project-groups-\(appearance)")
    app.swipeUp()
    waitFor(text(startingWith: "Idle"))
    let resolved = button(startingWith: "Resolved")
    waitForHittable(resolved)
    resolved.tap()
    waitFor(button(startingWith: "Draft changelog"))
    attachScreenshot("Project-resolved-\(appearance)")
    button(startingWith: "Draft changelog").tap()
    waitForHittable(button("Thread actions"))
  }

  func testImportedSessionsReadCleanlyLight() throws { try verifyImported(appearance: "light") }
  func testImportedSessionsReadCleanlyDark() throws { try verifyImported(appearance: "dark") }

  /// A new install's first project: the thread its coordinator started is
  /// listed, and no imported session prints harness markup.
  private func verifyImported(appearance: String) throws {
    launch(fixture: "imported", route: "overview", appearance: appearance)
    waitFor(text(startingWith: "Idle"))
    XCTAssertTrue(button(startingWith: "In-progress tasks inventory").label.contains("Claude Code · Opus 5.5"))
    let resolved = button(startingWith: "Resolved")
    waitForHittable(resolved)
    resolved.tap()
    waitFor(button(startingWith: "Plan this week of workouts"))
    XCTAssertTrue(button(startingWith: "Initialize Git and add a README.").label.contains("Codex · GPT-5.5"))
    XCTAssertTrue(button(startingWith: "Imported session").exists)
    XCTAssertFalse(element(containing: "<environment_context>").exists)
    // One machine: no row spends a line on its name.
    XCTAssertFalse(element(containing: "Office Mac").exists)
    attachScreenshot("Imported-\(appearance)")
  }
}
