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
      chooseMachine("Office Mac")
      waitForHittable(button(startingWith: "Recipe app"))
      chooseMachine(nil)
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
    // Beside a coordinator, the pane switch's last choice hides the column.
    let hide = app.descendants(matching: .any).matching(identifier: "column.panes.detail").firstMatch
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

  /// A thread's header says it is a thread in its project, and that line opens
  /// the project's coordinator: in place beside it when wide, by going back on a phone.
  func testThreadHeaderNamesItsKindAndOpensTheCoordinator() throws {
    launch(fixture: "long", route: "thread", coordinatorBeside: true)
    let kind = app.buttons["chat.kind"]
    // isHittable can stay false on SDK 27 while a tap works: check it exists, then tap where it is.
    waitFor(kind)
    XCTAssertTrue(kind.label.hasPrefix("Thread in "), kind.label)
    saveShot("header-thread-compact")
    kind.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    waitFor(app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "coordinator ·")).firstMatch)
    saveShot("header-coordinator-compact")

    launch(fixture: "long", route: "thread", coordinatorBeside: true)
    XCUIDevice.shared.orientation = .landscapeLeft
    settle()
    try XCTSkipIf(app.frame.width < 760, "The scene is \(Int(app.frame.width)) points wide; this layout starts at 760")
    let wideKind = app.buttons["chat.kind"]
    waitFor(wideKind)
    saveShot("header-thread-wide")
    wideKind.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    settle()
    XCTAssertTrue(wideKind.exists, "The thread stays open beside its coordinator")
    saveShot("header-thread-wide-after-tap")
  }

  /// The coordinator stays in the left column; beside it are its threads,
  /// then the thread picked from them. The pane switch shows either alone.
  func testCoordinatorStaysLeftWithItsThreadsBeside() throws {
    launch(route: "coordinator", coordinatorBeside: true)
    XCUIDevice.shared.orientation = .landscapeLeft
    settle()
    try XCTSkipIf(app.frame.width < 760, "The scene is \(Int(app.frame.width)) points wide; this layout starts at 760")
    let middle = app.frame.width / 2
    let threadsPane = app.descendants(matching: .any).matching(identifier: "threads-pane.header").firstMatch
    waitForHittable(threadsPane)
    XCTAssertGreaterThan(threadsPane.frame.minX, middle * 0.8, "The threads belong beside the coordinator")
    let panes = app.descendants(matching: .any).matching(identifier: "column.panes").firstMatch
    XCTAssertLessThan(panes.frame.minX, middle, "The pane switch belongs to the coordinator column")
    XCTAssertTrue(app.buttons["column.panes.both"].isSelected)
    XCTAssertFalse(app.buttons["column.panes.column"].isSelected)
    saveShot("1 Coordinator and its threads")

    tap(app.descendants(matching: .any).matching(identifier: "sidebar.thread").firstMatch)
    let back = app.buttons["chat.back-to-threads"]
    waitFor(back)
    XCTAssertGreaterThan(back.frame.minX, middle * 0.8)
    XCTAssertTrue(panes.exists, "The coordinator stays in the column while a thread opens")
    saveShot("2 Thread beside its coordinator")

    tap(app.buttons["column.panes.column"])
    settle()
    XCTAssertFalse(back.isHittable, "Coordinator only hides the thread")
    XCTAssertGreaterThan(panes.frame.minX, 0)
    saveShot("3 Coordinator only")

    tap(app.buttons["column.panes.detail"])
    let reopen = app.buttons["chrome.show-sidebar"]
    waitForHittable(reopen)
    XCTAssertLessThan(reopen.frame.minX, middle * 0.5, "Thread only fills the screen")
    saveShot("4 Thread only")
    tap(reopen)
    settle()
    waitForHittable(panes)

    tapLow(back)
    waitForHittable(threadsPane)
    XCTAssertTrue(app.buttons["column.panes.both"].isSelected)

    // With no thread open, the other side alone is the threads list.
    tap(app.buttons["column.panes.detail"])
    waitForHittable(reopen)
    waitForHittable(threadsPane)
    XCTAssertLessThan(threadsPane.frame.minX, middle * 0.5, "Threads only fills the screen")
    saveShot("5 Threads only")
    tap(reopen)
    waitForHittable(panes)
  }

  /// With the column at All projects, the coordinator on the right still
  /// reaches its threads: its header's Threads button brings them back.
  func testCoordinatorReachesItsThreadsFromAllProjects() throws {
    launch(route: "coordinator")
    XCUIDevice.shared.orientation = .landscapeLeft
    settle()
    try XCTSkipIf(app.frame.width < 760, "The scene is \(Int(app.frame.width)) points wide; this layout starts at 760")
    let middle = app.frame.width / 2
    let allProjects = app.buttons["sidebar.all-projects"]
    if allProjects.exists { tap(allProjects); settle() }
    let threadsButton = app.buttons["chat.threads"]
    waitForHittable(threadsButton)
    XCTAssertGreaterThan(threadsButton.frame.minX, middle * 0.8, "The coordinator header offers its threads")
    saveShot("6 All projects beside the coordinator")

    tap(threadsButton)
    let thread = app.descendants(matching: .any).matching(identifier: "sidebar.thread").firstMatch
    waitForHittable(thread)
    XCTAssertLessThan(thread.frame.minX, middle, "The column lists the coordinator's threads")
    waitForGone(threadsButton)
    // Grouped by what they need, as on the desktop.
    let groups = app.descendants(matching: .any).matching(identifier: "sidebar.thread-group")
    waitFor(groups.firstMatch)
    XCTAssertTrue(groups.firstMatch.label.hasPrefix("Needs you"), "Needs you leads, got \(groups.firstMatch.label)")
    XCTAssertGreaterThan(groups.count, 1)
    saveShot("7 Threads beside the coordinator")
  }

  /// With the coordinator kept in the column, the same button brings the
  /// coordinator back to the column with its threads beside it.
  func testCoordinatorBesideReachesItsThreadsFromAllProjects() throws {
    launch(route: "coordinator", coordinatorBeside: true)
    XCUIDevice.shared.orientation = .landscapeLeft
    settle()
    try XCTSkipIf(app.frame.width < 760, "The scene is \(Int(app.frame.width)) points wide; this layout starts at 760")
    let middle = app.frame.width / 2
    let threadsPane = app.descendants(matching: .any).matching(identifier: "threads-pane.header").firstMatch
    waitForHittable(threadsPane)
    let threadsButton = app.buttons["chat.threads"]

    tap(app.buttons["sidebar.all-projects"])
    settle()
    waitForHittable(threadsButton)
    saveShot("8 All projects, coordinator kept beside")
    tap(threadsButton)
    waitForHittable(threadsPane)
    XCTAssertGreaterThan(threadsPane.frame.minX, middle * 0.8, "The threads sit beside the coordinator")
    XCTAssertLessThan(app.descendants(matching: .any).matching(identifier: "column.panes").firstMatch.frame.minX, middle)
    saveShot("9 Coordinator and its threads again")
  }

  /// A machine chip keeps the projects on that machine, and each project row
  /// names the machines it is on.
  func testMachineChipNarrowsProjectsAndRowsNameTheirMachines() throws {
    launch()
    XCUIDevice.shared.orientation = .landscapeLeft
    settle()
    try XCTSkipIf(app.frame.width < 760, "The scene is \(Int(app.frame.width)) points wide; this layout starts at 760")
    let allProjects = app.buttons["sidebar.all-projects"]
    if allProjects.exists { tap(allProjects); settle() }
    let specweave = app.buttons["SpecWeave"]
    let verified = app.buttons["Verified Skill"]
    waitForHittable(specweave)
    waitForHittable(verified)
    XCTAssertTrue((verified.value as? String ?? "").contains("Build box, online"), "The row says which machines it is on")
    XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "sidebar.project-machines").firstMatch.exists)
    saveShot("10 Projects with their machines")

    // Machines that don't fit as chips are all in one menu.
    let menu = app.buttons["sidebar.machine-menu"]
    if menu.exists {
      tap(menu)
      waitForHittable(button(startingWith: "Travel laptop"))
      saveShot("10b Machine menu")
      tap(button(startingWith: "Build box"))
    } else {
      chooseMachine("Build box")
    }
    waitForGone(specweave)
    waitForHittable(verified)
    waitForHittable(app.buttons["Recipe app"])
    saveShot("11 Build box projects")

    chooseMachine(nil)
    waitForHittable(specweave)
  }

  /// Beside Aide's coordinator the screen lists Aide's threads, not every
  /// project; All projects stays one tap back, and Threads returns.
  func testAidesCoordinatorShowsItsOwnThreadsBeside() throws {
    launch(coordinatorBeside: true)
    XCUIDevice.shared.orientation = .landscapeLeft
    settle()
    try XCTSkipIf(app.frame.width < 760, "The scene is \(Int(app.frame.width)) points wide; this layout starts at 760")
    let middle = app.frame.width / 2
    let threadsPane = app.staticTexts["threads-pane.header"]
    waitForHittable(threadsPane)
    XCTAssertEqual(threadsPane.label, "Threads", "Beside Aide the list is Aide's threads")
    XCTAssertGreaterThan(threadsPane.frame.minX, middle * 0.8)
    saveShot("12 Aide and its threads")

    tapLow(app.buttons["sidebar.all-projects"])
    let threadsButton = app.buttons["chat.threads"]
    waitFor(threadsButton)
    settle()
    saveShot("13 All projects beside Aide")
    tapLow(threadsButton)
    waitForHittable(threadsPane)
    XCTAssertEqual(threadsPane.label, "Threads")
  }

  /// A project on several machines narrows its threads to one of them, on the
  /// phone's Threads screen and in the list beside the coordinator, and a
  /// swipe offers Resolve as an icon.
  func testProjectThreadsFilterByMachine() throws {
    launch(route: "overview")
    let filter = app.descendants(matching: .any)["threads.machine-chips"]
    waitFor(filter)
    chooseThreadMachine("Build box")
    saveShot("14 Threads on one machine")
    chooseThreadMachine(nil)

    let row = button(startingWith: "Add verify gate to CI")
    waitForHittable(row)
    row.swipeLeft()
    let resolve = button("Resolve")
    waitFor(resolve)
    XCTAssertTrue(resolve.staticTexts.allElementsBoundByIndex.allSatisfy { $0.label != "Resolve" }, "The swipe shows an icon, not the word")
    saveShot("15 Swipe to resolve")

    launch(route: "coordinator")
    XCUIDevice.shared.orientation = .landscapeLeft
    settle()
    try XCTSkipIf(app.frame.width < 760, "The scene is \(Int(app.frame.width)) points wide; this layout starts at 760")
    let allProjects = app.buttons["sidebar.all-projects"]
    if allProjects.exists { tapLow(allProjects); settle() }
    tapLow(app.buttons["chat.threads"])
    waitFor(filter)
    XCTAssertLessThan(filter.frame.minX, app.frame.width / 2, "The filter sits over the coordinator's threads")
    chooseThreadMachine("Build box")
    saveShot("16 Threads beside the coordinator on one machine")
  }

  /// A long reply opens and closes again at once on an unfolded Duo.
  func testLongReplyExpandsAndCollapsesWithoutFreezing() throws {
    launch(fixture: "long")
    XCUIDevice.shared.orientation = .landscapeLeft
    settle()
    let more = app.buttons["Show more"]
    waitForHittable(more)
    let start = Date()
    tap(more)
    let less = app.buttons["Show less"]
    for _ in 0..<12 where !less.isHittable { app.swipeUp() }
    waitForHittable(less)
    tap(less)
    waitFor(more)
    XCTAssertLessThan(Date().timeIntervalSince(start), 20, "Expanding and collapsing took too long")
    tap(field("Message"))
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5), "The app stopped answering after collapsing")
  }

  /// Headers at the top edge of an unfolded Duo read as covered to
  /// XCUITest; a tap low in the frame reaches them as a finger does.
  private func tapLow(_ element: XCUIElement) {
    waitFor(element)
    element.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.8)).tap()
  }

  /// Picks a machine from the chips, or from the menu that replaces them
  /// when they don't fit the column; nil picks all of them.
  private func chooseMachine(_ name: String?) {
    let menu = app.buttons["sidebar.machine-menu"]
    if menu.exists {
      tap(menu)
      tap(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", name ?? "All machines")).firstMatch)
    } else {
      tap(name.map { button(startingWith: $0) } ?? button("All"))
    }
    settle()
  }

  private func chooseThreadMachine(_ name: String?) {
    let chips = app.descendants(matching: .any)["threads.machine-chips"]
    waitFor(chips)
    let chip = name.map { chips.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", $0)).firstMatch } ?? chips.buttons["All"]
    waitFor(chip)
    if !chip.isHittable { chips.swipeLeft() }
    tap(chip)
    settle()
  }

  /// A screenshot attached to the run and, when SWC_SHOTS_DIR is set for the
  /// runner, written there for before-and-after comparisons.
  private func saveShot(_ name: String) {
    attachScreenshot(name)
    guard let dir = ProcessInfo.processInfo.environment["SWC_SHOTS_DIR"] else { return }
    try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
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
