import XCTest

@MainActor
final class ThreadUITests: SWCUITestCase {
  func testApproveResolvesTheApprovalCard() throws {
    launch(route: "thread")
    let approve = hittableButton("Approve")
    XCTAssertTrue(button(startingWith: "Release 3.1 checklist").exists, "The thread route should open the waiting thread")
    attachScreenshot("Approval pending")

    approve.tap()
    waitForGone(button("Approve"), "Approve should resolve the card")
    XCTAssertFalse(button("Deny").exists)
    waitFor(app.staticTexts["Answered"], "The resolved card should say it was answered")
    waitFor(element(containing: "Published"), "The run should continue with a reply")
    attachScreenshot("Approval resolved")
  }

  func testSendingAddsTheMessageAndAReply() throws {
    launch(route: "thread")
    _ = hittableButton("Approve")
    let message = "Run the smoke tests again"

    tap(composer)
    composer.typeText(message)
    let send = hittableButton("Send")
    XCTAssertTrue(send.isEnabled, "Send should enable once there is text")
    send.tap()

    waitFor(element(containing: "You: \(message)"), "The sent message should appear")
    waitFor(element(containing: "fold that into the current work"), "A reply should stream in")
    XCTAssertEqual(composer.value as? String ?? "", composer.placeholderValue ?? "", "The composer should be empty after sending")
    attachScreenshot("Message sent")
  }

  func testRunningThreadQueuesAndStops() throws {
    launch(fixture: "running", route: "thread")
    let stop = hittableButton("Stop")
    waitFor(composer)
    XCTAssertEqual(composer.placeholderValue, "Queue a message…")
    attachScreenshot("Running")

    stop.tap()
    waitForGone(button("Stop"), "Stop should end the run")
    waitFor(element(containing: "Stopped"), "A stop notice should appear")
    XCTAssertTrue(waitUntil { self.composer.placeholderValue == "Message…" }, "The composer should leave queue mode: \(composer.placeholderValue ?? "nil")")
    XCTAssertTrue(button("Send").exists)
    attachScreenshot("Stopped")
  }
}
