import XCTest

/// A build with no Connect settings still offers sign-in: the screen the owner's Duo
/// showed had only "Pair a machine". Needs network, since it starts a real Google flow.
@MainActor
final class ConnectSignInUITests: XCTestCase {
  func testAnUnconfiguredBuildOffersGoogleSignIn() throws {
    guard ProcessInfo.processInfo.environment["SWC_LIVE_SIGN_IN"] == "1" else {
      throw XCTSkip("Set SWC_LIVE_SIGN_IN=1 on a fresh install of a build with no Connect settings.")
    }
    continueAfterFailure = false
    let app = XCUIApplication()
    app.launchArguments = ["-SWCAppearance", "light"]
    app.launch()
    let google = app.buttons["Continue with Google"]
    XCTAssertTrue(google.waitForExistence(timeout: 30), "No sign-in on the first screen")
    XCTAssertFalse(app.buttons["Sign in with Apple"].exists, "This build has no Sign in with Apple entitlement")
    XCTAssertFalse(app.buttons["Pair a machine"].exists, "Pairing must not be the only way in")
    XCTAssertTrue(app.buttons["Pair with a link or QR code"].exists)
    capture("welcome-offers-google")

    google.tap()
    let system = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    let allow = system.buttons["Continue"]
    if allow.waitForExistence(timeout: 15) { capture("system-sign-in-prompt"); allow.tap() }
    sleep(8)
    capture("google-page")
    let refused = app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] %@", "redirect")).firstMatch
    XCTAssertFalse(refused.exists, "The account refused this build's sign-in: \(refused.label)")
  }

  private func capture(_ name: String) {
    let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }
}
