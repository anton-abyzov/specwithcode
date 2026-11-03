import XCTest

/// The composer's text line is shorter than 44 pt, so the whole capsule acts
/// as its touch target. This proves a tap outside the text line still focuses it.
@MainActor
final class ComposerUITests: SWCUITestCase {
  func testTapOnCapsuleEdgeFocusesTheField() {
    launch()
    waitForHome()
    let capsule = app.otherElements.matching(identifier: "composer").firstMatch
    XCTAssertTrue(capsule.waitForExistence(timeout: timeout), "Composer capsule not found")
    let field = composer
    XCTAssertTrue(field.waitForExistence(timeout: timeout), "Composer field not found")

    let outer = capsule.frame
    let inner = field.frame
    XCTAssertGreaterThanOrEqual(outer.height, 44, "Composer capsule is shorter than 44 pt")
    XCTAssertGreaterThan(inner.minY - outer.minY, 6, "No room above the text line to tap")

    // A point inside the capsule, above the text line, horizontally over the field.
    let point = CGPoint(x: inner.midX - outer.minX, y: (inner.minY - outer.minY) / 2)
    capsule.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: point.x, dy: point.y)).tap()

    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: timeout), "Keyboard did not appear")
    app.typeText("Hello")
    XCTAssertEqual(field.value as? String, "Hello")
  }

  /// Attach opens its choices without the keyboard, and a tap on the
  /// conversation puts a raised keyboard away.
  func testAttachLeavesTheKeyboardDownAndATapOnTheChatHidesIt() {
    launch()
    waitForHome()
    let field = composer
    XCTAssertTrue(field.waitForExistence(timeout: timeout), "Composer field not found")
    tap(button("Attach"))
    settle()
    XCTAssertFalse(app.keyboards.firstMatch.exists, "Attach raised the keyboard")
    attachScreenshot("Attach choices")
    if app.buttons["Cancel"].exists { app.buttons["Cancel"].tap() } else { app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.15)).tap() }
    settle()

    tap(field)
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: timeout), "Keyboard did not appear")
    let capsule = app.otherElements.matching(identifier: "composer").firstMatch
    // A point in the conversation, above the composer.
    capsule.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0)).withOffset(CGVector(dx: 0, dy: -120)).tap()
    waitForGone(app.keyboards.firstMatch, "A tap on the chat should hide the keyboard")
  }
}
