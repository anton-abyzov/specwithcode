import XCTest

@MainActor
final class OfflineRecoveryUITests: SWCUITestCase {
  private func assertWithinPhone(_ element: XCUIElement, file: StaticString = #filePath, line: UInt = #line) {
    waitFor(element, file: file, line: line)
    XCTAssertGreaterThanOrEqual(element.frame.minX, app.frame.minX - 1, file: file, line: line)
    XCTAssertLessThanOrEqual(element.frame.maxX, app.frame.maxX + 1, file: file, line: line)
  }

  private func scrollTo(_ element: XCUIElement) {
    for _ in 0..<8 {
      if element.exists {
        let center = element.frame.midY
        if element.isHittable && center > 160 && center < app.frame.maxY - 120 { return }
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        let dy: CGFloat = center < 160 ? 0.75 : 0.25
        start.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: dy)))
      } else {
        app.swipeUp()
      }
    }
    waitForHittable(element)
  }

  func testColdOfflineChatWrapsAndOffersDisconnectAndPairAgain() throws {
    launch(fixture: "offline-recovery")
    let title = text(startingWith: "MacBook Pro M1Max")
    assertWithinPhone(title)
    assertWithinPhone(button("Menu"))
    let connect = button("SpecWithCode Connect")
    waitForHittable(connect)
    tap(connect)
    waitForHittable(button("Sign in with Apple"))
    tap(button("Close"))
    let options = app.buttons["chat.connection-options"]
    waitForHittable(options)
    assertWithinPhone(options)
    attachScreenshot("Offline chat fits phone")
    tap(options)
    let account = app.buttons["machine.connect"]
    waitForHittable(account)
    XCTAssertLessThan(account.frame.minY, button("Reconnect").frame.minY)
    tap(account)
    waitForHittable(button("Sign in with Apple"))
    tap(button("Close"))
    tap(button("Reconnect"))
    // This fixture keeps the host offline; a retry must leave recovery usable.
    let disconnect = app.buttons["machine.disconnect"]
    scrollTo(disconnect)
    tap(disconnect)
    waitForGone(disconnect, "Disconnect must pause the connection")
    scrollTo(app.buttons["machine.pair-again"])
    tap(app.buttons["machine.pair-again"])
    waitForHittable(field("Pairing link"))
    attachScreenshot("Pair again reachable while disconnected")
  }

  func testDisconnectAndReconnectPreserveDraft() throws {
    launch(route: "thread")
    let input = field("Message")
    tap(input)
    input.typeText("Unsent outage draft")
    waitForHittable(input)
    XCTAssertLessThanOrEqual(input.frame.maxY, app.keyboards.firstMatch.frame.minY)
    // The machine status button remains available while a chat is connected.
    let machine = app.buttons["chat.machine"]
    tap(machine)
    let disconnect = app.buttons["machine.disconnect"]
    scrollTo(disconnect)
    tap(disconnect)
    tap(button("Back"))
    // Saved chats must offer a working route back to recovery after pausing.
    tap(app.buttons["chat.connection-options"])
    scrollTo(button("Reconnect"))
    tap(button("Reconnect"))
    tap(button("Back"))
    waitForHittable(input)
    XCTAssertEqual(input.value as? String, "Unsent outage draft")
    tap(input)
    input.typeText(" kept")
    XCTAssertEqual(input.value as? String, "Unsent outage draft kept")
    XCTAssertLessThanOrEqual(input.frame.maxY, app.keyboards.firstMatch.frame.minY)
    attachScreenshot("Draft after disconnect and reconnect")
  }

  func testLargeTextOfflineRecoveryStaysInsidePhone() throws {
    app = XCUIApplication()
    app.launchArguments = ["-SWCFixture", "offline-recovery", "-SWCAppearance", "dark",
      "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]
    app.launch()
    assertWithinPhone(text(startingWith: "MacBook Pro M1Max"))
    assertWithinPhone(button("Menu"))
    let options = app.buttons["chat.connection-options"]
    waitForHittable(options)
    assertWithinPhone(options)
    tap(options)
    scrollTo(app.buttons["machine.disconnect"])
    assertWithinPhone(app.buttons["machine.disconnect"])
    attachScreenshot("Large text machine controls")
  }

  func testConnectIsPrimaryBeforeAnyCachedChatLoads() {
    launch(fixture: "offline-startup")
    let connect = button("SpecWithCode Connect")
    waitForHittable(connect)
    XCTAssertLessThan(connect.frame.minY, button("Reconnect").frame.minY)
    tap(connect)
    waitForHittable(button("Sign in with Apple"))
    attachScreenshot("Connect recovery before chats load")
  }
}
