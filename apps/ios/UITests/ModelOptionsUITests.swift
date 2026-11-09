import XCTest

/// A thread's composer shows its model and options, and changes them as the
/// desktop's options menu does: reasoning, Ultracode, fast mode and access.
@MainActor
final class ModelOptionsUITests: SWCUITestCase {
  func testOptionsMenuTurnsOnUltracodeForTheNextMessage() throws {
    launch(route: "thread", appearance: "dark")
    _ = hittableButton("Approve")  // the transcript has loaded
    let chip = app.buttons["chat.model-options"]
    waitForHittable(chip, "The composer should show the thread's model options")
    XCTAssertTrue(chip.label.contains("Opus 5.5"), "The chip should name the model: \(chip.label)")
    XCTAssertTrue(chip.label.contains("High"), "The chip should show the reasoning effort: \(chip.label)")
    XCTAssertFalse(chip.label.contains("Ultracode"), "Ultracode starts off: \(chip.label)")

    chip.tap()
    settle()
    for name in ["Reasoning", "Context window", "Ultracode", "Fast Mode", "Access"] {
      XCTAssertTrue(element(containing: name).waitForExistence(timeout: timeout), "The menu should offer \(name)")
    }
    attachScreenshot("Model options menu")
    // Held open for a moment so a simulator screenshot can catch the menu.
    if ProcessInfo.processInfo.environment["SWC_HOLD_MENU"] != nil { Thread.sleep(forTimeInterval: 8) }

    let ultracode = app.switches.matching(NSPredicate(format: "label BEGINSWITH 'Ultracode'")).firstMatch.exists
      ? app.switches.matching(NSPredicate(format: "label BEGINSWITH 'Ultracode'")).firstMatch
      : app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Ultracode'")).firstMatch
    tap(ultracode)
    settle()
    XCTAssertTrue(waitUntil { chip.label.contains("Ultracode") }, "The chip should show Ultracode on: \(chip.label)")
    attachScreenshot("Ultracode chosen")
  }

  /// On an unfolded Duo the thread's controls sit at the foot of the status
  /// rail, clear of the system's clock, Wi-Fi and indicators at its top.
  func testDuoRailSitsBelowTheSystemStatusIcons() throws {
    launch(route: "thread", appearance: "dark")
    _ = hittableButton("Approve")
    let rail = app.descendants(matching: .any).matching(identifier: "chat.rail").firstMatch
    guard rail.waitForExistence(timeout: 3) else {
      throw XCTSkip("No status rail on this device: it shows only on an unfolded iPhone Duo")
    }
    let window = app.windows.firstMatch.frame
    XCTAssertGreaterThan(rail.frame.minY, window.height / 2, "The rail should start in the lower half, below the status icons")
    XCTAssertLessThanOrEqual(rail.frame.maxY, window.maxY, "The rail should stay on screen")
    attachScreenshot("Duo status rail")
  }
}
