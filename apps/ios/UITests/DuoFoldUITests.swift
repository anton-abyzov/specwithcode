import XCTest

/// Real hinge folds on the iPhone Duo simulator. The test cannot fold the
/// device itself, so it writes the pose it wants into the folder named by
/// `SWC_DUO_FOLD_SIGNAL` and `Tools/duo-fold-test.sh` applies it with the
/// fold helper. Without that variable the test skips.
@MainActor
final class DuoFoldUITests: SWCUITestCase {
  private var signal: URL?

  override func setUp() async throws {
    try await super.setUp()
    guard let path = ProcessInfo.processInfo.environment["SWC_DUO_FOLD_SIGNAL"], !path.isEmpty else {
      throw XCTSkip("Run through Tools/duo-fold-test.sh on the Duo simulator")
    }
    signal = URL(fileURLWithPath: path)
  }

  func testFoldAndUnfoldKeepDraftScrollAndAccessibility() throws {
    launch(fixture: "long")
    try pose("closed")
    let input = field("Message")
    waitForHittable(input)
    tap(input)
    input.typeText("Unsent fold draft")
    // Scroll well up from the bottom, then pick a message fully on screen.
    for _ in 0..<6 { app.swipeDown(velocity: .fast) }
    settle()
    let anchor = try visibleCheckIn()
    attachScreenshot("Folded before unfolding")

    for (target, expanded) in [("open", true), ("closed", false)] {
      try pose(target)
      waitForHittable(input)
      XCTAssertEqual(input.value as? String, "Unsent fold draft", "Draft lost after \(target)")
      XCTAssertTrue(waitUntil { self.onScreen(self.app.staticTexts[anchor]) },
                    "Scroll position lost after \(target): \(anchor) is off screen")
      XCTAssertFalse(button("Close menu").exists, "A modal drawer covers the chat after \(target)")
      if expanded {
        waitForHittable(button("Search projects and threads"), "Sidebar not reachable after unfolding")
      } else {
        waitForHittable(button("Menu"), "Menu not reachable after folding")
      }
      if !expanded { attachScreenshot("After \(target)") }
    }
  }

  func testFoldAndUnfoldKeepTheSelectedThread() throws {
    launch(fixture: "default", route: "thread")
    try pose("closed")
    waitForHittable(field("Message"))
    let title = try XCTUnwrap(headerTitle(), "No thread title in the header")
    for target in ["open", "closed"] {
      try pose(target)
      waitForHittable(field("Message"))
      // Folded the title is a capsule button; beside the list it is plain text.
      let shown = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@ OR label BEGINSWITH %@", title, "\(title),"))
      XCTAssertTrue(waitUntil { shown.allElementsBoundByIndex.contains { self.onScreen($0) && $0.frame.minY < self.app.frame.minY + 120 } },
                    "Selected thread \(title) is not the open chat after \(target)")
    }
  }

  // MARK: Helpers

  /// Asks the host script for a pose and waits until the scene has it.
  private func pose(_ name: String) throws {
    let signal = try XCTUnwrap(signal)
    let before = app.frame.size
    let request = signal.appendingPathComponent("request")
    try name.write(to: request, atomically: true, encoding: .utf8)
    XCTAssertTrue(waitUntil(timeout: 60) { !FileManager.default.fileExists(atPath: request.path) },
                  "Host did not apply pose \(name)")
    let wantsWide = name == "open"
    let applied = waitUntil(timeout: 30) {
      let size = self.app.frame.size
      return wantsWide ? size.width > 600 : size.width < 600
    }
    XCTAssertTrue(applied, "Scene did not change for \(name): was \(before), now \(app.frame.size)")
    settle(1.5)
  }

  private func onScreen(_ element: XCUIElement) -> Bool {
    guard element.exists else { return false }
    let frame = element.frame
    return !frame.isEmpty && app.frame.contains(CGPoint(x: frame.midX, y: frame.midY))
  }

  private func visibleCheckIn() throws -> String {
    let texts = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Check-in")).allElementsBoundByIndex
    let visible = texts.filter { onScreen($0) && $0.frame.minY > app.frame.minY + 120 }
    let anchor = try XCTUnwrap(visible.first?.label, "No check-in message on screen after scrolling")
    XCTAssertFalse(visible.contains { $0.label.hasPrefix("Check-in 60") }, "Still at the bottom; scrolling did not move")
    return anchor
  }

  /// The title capsule's label, which starts with the chat's title.
  private func headerTitle() -> String? {
    let capsule = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", ",")).allElementsBoundByIndex
      .first { onScreen($0) && $0.frame.minY < app.frame.minY + 80 && $0.frame.width > 120 }
    return capsule?.label.components(separatedBy: ",").first
  }
}
