import XCTest

/// What agents hand over, on sample data: Mermaid replies, a saved report and
/// the files it links. `SWC_SHOT_DIR` (`TEST_RUNNER_SWC_SHOT_DIR` through
/// xcodebuild) receives each screenshot as a PNG as well, for before/after evidence.
@MainActor
final class ArtifactRenderingUITests: SWCUITestCase {
  private var shot = 0
  private var appearance = "light"

  func testArtifactsLight() throws { try walkArtifacts(appearance: "light") }
  func testArtifactsDark() throws { try walkArtifacts(appearance: "dark") }

  private func walkArtifacts(appearance: String) throws {
    self.appearance = appearance
    launch(fixture: "artifacts", appearance: appearance)
    waitForHome()
    settle(2)
    capture("chat-latest")
    let flow = element(containing: "release path")
    revealOlder(flow)
    settle(2)
    capture("chat-mermaid")

    open("iPhone rendering review", name: "report", scrolls: 3) { self.openLinkedNotes() }
    open("release-dashboard.html", name: "html")
    open("release-checks.csv", name: "sheet")
    open("release-flow.svg", name: "svg")
    open("release-plan.excalidraw", name: "whiteboard")
    open("notes.md", name: "notes")
  }

  /// A relative link inside the report opens that file on top; closing it
  /// returns to the report, still open.
  private func openLinkedNotes() {
    let viewer = app.descendants(matching: .any).matching(identifier: "hostFile.viewer")
    let link = viewer.firstMatch.links.matching(NSPredicate(format: "label CONTAINS %@", "release notes")).firstMatch
    guard link.waitForExistence(timeout: 5) else {
      capture("report-link-missing")
      XCTFail("The report's relative link is not a link")
      return
    }
    link.tap()
    XCTAssertTrue(app.staticTexts["notes.md"].waitForExistence(timeout: 10), "The linked notes did not open")
    settle(2)
    capture("report-linked-notes")
    let closes = app.buttons.matching(identifier: "hostFile.close")
    closes.element(boundBy: closes.count - 1).tap()
    settle(1.5)
    XCTAssertEqual(viewer.count, 1, "Closing the notes should leave the report open")
    XCTAssertTrue(app.descendants(matching: .any)["markdown.document.title"].exists, "The report is not on screen")
    capture("report-back")
  }

  private func open(_ label: String, name: String, scrolls: Int = 0, inside: (() -> Void)? = nil) {
    let link = app.links.matching(NSPredicate(format: "label CONTAINS %@", label)).firstMatch
    revealNewer(link)
    guard link.waitForExistence(timeout: 5) else {
      capture("\(name)-not-a-link")
      return
    }
    link.tap()
    let viewer = app.descendants(matching: .any)["hostFile.viewer"]
    XCTAssertTrue(viewer.waitForExistence(timeout: 10), "\(label) did not open")
    settle(3)
    capture(name)
    inside?()
    for index in 0..<scrolls {
      app.swipeUp()
      settle(1.5)
      capture("\(name)-\(index + 2)")
    }
    let close = app.buttons["hostFile.close"]
    if close.exists { close.tap() }
    _ = viewer.waitForNonExistence(timeout: 5)
    settle(0.6)
  }

  private func revealOlder(_ element: XCUIElement) { reveal(element, older: true) }
  private func revealNewer(_ element: XCUIElement) { reveal(element, older: false) }

  /// Scrolls the transcript until `element` sits below the glass top bar.
  private func reveal(_ element: XCUIElement, older: Bool) {
    let menu = button("Menu")
    let topBar = menu.exists ? menu.frame.maxY : 0
    func reachable() -> Bool { element.exists && element.isHittable && element.frame.minY >= topBar }
    for _ in 0..<12 {
      if reachable() { return }
      let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: older ? 0.3 : 0.7))
      let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: older ? 0.72 : 0.3))
      start.press(forDuration: 0.05, thenDragTo: end)
    }
  }

  private func capture(_ name: String) {
    shot += 1
    let screenshot = XCUIScreen.main.screenshot()
    let label = String(format: "%@-%02d-%@", appearance, shot, name)
    let attachment = XCTAttachment(screenshot: screenshot)
    attachment.name = label
    attachment.lifetime = .keepAlways
    add(attachment)
    if let dir = ProcessInfo.processInfo.environment["SWC_SHOT_DIR"], !dir.isEmpty {
      try? screenshot.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(label).png"))
    }
  }
}
