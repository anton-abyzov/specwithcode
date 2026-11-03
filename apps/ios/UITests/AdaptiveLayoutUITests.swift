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
      XCTAssertGreaterThanOrEqual(max(app.frame.width, app.frame.height), 760)
      waitForHittable(search)
      waitForHittable(field("Message"))
      XCTAssertFalse(button("Close menu").exists)
      let input = field("Message").frame
      XCTAssertGreaterThan(input.minX, search.frame.minX, "Expanded navigation must sit beside the composer")
      // A machine chip leaves every project reachable.
      tap(button(startingWith: "Office Mac"))
      waitForHittable(button(startingWith: "Recipe app"))
      tap(button("All"))
      // A project row goes down a level in the column; its first row opens the coordinator.
      tap(button(startingWith: "Recipe app"))
      waitForHittable(app.buttons["sidebar.all-projects"])
      let recipe = app.cells.containing(titled("Recipe app")).firstMatch.exists
        ? app.cells.containing(titled("Recipe app")).firstMatch
        : app.descendants(matching: .any).matching(titled("Recipe app")).firstMatch
      tap(recipe)
      waitForHittable(button(startingWith: "Recipe app, Coordinator"))
      XCTAssertTrue(recipe.isSelected || app.descendants(matching: .any).matching(titled("Recipe app")).allElementsBoundByIndex.contains { $0.isSelected },
                    "The selected chat's sidebar row is not highlighted")
      XCTAssertFalse(button("Close menu").exists, "Expanded navigation must not present a modal drawer")
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

  /// The whole height of the header's first control has to work on an unfolded
  /// Duo, where the system takes touches along the top edge of the screen.
  func testTopLeftControlAnswersAlongItsWholeHeight() throws {
    launch(route: "thread", coordinatorBeside: true)
    let hide = app.descendants(matching: .any).matching(identifier: "sidebar.collapse").firstMatch
    try XCTSkipUnless(hide.waitForExistence(timeout: 5), "No wide column on this display; run it unfolded")
    let reopen = app.buttons["chrome.show-sidebar"]
    settle()
    XCTAssertGreaterThanOrEqual(hide.frame.minY, 18)
    for height in [0.02, 0.5, 0.98] {
      hide.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: height)).tap()
      waitForHittable(reopen, "A tap \(height) of the way down the control did nothing")
      attachScreenshot("Hidden column with a way back")
      tap(reopen)
      // The column cross-fades; the control has no hit point until it settles.
      settle()
      waitForHittable(hide)
    }
    tap(app.buttons["column.threads"])
    settle()
    attachScreenshot("Threads and rail on the unfolded display")
    tap(app.buttons["column.coordinator"])
    settle()
    waitForHittable(hide)
  }

  func testCoordinatorSitsBesideTheThreadWhenWide() throws {
    launch(route: "thread", coordinatorBeside: true)
    XCUIDevice.shared.orientation = .landscapeLeft
    settle()
    try XCTSkipIf(app.frame.width < 760, "The scene is \(Int(app.frame.width)) points wide; this layout starts at 760")
    let threads = app.buttons["column.threads"]
    waitForHittable(threads)
    XCTAssertLessThan(threads.frame.minX, app.frame.width / 2, "The switch belongs in the left column")
    attachScreenshot("Coordinator beside thread")

    tap(threads)
    let coordinator = app.buttons["column.coordinator"]
    waitForHittable(coordinator)
    attachScreenshot("Threads in the column")
    tap(coordinator)
    waitForHittable(threads)
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
