import XCTest

/// Real native app on fixture data. iPad runs are expanded-layout surrogates;
/// only the Duo runtime can validate actual fold/pose behavior.
@MainActor
final class AdaptiveLayoutUITests: SWCUITestCase {
  override func setUp() async throws {
    try await super.setUp()
    XCUIDevice.shared.orientation = .portrait
  }

  override func tearDown() async throws {
    XCUIDevice.shared.orientation = .portrait
    try await super.tearDown()
  }

  func testNavigationAndComposerRemainUsableTogetherWhenExpanded() throws {
    launch()
    waitForHittable(field("Message"))
    let search = button("Search projects and threads")
    // Wide outer-display landscape can still have compact traits. The native
    // component tests enforce the trait/width policy; verify each visible mode here.
    if !button("Menu").exists {
      XCTAssertGreaterThanOrEqual(app.frame.width, 600)
      waitForHittable(search)
      waitForHittable(field("Message"))
      XCTAssertFalse(button("Close menu").exists)
      let input = field("Message").frame
      XCTAssertGreaterThan(input.minX, search.frame.minX, "Expanded navigation must sit beside the composer")
      tap(hittableButton(titled("Recipe app")))
      waitForHittable(button(startingWith: "Recipe app, Coordinator"))
      waitForHittable(search)
      waitForHittable(field("Message"))
    } else {
      XCTAssertFalse(search.exists)
      openDrawer()
      XCTAssertFalse(field("Message").exists)
      tap(button("Close menu"))
      waitForGone(button("Close menu"))
      waitForHittable(field("Message"))
    }
    attachScreenshot("Adaptive navigation")
  }

  func testBothLandscapeRotationsPreserveDraftAndSelectedChat() throws {
    launch(route: "thread")
    let input = field("Message")
    waitForHittable(input)
    tap(input)
    input.typeText("Unsent resizing draft")
    let originalPortrait = app.frame.size
    attachScreenshot("Portrait keyboard and draft")

    for orientation in [UIDeviceOrientation.landscapeLeft, .landscapeRight, .portrait] {
      XCUIDevice.shared.orientation = orientation
      if orientation != .portrait {
        XCTAssertTrue(waitUntil { self.app.frame.width > self.app.frame.height }, "App did not rotate into landscape")
      }
      waitForHittable(input)
      XCTAssertEqual(input.value as? String, "Unsent resizing draft")
      let bounds = app.frame
      XCTAssertGreaterThanOrEqual(input.frame.minX, bounds.minX)
      XCTAssertLessThanOrEqual(input.frame.maxX, bounds.maxX + 1)
      XCTAssertLessThanOrEqual(input.frame.maxY, bounds.maxY + 1)
      XCTAssertFalse(button("Close menu").exists)
      attachScreenshot("Draft orientation \(orientation.rawValue)")
    }
    XCTAssertTrue(waitUntil { abs(self.app.frame.width - originalPortrait.width) < 2 })
  }

  func testLargeTextAndReduceMotionKeepNavigationReachable() throws {
    // Standard launch arguments reach SwiftUI through the system preferences.
    app = XCUIApplication()
    app.launchArguments = ["-SWCFixture", "default", "-SWCAppearance", "dark",
                           "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL",
                           "-UIAccessibilityReduceMotionEnabled", "YES"]
    app.launch()
    waitForHittable(field("Message"))
    if button("Menu").exists { openDrawer() }
    waitForHittable(button("Search projects and threads"))
    attachScreenshot("Dark accessibility navigation")
  }
}
