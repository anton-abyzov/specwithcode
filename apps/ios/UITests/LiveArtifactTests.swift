import XCTest

/// Opens host files a reply links to, against a real server. Skipped unless
/// `SWC_LIVE_LINK` holds a fresh pairing link. The server needs a thread `SWC_LIVE_THREAD`
/// whose reply links `cue-sheet.html`, `notes.md`, `run.txt` and `data.json`.
/// `SWC_SHOT_DIR`, when set, receives each screenshot as a PNG as well.
@MainActor
final class LiveArtifactTests: XCTestCase {
  private var app: XCUIApplication!
  private var shot = 0
  private let env = ProcessInfo.processInfo.environment

  override func setUp() async throws {
    continueAfterFailure = false
    app = XCUIApplication()
    app.launchArguments = ["-SWCAppearance", "light", "-SWCDirectOnly"]
  }

  func testOpenLinkedHostFiles() throws {
    guard let link = env["SWC_LIVE_LINK"], !link.isEmpty else {
      throw XCTSkip("Set SWC_LIVE_LINK to a pairing link to run live tests.")
    }
    let threadName = env["SWC_LIVE_THREAD"] ?? "Make remote coding feel local"
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
    let thread = drawerRow(threadName)
    XCTAssertTrue(thread.waitForExistence(timeout: 30), "Thread missing: \(visibleText())")
    thread.tap()
    _ = waitForDrawerClosed()
    sleep(2)
    capture("thread-reply")

    let cueSheet = app.links["cue-sheet.html"].firstMatch
    XCTAssertTrue(cueSheet.waitForExistence(timeout: 10), "cue-sheet.html is not a link: \(visibleText())")
    cueSheet.tap()
    let viewer = app.descendants(matching: .any)["hostFile.viewer"]
    XCTAssertTrue(viewer.waitForExistence(timeout: 10), "Viewer did not open")
    let page = app.webViews.firstMatch
    XCTAssertTrue(page.waitForExistence(timeout: 15), "No web view")
    XCTAssertTrue(page.staticTexts["Livestream cue sheet"].waitForExistence(timeout: 20), "HTML did not render")
    sleep(2)
    capture("cue-sheet-html")
    closeViewer()

    for name in ["notes.md", "run.txt", "data.json", "chart.svg"] {
      let target = app.links.matching(NSPredicate(format: "label CONTAINS %@", name)).firstMatch
      XCTAssertTrue(target.waitForExistence(timeout: 10), "\(name) is not a link: \(visibleText())")
      target.tap()
      XCTAssertTrue(viewer.waitForExistence(timeout: 10), "Viewer did not open for \(name)")
      let loaded = app.descendants(matching: .any)["hostFile.content"]
      XCTAssertTrue(loaded.waitForExistence(timeout: 20), "\(name) did not load: \(visibleText())")
      sleep(1)
      capture(name)
      closeViewer()
    }
  }

  // MARK: - Helpers

  private func closeViewer() {
    app.buttons["hostFile.close"].firstMatch.tap()
    let viewer = app.descendants(matching: .any)["hostFile.viewer"]
    XCTAssertTrue(viewer.waitForNonExistence(timeout: 5), "Viewer did not close")
  }

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

  private func drawerRow(_ title: String) -> XCUIElement {
    app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", title)).firstMatch
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

  private func waitForDrawerClosed() -> Bool {
    let close = app.descendants(matching: .any)["Close menu"]
    let deadline = Date().addingTimeInterval(5)
    while close.exists, Date() < deadline { usleep(200_000) }
    usleep(500_000)
    return !close.exists
  }

  private func visibleText() -> String {
    app.staticTexts.allElementsBoundByIndex.prefix(40).map { $0.label }.filter { !$0.isEmpty }.joined(separator: " | ")
  }
}
