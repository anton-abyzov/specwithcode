import XCTest

@MainActor
final class HandoffUncertaintyUITests: SWCUITestCase {
  func testUnreachableTransferKeepsErrorAndOffersOnlyStatusRefresh() throws {
    app = XCUIApplication()
    app.launchArguments = ["-SWCFixture", "fleet", "-SWCAppearance", "light", "-SWCHandoffUncertain"]
    app.launch()
    waitForHome()
    app.open(try XCTUnwrap(URL(string: "specwithcode://thread/env-m4/f-phone")))
    tap(button("Thread actions"))
    tap(app.buttons["thread.handoff"])
    tap(button("Check Minis"))
    tap(app.buttons["handoff.continue"])
    waitFor(element(containing: "Handoff in doubt"))
    waitFor(element(containing: "Sample: Minis did not answer…"))
    XCTAssertFalse(app.buttons["handoff.continue"].exists)
    XCTAssertFalse(button("Check Minis").exists)
    attachScreenshot("Unreachable handoff remains uncertain with exact error")
    tap(button("Refresh status"))
    waitFor(element(containing: "Sample: Minis did not answer…"))
    XCTAssertFalse(app.buttons["handoff.continue"].exists)
    XCTAssertFalse(app.buttons["handoff.open"].exists)
  }
}
