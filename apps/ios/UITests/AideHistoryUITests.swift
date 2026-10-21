import XCTest

/// Long Aide history, links, deep links and background/foreground, on the
/// `long` fixture. These replace checks that used to need the phone.
@MainActor
final class AideHistoryUITests: SWCUITestCase {
  private var latest: XCUIElement { element(containing: "Check-in 60: two threads moved forward") }
  private var oldest: XCUIElement { element(containing: "Start of history") }

  func testLongHistoryScrollsToTheStartAndBack() throws {
    launch(fixture: "long")
    waitForHome()
    waitFor(latest, "The chat should open at the newest message")
    XCTAssertFalse(oldest.exists && oldest.isHittable, "The oldest message should start off screen")

    XCTAssertTrue(swipe(.down, until: { self.oldest.exists && self.oldest.isHittable }), "Swiping down should reach the oldest message")
    attachScreenshot("Start of history")

    tap(button("Scroll to latest"))
    XCTAssertTrue(waitUntil { self.latest.exists && self.latest.isHittable }, "Scroll to latest should bring the newest message back")
    waitForGone(button("Scroll to latest"), "The button should hide at the bottom")
    attachScreenshot("Back at the latest message")
  }

  func testLinkInAReplyOpensOutsideTheAppAndTheChatSurvives() throws {
    launch(fixture: "long")
    waitForHome()
    waitFor(latest)
    // Older replies carry the same link off screen, so take the visible one.
    var link: XCUIElement?
    XCTAssertTrue(waitUntil {
      link = self.app.links.matching(identifier: "https://spec-weave.com/docs/whats-new").allElementsBoundByIndex.last { $0.isHittable }
      return link != nil
    }, "The newest reply should show its link as a link")
    let visibleLink = try XCTUnwrap(link)
    attachScreenshot("Reply with a link")

    visibleLink.tap()
    XCTAssertTrue(app.wait(for: .runningBackground, timeout: timeout), "A web link should open outside the app")

    app.activate()
    XCTAssertTrue(app.wait(for: .runningForeground, timeout: timeout))
    waitFor(latest, "The chat should still be there after coming back")
    attachScreenshot("Back from the link")
  }

  func testThreadDeepLinkOpensTheThread() throws {
    launch(fixture: "long")
    waitForHome()
    app.open(try XCTUnwrap(URL(string: "specwithcode://thread/env-studio-mac/t-release")))
    waitForHittable(button(startingWith: "Release 3.1 checklist"), "The link should open the release thread")
    waitFor(button("Approve"))
    attachScreenshot("Opened from a link")
  }

  func testDraftSurvivesGoingToTheBackground() throws {
    launch(fixture: "long")
    waitForHome()
    let draft = "Draft kept across the home screen"
    tap(composer)
    composer.typeText(draft)

    XCUIDevice.shared.press(.home)
    XCTAssertTrue(app.wait(for: .runningBackground, timeout: timeout))
    app.activate()
    XCTAssertTrue(app.wait(for: .runningForeground, timeout: timeout))

    waitFor(composer)
    XCTAssertEqual(composer.value as? String, draft, "The unsent draft should still be in the composer")
    attachScreenshot("Draft after coming back")
  }

  // MARK: Helpers

  private enum Direction { case up, down }

  /// Swipes the transcript until `done` holds, at most `limit` times.
  private func swipe(_ direction: Direction, limit: Int = 60, until done: () -> Bool) -> Bool {
    for _ in 0..<limit {
      if done() { return true }
      let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: direction == .down ? 0.3 : 0.7))
      let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: direction == .down ? 0.8 : 0.2))
      start.press(forDuration: 0.05, thenDragTo: end)
    }
    return done()
  }
}
