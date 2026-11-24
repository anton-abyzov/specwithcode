import XCTest

/// The "Allow a device" card on a machine's page, against the fixture engine.
final class AllowDeviceUITests: SWCUITestCase {
  private let codeLabel = "Code shown on the other device"

  private func saveShot(_ name: String) {
    settle()
    attachScreenshot(name)
    guard let dir = ProcessInfo.processInfo.environment["SWC_SHOTS_DIR"] else { return }
    try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
  }

  private func openMachine(_ name: String, fixture: String = "allow-device") {
    launch(fixture: fixture, route: "machines")
    tap(button(startingWith: name))
  }

  private func enter(_ typed: String) {
    let input = field(codeLabel)
    waitForHittable(input)
    tap(input)
    let current = input.value as? String ?? ""
    if !current.isEmpty, current != "6-character code" {
      input.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count))
    }
    input.typeText(typed)
  }

  private func allow() {
    tap(hittableButton("Allow"))
  }

  func testAllowDeviceWalksEveryAnswer() {
    openMachine("Office Mac")
    waitFor(element(containing: "Spare iPad"))
    waitFor(element(containing: "Work laptop"))
    XCTAssertFalse(button("Allow").isEnabled, "Allow waits for six characters")
    saveShot("allow-device-list")

    enter("wr-ong 1")
    XCTAssertEqual(field(codeLabel).value as? String, "WRONG1", "The box uppercases and drops spaces and dashes")
    allow()
    waitFor(element(containing: "doesn't match"))
    saveShot("allow-device-wrong-code")

    enter("PAUSE1")
    allow()
    waitFor(element(containing: "Too many wrong codes"))

    enter("SELF12")
    allow()
    waitFor(element(containing: "this phone's own code"))

    enter("ABC234")
    allow()
    waitFor(element(containing: "Allowed Spare iPad · K3PX"))
    XCTAssertFalse(element(containing: "ABC234").exists, "The code leaves the screen once used")
    saveShot("allow-device-allowed")

    enter("XPIRE1")
    allow()
    waitFor(element(containing: "That request expired"))
    waitFor(element(containing: "No device is waiting"))
    saveShot("allow-device-expired")
  }

  func testAMachineThatGoesOfflineDisablesTheBox() {
    openMachine("Office Mac")
    waitFor(element(containing: "Spare iPad"))
    enter("NOLINE")
    allow()
    waitFor(element(containing: "Reconnect to Office Mac"))
    XCTAssertFalse(field(codeLabel).isEnabled)
    saveShot("allow-device-offline")
  }

  func testAnOlderServerShowsNothingNew() {
    openMachine("Build box")
    waitFor(element(containing: "Details"))
    settle(1.5)
    XCTAssertFalse(element(containing: "Allow a device").exists)
    XCTAssertFalse(field(codeLabel).exists)
    saveShot("allow-device-older-server")
  }

  func testAPhoneThatIsWaitingShowsNothingNew() {
    launch(fixture: "approval", route: "machines")
    // The fixture has this phone waiting on the build box.
    // The band above lists the same machine with its code, so match the row.
    tap(hittableButton(NSPredicate(format: "label BEGINSWITH %@", "Build box, Waiting")))
    waitFor(element(containing: "Details"))
    settle(1.5)
    XCTAssertFalse(element(containing: "Allow a device").exists)
    XCTAssertFalse(field(codeLabel).exists)
    saveShot("allow-device-waiting-phone")
  }
}
