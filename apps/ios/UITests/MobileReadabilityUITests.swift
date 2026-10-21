import XCTest

/// Synthetic data through real native views. These demonstrate rendering and
/// navigation, not a live ledger read, provider execution or cross-Mac handoff.
@MainActor
final class MobileReadabilityUITests: SWCUITestCase {
  func testScheduledCheckUsesMarkdownAndReadableToolNames() throws {
    launch(fixture: "check-output")
    waitForHome()
    waitFor(button("Find conversations, Done"))
    waitFor(button("Send to conversation, Done"))
    let copy = button("Copy code")
    revealOlder(copy)
    XCTAssertTrue(copy.isHittable, "A user-role fenced payload must render as a code block")
    XCTAssertTrue(app.staticTexts["json"].exists)
    attachScreenshot("Scheduled check Markdown and readable orchestration activities")
    tap(button("Find conversations, Done"))
    waitFor(button(startingWith: "Find conversations, Tool: studio-code.studio_thread_list"))
    attachScreenshot("Exact protocol identity is optional technical detail")
  }

  func testReplyThreadLinkOpensKnownThreadAndItsRealPlanSurface() throws {
    launch(fixture: "readability")
    waitForHome()
    let link = app.links.matching(identifier: "studio://thread/t-release").firstMatch
    revealOlder(link)
    attachScreenshot("Sample Markdown table lists code and internal thread link")
    tap(link)
    waitForHittable(button(startingWith: "Release 3.1 checklist"))
    attachScreenshot("Internal link opens release thread on its original machine")

    tap(app.buttons["chat.increment"])
    waitFor(element(containing: "0970-phone-fleet-failover"))
    waitFor(element(containing: "T-05"))
    attachScreenshot("Bound SpecWeave increment with source binding and blocked task")
    let verification = app.staticTexts["Last verification failed"]
    revealNewer(verification)
    attachScreenshot("Ledger acceptance criteria verification and remote source")
    revealNewer(element(containing: "Remote source path"))
    attachScreenshot("Increment source is an honest remote machine path")
  }

  func testUnknownThreadLinkReportsWhyItCannotOpen() throws {
    launch(fixture: "readability")
    waitForHome()
    let link = app.links.matching(identifier: "studio://thread/not-loaded").firstMatch
    tap(link)
    waitFor(element(containing: "This thread is not available on this machine."))
    XCTAssertFalse(button("Thread actions").exists, "An unknown ID must not open a made-up conversation")
    attachScreenshot("Unknown thread link explains machine and connection limitation")
  }

  func testAideProviderChecklistIsNotAnIncrement() throws {
    launch(fixture: "readability")
    waitForHome()
    let checklist = element(containing: "Provider checklist, 1 of 2 done")
    revealOlder(checklist)
    attachScreenshot("Provider checklist remains conversation content")
    tap(app.buttons["chat.increment"])
    waitFor(element(containing: "No linked increment"))
    waitFor(element(containing: "A provider checklist does not create that binding."))
    XCTAssertFalse(element(containing: "0970-phone-fleet-failover").exists)
    attachScreenshot("Aide correctly reports no linked SpecWeave increment")
  }

  func testThreadsButtonExposesProjectConversations() throws {
    launch(fixture: "readability")
    waitForHome()
    openProject("SpecWeave")
    tap(app.buttons["chat.threads"])
    waitFor(text(startingWith: "Threads"))
    let release = hittableButton(titled("Release 3.1 checklist"))
    attachScreenshot("Visible Threads entry opens project thread list")
    tap(release)
    waitForHittable(button("Thread actions"))
    attachScreenshot("Thread list opens selected conversation")
  }

  func testSuccessfulToolDetailsCollapseButFailureStaysVisible() throws {
    launch(fixture: "readability")
    waitForHome()
    let success = button("Read conversation, Done")
    revealOlder(success)
    XCTAssertFalse(success.label.contains("mcp__"), "Successful activity should start with readable text")
    let failed = button(startingWith: "Find conversations, Project access denied.")
    revealOlder(failed)
    XCTAssertTrue(failed.label.contains("Ask the project owner for access."))
    attachScreenshot("Readable collapsed activity preserves material tool failure")
    revealOlder(success)
    tap(success)
    let expanded = button(startingWith: "Read conversation, Tool: mcp__studio_code__studio_thread_read")
    waitFor(expanded)
    attachScreenshot("Technical tool identity remains available on disclosure")
  }

  private func revealOlder(_ element: XCUIElement, file: StaticString = #filePath, line: UInt = #line) {
    reveal(element, older: true, file: file, line: line)
  }

  private func revealNewer(_ element: XCUIElement, file: StaticString = #filePath, line: UInt = #line) {
    reveal(element, older: false, file: file, line: line)
  }

  private func reveal(_ element: XCUIElement, older: Bool, file: StaticString, line: UInt) {
    for _ in 0..<12 {
      if element.exists && element.isHittable { return }
      let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: older ? 0.3 : 0.7))
      let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: older ? 0.72 : 0.3))
      start.press(forDuration: 0.05, thenDragTo: end)
    }
    XCTAssertTrue(element.exists && element.isHittable, "Expected content should be reachable by scrolling", file: file, line: line)
  }
}
