import XCTest

/// End-to-end checks against a real SpecWithCode server. Skipped unless
/// `SWC_LIVE_LINK` holds a fresh pairing link, for example:
///
///     TEST_RUNNER_SWC_LIVE_LINK='http://127.0.0.1:8431/#token=…' xcodebuild test \
///       -only-testing:SpecWithCodeUITests/LiveServerTests
///
/// The server needs a code project "Live Demo" with a thread "Fix the login form".
/// `testWatchLiveDevice` runs only with `SWC_LIVE_DEVICE=1` and needs a simulator
/// open on the server (`device.open`) for any thread.
/// `testReconnectKeepsPairing` runs only with `SWC_LIVE_RECONNECT=1`; the caller
/// stops the server when the log shows "LIVE wait offline" and starts it again
/// when it shows "LIVE wait online".
@MainActor
final class LiveServerTests: XCTestCase {
  private let machineName = ProcessInfo.processInfo.environment["SWC_LIVE_MACHINE"] ?? "Live Test Mac"
  private let projectName = "Live Demo"
  private let threadName = "Fix the login form"
  private var app: XCUIApplication!
  private var shot = 0

  override func setUp() async throws {
    continueAfterFailure = false
    app = XCUIApplication()
    app.launchArguments = ["-SWCAppearance", "light"]
  }

  // MARK: - Tests

  func testPairAndControlLiveServer() throws {
    let env = ProcessInfo.processInfo.environment
    guard let link = env["SWC_LIVE_LINK"], !link.isEmpty else {
      throw XCTSkip("Set SWC_LIVE_LINK to a pairing link to run live tests.")
    }
    if env["SWC_LIVE_RECONNECT"] == "1" { throw XCTSkip("Reconnect run only.") }
    let stamp = String(Int(Date().timeIntervalSince1970) % 100_000)
    app.launch()

    step("Pair from the welcome screen") {
      let pair = app.buttons["Pair a machine"]
      XCTAssertTrue(pair.waitForExistence(timeout: 20), "Welcome screen did not appear")
      capture("welcome")
      pair.tap()
      let field = app.textFields["Pairing link"]
      XCTAssertTrue(field.waitForExistence(timeout: 5))
      field.tap()
      field.typeText(link)
      capture("pair-link-entered")
      app.buttons["Connect"].tap()
      XCTAssertTrue(field.waitForNonExistence(timeout: 30), "Pairing did not finish: \(errorText())")
      capture("paired")
    }

    step("Machine shows as connected") {
      openDrawer()
      let row = machineRow()
      XCTAssertTrue(row.waitForExistence(timeout: 10), "No machine row")
      XCTAssertTrue(waitForLabel(row, contains: "Online", timeout: 30), "Machine not online: \(row.label)")
      capture("drawer-connected")
    }

    step("Seeded project and thread appear in the drawer") {
      XCTAssertTrue(drawerRow(projectName).waitForExistence(timeout: 20), "Project missing from drawer")
      XCTAssertTrue(drawerRow(threadName).waitForExistence(timeout: 20), "Thread missing from drawer")
      capture("drawer-seeded")
    }

    let message = "Live check \(stamp): list the open threads"
    step("Send a message to the project coordinator") {
      drawerRow(projectName).tap()
      XCTAssertTrue(waitForDrawerClosed())
      let composer = app.textFields["Message"]
      XCTAssertTrue(composer.waitForExistence(timeout: 10))
      XCTAssertTrue(composer.isEnabled, "Composer disabled")
      composer.tap()
      composer.typeText(message)
      app.buttons["Send"].tap()
      let bubble = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", "You: \(message)")).firstMatch
      let refused = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Choose a model for the coordinator")).firstMatch
      let deadline = Date().addingTimeInterval(15)
      while !bubble.exists, !refused.exists, Date() < deadline { usleep(200_000) }
      if refused.exists {
        // A project without a coordinator model: the error shows and the draft comes back.
        capture("coordinator-model-required")
        XCTAssertTrue((composer.value as? String ?? "").contains("Live check"), "Draft not restored")
        XCTContext.runActivity(named: "LIVE coordinator refused: \(refused.label)") { _ in }
        refused.buttons["Dismiss"].firstMatch.tap()
        return
      }
      XCTAssertTrue(bubble.exists, "User message did not show")
      capture("coordinator-sent")
      // No agent runs on the test server, so the coordinator fails or stays queued.
      sleep(12)
      capture("coordinator-after")
      XCTContext.runActivity(named: "LIVE transcript \(transcriptSummary())") { _ in }
    }

    step("Open the seeded thread and pin it") {
      openDrawer()
      drawerRow(threadName).tap()
      XCTAssertTrue(waitForDrawerClosed())
      let actions = app.buttons["Thread actions"]
      XCTAssertTrue(actions.waitForExistence(timeout: 10))
      sleep(2)
      capture("thread-open")
      actions.tap()
      if app.buttons["Unpin"].waitForExistence(timeout: 2) {
        // Pinned by an earlier run: start from unpinned.
        app.buttons["Unpin"].tap()
        sleep(2)
        actions.tap()
      }
      let pin = app.buttons["Pin"]
      XCTAssertTrue(pin.waitForExistence(timeout: 5), "No Pin action")
      capture("thread-menu")
      pin.tap()
      sleep(2)
      actions.tap()
      XCTAssertTrue(app.buttons["Unpin"].waitForExistence(timeout: 10), "Thread did not become pinned")
      capture("thread-pinned-menu")
      dismissMenu()
    }

    let goal = "Ship the login fix \(stamp)"
    step("Edit the project goal") {
      openDrawer()
      drawerRow(projectName).tap()
      XCTAssertTrue(waitForDrawerClosed())
      let capsule = coordinatorCapsule(projectName)
      XCTAssertTrue(capsule.waitForExistence(timeout: 10), "No title capsule")
      capsule.tap()
      let goalField = app.textFields["Goal"]
      XCTAssertTrue(goalField.waitForExistence(timeout: 15), "Settings did not load: \(errorText())")
      capture("project-settings")
      replaceText(in: goalField, with: goal)
      let save = app.buttons["Save"]
      XCTAssertTrue(save.isEnabled)
      save.tap()
      XCTAssertTrue(goalField.waitForNonExistence(timeout: 15), "Settings did not save: \(errorText())")
      capture("project-settings-saved")
      capsule.tap()
      XCTAssertTrue(goalField.waitForExistence(timeout: 15))
      XCTAssertEqual(goalField.value as? String, goal, "Goal not saved")
      capture("project-settings-reloaded")
      app.buttons["Close"].firstMatch.tap()
      XCTAssertTrue(goalField.waitForNonExistence(timeout: 5))
    }

    step("Set up Aide") {
      openDrawer()
      let setUp = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Set up Aide")).firstMatch
      if setUp.waitForExistence(timeout: 5) {
        setUp.tap()
        let aide = coordinatorCapsule("Aide")
        XCTAssertTrue(aide.waitForExistence(timeout: 30), "Aide chat did not open: \(errorText())")
        sleep(2)
        capture("aide-chat")
        openDrawer()
        XCTAssertTrue(drawerRow("Aide").waitForExistence(timeout: 10))
        capture("drawer-with-aide")
      } else {
        XCTContext.runActivity(named: "LIVE Set up Aide not offered") { _ in }
      }
    }

    step("Change the default approval mode") {
      openDrawer()
      app.buttons["Settings"].tap()
      let mode = button(prefix: "Approval mode for new threads")
      XCTAssertTrue(mode.waitForExistence(timeout: 15), "No approval mode control")
      XCTAssertTrue(waitForLabel(mode, contains: ",", timeout: 10))
      capture("settings")
      mode.tap()
      let auto = app.buttons["Auto"]
      XCTAssertTrue(auto.waitForExistence(timeout: 5), "No Auto choice")
      auto.tap()
      XCTAssertTrue(waitForLabel(mode, contains: "Auto", timeout: 15), "Mode did not change: \(mode.label)")
      capture("settings-auto")
    }
  }

  func testReconnectKeepsPairing() throws {
    let env = ProcessInfo.processInfo.environment
    guard env["SWC_LIVE_RECONNECT"] == "1" else {
      throw XCTSkip("Set SWC_LIVE_RECONNECT=1 to run the reconnect check.")
    }
    app.launch()

    step("Already paired and online") {
      openDrawer()
      let row = machineRow()
      XCTAssertTrue(row.waitForExistence(timeout: 20), "Machine not remembered")
      XCTAssertTrue(waitForLabel(row, contains: "Online", timeout: 30), "Not online: \(row.label)")
      drawerRow(threadName).tap()
      XCTAssertTrue(waitForDrawerClosed())
      XCTAssertTrue(app.buttons["Thread actions"].waitForExistence(timeout: 10))
      sleep(2)
      capture("reconnect-before")
    }

    step("Server stops") {
      XCTContext.runActivity(named: "LIVE wait offline") { _ in }
      let offline = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS[c] 'offline' OR label CONTAINS[c] 'reconnecting' OR label CONTAINS[c] 'saved messages'")).firstMatch
      XCTAssertTrue(offline.waitForExistence(timeout: 90), "App did not notice the server stopping")
      capture("reconnect-thread-offline")
      openDrawer()
      let row = machineRow()
      XCTAssertTrue(row.waitForExistence(timeout: 5))
      capture("reconnect-drawer-offline")
      XCTContext.runActivity(named: "LIVE offline label \(row.label)") { _ in }
    }

    step("Server comes back") {
      XCTContext.runActivity(named: "LIVE wait online") { _ in }
      let row = machineRow()
      XCTAssertTrue(waitForLabel(row, contains: "Online", timeout: 120), "Did not reconnect: \(row.label)")
      XCTAssertTrue(drawerRow(projectName).waitForExistence(timeout: 20), "Project gone after reconnect")
      XCTAssertTrue(drawerRow(threadName).waitForExistence(timeout: 20), "Thread gone after reconnect")
      capture("reconnect-drawer-online")
      drawerRow(threadName).tap()
      XCTAssertTrue(waitForDrawerClosed())
      XCTAssertTrue(app.buttons["Thread actions"].waitForExistence(timeout: 10))
      app.buttons["Thread actions"].tap()
      XCTAssertTrue(app.buttons["Unpin"].waitForExistence(timeout: 10), "Pin state lost after reconnect")
      dismissMenu()
      XCTAssertFalse(app.buttons["Pair a machine"].exists, "Asked to pair again")
      sleep(2)
      capture("reconnect-thread-online")
    }
  }

  func testWatchLiveDevice() throws {
    let env = ProcessInfo.processInfo.environment
    guard let link = env["SWC_LIVE_LINK"], !link.isEmpty, env["SWC_LIVE_DEVICE"] == "1" else {
      throw XCTSkip("Set SWC_LIVE_LINK and SWC_LIVE_DEVICE=1 with a simulator open on the server.")
    }
    app.launch()

    step("Pair from the welcome screen") {
      let pair = app.buttons["Pair a machine"]
      XCTAssertTrue(pair.waitForExistence(timeout: 20), "Welcome screen did not appear")
      pair.tap()
      let field = app.textFields["Pairing link"]
      XCTAssertTrue(field.waitForExistence(timeout: 5))
      field.tap()
      field.typeText(link)
      app.buttons["Connect"].tap()
      XCTAssertTrue(field.waitForNonExistence(timeout: 30), "Pairing did not finish: \(errorText())")
    }

    step("The machine lists its open device") {
      openDrawer()
      let row = machineRow()
      XCTAssertTrue(row.waitForExistence(timeout: 10), "No machine row")
      XCTAssertTrue(waitForLabel(row, contains: "Online", timeout: 30), "Machine not online: \(row.label)")
      row.tap()
      let device = app.buttons.matching(identifier: "machine.device").firstMatch
      XCTAssertTrue(device.waitForExistence(timeout: 30), "No open device on the machine: \(errorText())")
      sleep(1)
      capture("machine-devices")
      device.tap()
    }

    step("The viewer streams the device") {
      XCTAssertTrue(app.buttons["device.close"].waitForExistence(timeout: 10), "Viewer did not open")
      capture("viewer-connecting")
      let connecting = app.staticTexts["Connecting to device…"]
      let failed = app.buttons["device.reconnect"]
      let deadline = Date().addingTimeInterval(60)
      while connecting.exists || !app.buttons["device.home"].isEnabled, !failed.exists, Date() < deadline { usleep(250_000) }
      XCTAssertFalse(failed.exists, "Stream failed: \(errorText())")
      XCTAssertFalse(connecting.exists, "Stream did not start")
      XCTAssertTrue(app.buttons["device.home"].isEnabled, "Device input did not connect")
      sleep(2)
      capture("viewer-streaming")
    }

    step("The bar hides itself once the device streams") {
      let show = app.buttons["device.showControls"]
      XCTAssertTrue(show.waitForExistence(timeout: 10), "Controls did not hide")
      capture("viewer-controls-hidden")
    }

    step("Touches and Home reach the device") {
      // Settings sits at the end of the second icon row on a fresh simulator's home screen.
      app.coordinate(withNormalizedOffset: CGVector(dx: 0.845, dy: 0.49)).tap()
      sleep(3)
      capture("viewer-after-tap")
      app.buttons["device.showControls"].tap()
      XCTAssertTrue(app.buttons["device.home"].waitForExistence(timeout: 5))
      app.buttons["device.home"].tap()
      sleep(3)
      capture("viewer-after-home")
    }

    step("The menu reaches the device") {
      let more = app.buttons["device.more"]
      XCTAssertTrue(more.waitForExistence(timeout: 5))
      more.tap()
      XCTAssertTrue(app.buttons["Rotate"].waitForExistence(timeout: 5), "No Rotate in the menu")
      capture("viewer-menu")
      app.buttons["Rotate"].tap()
      sleep(3)
      capture("viewer-rotated")
      more.tap()
      XCTAssertTrue(app.buttons["Rotate"].waitForExistence(timeout: 5))
      app.buttons["Rotate"].tap()
      sleep(2)
    }

    step("Closing returns to the machine") {
      if !app.buttons["device.close"].exists { app.buttons["device.showControls"].tap() }
      app.buttons["device.close"].tap()
      XCTAssertTrue(app.buttons["device.close"].waitForNonExistence(timeout: 5), "Viewer did not close")
      XCTAssertTrue(app.buttons.matching(identifier: "machine.device").firstMatch.waitForExistence(timeout: 5))
      capture("viewer-closed")
    }
  }

  // MARK: - Helpers

  private func step(_ name: String, _ body: () -> Void) {
    XCTContext.runActivity(named: name) { _ in body() }
  }

  private func capture(_ name: String) {
    shot += 1
    let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
    attachment.name = String(format: "%02d-%@", shot, name)
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  private func button(prefix: String) -> XCUIElement {
    app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", prefix)).firstMatch
  }

  /// A drawer row, labelled with its title; status is spoken as its value.
  private func drawerRow(_ title: String) -> XCUIElement {
    app.buttons.matching(NSPredicate(format: "label == %@", title)).firstMatch
  }

  /// The drawer's machine row, e.g. "Live Test Mac, Online". The thread
  /// header's machine button reads the same, so match the row's identifier.
  private func machineRow() -> XCUIElement {
    app.buttons.matching(identifier: "drawer.machine").firstMatch
  }

  /// The title capsule of a project or Aide chat.
  private func coordinatorCapsule(_ title: String) -> XCUIElement {
    app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@ AND label CONTAINS %@", title, "Coordinator ·")).firstMatch
  }

  private func openDrawer() {
    let close = app.descendants(matching: .any)["Close menu"]
    if close.exists { return }
    let menu = app.buttons["Menu"].firstMatch
    if !menu.waitForExistence(timeout: 5) {
      // A pushed screen shows Back instead of Menu.
      let back = app.buttons["Back"].firstMatch
      if back.exists { back.tap() }
    }
    XCTAssertTrue(menu.waitForExistence(timeout: 5), "No menu button")
    menu.tap()
    XCTAssertTrue(close.waitForExistence(timeout: 5), "Drawer did not open")
    sleep(1)
  }

  private func waitForDrawerClosed() -> Bool {
    let close = app.descendants(matching: .any)["Close menu"]
    let deadline = Date().addingTimeInterval(5)
    while close.exists, Date() < deadline { usleep(200_000) }
    usleep(500_000)
    return !close.exists
  }

  private func dismissMenu() {
    // Tap empty transcript space left of the menu.
    app.coordinate(withNormalizedOffset: CGVector(dx: 0.08, dy: 0.42)).tap()
    let region = app.otherElements["PopoverDismissRegion"].firstMatch
    let deadline = Date().addingTimeInterval(3)
    while region.exists, Date() < deadline { usleep(200_000) }
    usleep(500_000)
  }

  /// Puts the cursor after the current text, deletes it and types `text`.
  private func replaceText(in field: XCUIElement, with text: String) {
    field.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: 0.85)).tap()
    let current = field.value as? String ?? ""
    let length = current == field.placeholderValue ? 0 : current.count
    if length > 0 {
      field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: length + 4))
    }
    XCTAssertEqual(field.value as? String ?? "", field.placeholderValue ?? "", "Field not cleared")
    field.typeText(text)
  }

  private func waitForLabel(_ element: XCUIElement, contains text: String, timeout: TimeInterval) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    repeat {
      if element.exists, element.label.contains(text) { return true }
      usleep(250_000)
    } while Date() < deadline
    return false
  }

  /// Visible error text, for failure messages.
  private func errorText() -> String {
    let texts = app.staticTexts.allElementsBoundByIndex.prefix(40).map { $0.label }.filter { !$0.isEmpty }
    return texts.joined(separator: " | ")
  }

  private func transcriptSummary() -> String {
    app.staticTexts.allElementsBoundByIndex.prefix(30).map { $0.label }.filter { !$0.isEmpty }.joined(separator: " | ")
  }
}
