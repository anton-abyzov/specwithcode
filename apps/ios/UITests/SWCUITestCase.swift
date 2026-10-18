import XCTest

/// Shared launch and lookup helpers. Every test runs the app on fixture data.
@MainActor
class SWCUITestCase: XCTestCase {
  var app: XCUIApplication!

  /// Long enough for fixture latency, streamed replies and sheet animations.
  let timeout: TimeInterval = 10

  override func setUp() async throws {
    continueAfterFailure = false
  }

  override func tearDown() async throws {
    app?.terminate()
    app = nil
  }

  @discardableResult
  func launch(fixture: String = "default", route: String? = nil, appearance: String = "light") -> XCUIApplication {
    app?.terminate()
    let app = XCUIApplication()
    var arguments = ["-SWCFixture", fixture, "-SWCAppearance", appearance]
    if let route { arguments += ["-SWCRoute", route] }
    app.launchArguments = arguments
    app.launch()
    self.app = app
    return app
  }

  // MARK: Lookup

  /// A button whose label is exactly `label`.
  func button(_ label: String) -> XCUIElement {
    app.buttons.matching(NSPredicate(format: "label == %@", label)).firstMatch
  }

  /// A button whose label starts with `prefix`, such as a row with a subtitle.
  func button(startingWith prefix: String) -> XCUIElement {
    app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", prefix)).firstMatch
  }

  /// Any element whose label contains `text`.
  func element(containing text: String) -> XCUIElement {
    app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
  }

  /// A static text whose label starts with `prefix`, such as "Working, 2".
  func text(startingWith prefix: String) -> XCUIElement {
    app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", prefix)).firstMatch
  }

  /// A labeled text input. Multiline fields show up as text fields or text views.
  func field(_ label: String) -> XCUIElement {
    let predicate = NSPredicate(format: "label == %@", label)
    let textField = app.textFields.matching(predicate).firstMatch
    if textField.exists { return textField }
    let textView = app.textViews.matching(predicate).firstMatch
    return textView.exists ? textView : textField
  }

  /// The composer's text input.
  var composer: XCUIElement { field("Message") }

  /// Matches a row titled `title`, alone or followed by more spoken parts.
  func titled(_ title: String) -> NSPredicate {
    NSPredicate(format: "label == %@ OR label BEGINSWITH %@", title, "\(title),")
  }

  /// The first hittable button matching `predicate`. Screens under a sheet or
  /// the drawer stay in the tree, so plain lookups can find a covered copy.
  func hittableButton(_ predicate: NSPredicate, file: StaticString = #filePath, line: UInt = #line) -> XCUIElement {
    let query = app.buttons.matching(predicate)
    var found: XCUIElement?
    waitUntil {
      found = query.allElementsBoundByIndex.first { $0.exists && $0.isHittable }
      return found != nil
    }
    guard let found else {
      XCTFail("No hittable button matches \(predicate)", file: file, line: line)
      return query.firstMatch
    }
    return found
  }

  func hittableButton(_ label: String, file: StaticString = #filePath, line: UInt = #line) -> XCUIElement {
    hittableButton(NSPredicate(format: "label == %@", label), file: file, line: line)
  }

  // MARK: Waiting

  func waitFor(_ element: XCUIElement, _ message: String = "", file: StaticString = #filePath, line: UInt = #line) {
    // waitForExistence polls once a second, so check first.
    if element.exists { return }
    XCTAssertTrue(element.waitForExistence(timeout: timeout), message.isEmpty ? "Missing \(element)" : message, file: file, line: line)
  }

  func waitForHittable(_ element: XCUIElement, _ message: String = "", file: StaticString = #filePath, line: UInt = #line) {
    waitFor(element, message, file: file, line: line)
    XCTAssertTrue(waitUntil { element.isHittable }, message.isEmpty ? "Not hittable: \(element)" : message, file: file, line: line)
  }

  func waitForGone(_ element: XCUIElement, _ message: String = "", file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertTrue(element.waitForNonExistence(timeout: timeout), message.isEmpty ? "Still present: \(element)" : message, file: file, line: line)
  }

  /// Polls `condition` until it holds or the timeout passes.
  @discardableResult
  func waitUntil(timeout: TimeInterval? = nil, _ condition: () -> Bool) -> Bool {
    let deadline = Date().addingTimeInterval(timeout ?? self.timeout)
    while Date() < deadline {
      if condition() { return true }
      RunLoop.current.run(until: Date().addingTimeInterval(0.2))
    }
    return condition()
  }

  /// Lets animations finish before reading frames or taking a screenshot.
  func settle(_ seconds: TimeInterval = 0.8) {
    RunLoop.current.run(until: Date().addingTimeInterval(seconds))
  }

  /// Waits for a tap target, then taps it.
  func tap(_ element: XCUIElement, file: StaticString = #filePath, line: UInt = #line) {
    waitForHittable(element, file: file, line: line)
    element.tap()
  }

  // MARK: Navigation

  /// Waits for the root chat after launch.
  func waitForHome(file: StaticString = #filePath, line: UInt = #line) {
    waitForHittable(button("Menu"), "The root chat did not load", file: file, line: line)
  }

  /// Opens the drawer from the menu button of the root chat.
  func openDrawer(file: StaticString = #filePath, line: UInt = #line) {
    tap(button("Menu"), file: file, line: line)
    waitFor(button("Close menu"), "The drawer did not open", file: file, line: line)
    _ = hittableButton(titled("Aide"), file: file, line: line)
    settle(0.4)
  }

  /// Opens a project's coordinator chat from the drawer.
  func openProject(_ title: String, file: StaticString = #filePath, line: UInt = #line) {
    openDrawer(file: file, line: line)
    hittableButton(titled(title), file: file, line: line).tap()
    waitForHittable(button(startingWith: "\(title), Coordinator"), "The \(title) chat did not open", file: file, line: line)
    // Taps land in the wrong place while the drawer is still sliding shut.
    waitForGone(button("Close menu"), file: file, line: line)
    settle(0.4)
  }

  /// Opens the thread menu in a thread's header.
  func openThreadMenu(file: StaticString = #filePath, line: UInt = #line) {
    tap(button("Thread actions"), file: file, line: line)
    waitForHittable(button("Rename…"), "The thread menu did not open", file: file, line: line)
  }

  /// Closes an open menu by tapping outside it.
  func dismissMenu() {
    app.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.55)).tap()
    _ = button("Rename…").waitForNonExistence(timeout: timeout)
  }

  // MARK: Evidence

  func attachScreenshot(_ name: String) {
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }
}
