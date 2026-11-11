import XCTest

/// Pictures in replies, against a real server. Skipped unless `SWC_LIVE_LINK`
/// holds a fresh pairing link. The server needs a project `SWC_LIVE_PROJECT`
/// with a thread `SWC_LIVE_THREAD` holding an attached image, a reply that
/// embeds an absolute path, one that embeds a web address and one that only
/// names a picture by path; its coordinator needs an embedded picture too.
/// `SWC_SHOT_DIR`, when set, receives each screenshot as a PNG as well.
/// `SWC_MEDIA_BEFORE=1` only takes the screenshots, for a build without pictures.
@MainActor
final class LiveInlineMediaTests: XCTestCase {
  private var app: XCUIApplication!
  private var shot = 0
  private let env = ProcessInfo.processInfo.environment
  private var before: Bool { env["SWC_MEDIA_BEFORE"] == "1" }

  override func setUp() async throws {
    continueAfterFailure = false
    app = XCUIApplication()
    app.launchArguments = ["-SWCAppearance", "light", "-SWCDirectOnly"]
  }

  func testPicturesShowInAThreadAndTheCoordinator() throws {
    guard let link = env["SWC_LIVE_LINK"], !link.isEmpty else {
      throw XCTSkip("Set SWC_LIVE_LINK to a pairing link to run live tests.")
    }
    let threadName = env["SWC_LIVE_THREAD"] ?? "Inline media check"
    let projectName = env["SWC_LIVE_PROJECT"] ?? "Inline media"
    app.launch()

    let pair = app.buttons["Pair with a link or QR code"].firstMatch
    let pairMachine = app.buttons["Pair a machine"].firstMatch
    XCTAssertTrue(pair.waitForExistence(timeout: 20) || pairMachine.exists, "Welcome screen did not appear")
    (pair.exists ? pair : pairMachine).tap()
    let field = app.textFields["Pairing link"]
    XCTAssertTrue(field.waitForExistence(timeout: 5))
    field.tap()
    field.typeText(link)
    app.buttons["Connect"].tap()
    XCTAssertTrue(field.waitForNonExistence(timeout: 30), "Pairing did not finish: \(visibleText())")

    openDrawer()
    let thread = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", threadName)).firstMatch
    XCTAssertTrue(thread.waitForExistence(timeout: 30), "Thread missing: \(visibleText())")
    thread.tap()
    waitForDrawerClosed()

    let images = app.buttons.matching(identifier: "markdown.image")
    let fallback = app.buttons["markdown.mediaFallback"].firstMatch
    if before {
      sleep(4)
      capture("thread")
      app.swipeDown()
      sleep(1)
      capture("thread-earlier")
    } else {
      XCTAssertTrue(fallback.waitForExistence(timeout: 30), "No thumbnail for the path-only reply: \(visibleText())")
      sleep(4)
      capture("thread")
      XCTAssertFalse(app.staticTexts["Image unavailable"].exists, "A picture failed to load")

      // A tap opens the file itself in the viewer.
      fallback.tap()
      let viewer = app.descendants(matching: .any)["hostFile.viewer"]
      XCTAssertTrue(viewer.waitForExistence(timeout: 10), "Viewer did not open")
      sleep(3)
      capture("thread-full-file")
      app.buttons["hostFile.close"].firstMatch.tap()
      XCTAssertTrue(viewer.waitForNonExistence(timeout: 5), "Viewer did not close")

      app.swipeDown()
      sleep(2)
      capture("thread-earlier")
      XCTAssertTrue(images.firstMatch.exists, "No embedded picture in the thread: \(visibleText())")
      app.swipeDown()
      sleep(2)
      capture("thread-start")
      XCTAssertTrue(app.buttons["message.attachment"].firstMatch.exists, "The attached image is missing")
      XCTAssertFalse(app.staticTexts["Image unavailable"].exists, "A picture failed to load")
    }

    openDrawer()
    // The project's row opens its coordinator.
    let coordinator = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@ AND NOT (label BEGINSWITH %@)", projectName, threadName)).firstMatch
    XCTAssertTrue(coordinator.waitForExistence(timeout: 15), "Coordinator missing: \(buttonLabels())")
    coordinator.tap()
    waitForDrawerClosed()
    if !before {
      XCTAssertTrue(images.firstMatch.waitForExistence(timeout: 30), "No embedded picture in the coordinator: \(visibleText())")
      XCTAssertTrue(fallback.waitForExistence(timeout: 15), "No thumbnail in the coordinator")
    }
    sleep(4)
    capture("coordinator")
    XCTAssertFalse(app.staticTexts["Image unavailable"].exists, "A picture failed to load")
  }

  // MARK: - Helpers

  private func capture(_ name: String) {
    shot += 1
    let screenshot = XCUIScreen.main.screenshot()
    let label = String(format: "%02d-%@", shot, name)
    let attachment = XCTAttachment(screenshot: screenshot)
    attachment.name = label
    attachment.lifetime = .keepAlways
    add(attachment)
    if let dir = env["SWC_SHOT_DIR"], !dir.isEmpty {
      try? screenshot.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(label).png"))
    }
  }

  private func openDrawer() {
    let close = app.descendants(matching: .any)["Close menu"]
    if close.exists { return }
    let menu = app.buttons["Menu"].firstMatch
    if !menu.waitForExistence(timeout: 5) {
      let back = app.buttons["Back"].firstMatch
      if back.exists { back.tap() }
    }
    // A wide Duo layout keeps the drawer open beside the thread.
    if !menu.waitForExistence(timeout: 5) { return }
    menu.tap()
    _ = close.waitForExistence(timeout: 5)
    sleep(1)
  }

  private func waitForDrawerClosed() {
    let close = app.descendants(matching: .any)["Close menu"]
    let deadline = Date().addingTimeInterval(5)
    while close.exists, Date() < deadline { usleep(200_000) }
    usleep(500_000)
  }

  private func visibleText() -> String {
    app.staticTexts.allElementsBoundByIndex.prefix(40).map { $0.label }.filter { !$0.isEmpty }.joined(separator: " | ")
  }

  private func buttonLabels() -> String {
    app.buttons.allElementsBoundByIndex.prefix(40).map { $0.label }.filter { !$0.isEmpty }.joined(separator: " | ")
  }
}
