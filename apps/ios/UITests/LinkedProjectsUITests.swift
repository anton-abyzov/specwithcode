import XCTest

/// A project linked across M4 and Minis, on the `fleet` fixture with
/// `-SWCLinkedState` choosing what the copies report.
@MainActor
final class LinkedProjectsUITests: SWCUITestCase {
  private func launchLinked(_ state: String, route: String? = "projectSettings", forgetPrompts: Bool = false) {
    app?.terminate()
    let app = XCUIApplication()
    var arguments = ["-SWCFixture", "fleet", "-SWCAppearance", "light", "-SWCLinkedState", state, "-swc.sidebarCollapsed", "NO", "-swc.coordinatorBeside", "NO", "-swc.detailCollapsed", "NO"]
    if let route { arguments += ["-SWCRoute", route] }
    // An earlier run on this simulator may have asked already.
    if forgetPrompts { arguments += ["-swc.linkedMachinesPrompted", "()"] }
    app.launchArguments = arguments
    app.launch()
    self.app = app
  }

  /// Saved beside the test results and, when `SWC_EVIDENCE_DIR` is set, as a PNG there.
  private func capture(_ name: String) {
    attachScreenshot(name)
    if let directory = ProcessInfo.processInfo.environment["SWC_EVIDENCE_DIR"] {
      let url = URL(fileURLWithPath: directory).appendingPathComponent("\(name).png")
      try? XCUIScreen.main.screenshot().pngRepresentation.write(to: url)
    }
  }

  private func scroll(to element: XCUIElement) {
    for _ in 0..<8 where !(element.exists && element.isHittable) {
      app.swipeUp()
    }
  }

  func testUnreachableCoordinatorOffersTakeoverAfterTheWait() throws {
    launchLinked("coordinator-away")
    waitFor(element(containing: "M4 unreachable · last synced"), "Settings should say the coordinator's machine is unreachable")
    let takeover = button("Take over coordinator here")
    scroll(to: takeover)
    waitForHittable(takeover, "A reachable copy should offer to take over")
    XCTAssertTrue(takeover.isEnabled, "M4 has been away for 25 minutes, past the 10-minute wait")
    XCTAssertTrue(element(containing: "Minis · Standby").exists, "The armed standby should be named")
    capture("linked-coordinator-away-takeover")
    scroll(to: element(containing: "If M4 goes quiet"))
    capture("linked-coordinator-away-standby")

    tap(takeover)
    let confirm = app.buttons.matching(NSPredicate(format: "label == %@", "Take over")).firstMatch
    waitForHittable(confirm, "Taking over asks once")
    capture("linked-takeover-confirm")
    confirm.tap()
    waitFor(element(containing: "Minis now coordinates this project."), "The phone should say who coordinates now")
    capture("linked-takeover-done")
  }

  /// The warning's Machines link opens Minis' copy, whose machine answers,
  /// not M4's settings that cannot load while M4 is away.
  func testMachinesLinkOfAnUnreachableCoordinatorReachesTheTakeover() throws {
    launchLinked("coordinator-away", route: "coordinator")
    waitFor(element(containing: "M4 unreachable · last synced"), "The chat should warn that the coordinator's machine is unreachable")
    capture("linked-unreachable-banner")
    tap(hittableButton("Machines"))
    let takeover = button("Take over coordinator here")
    scroll(to: takeover)
    waitForHittable(takeover, "Machines should reach the copy that can take over")
    XCTAssertFalse(element(containing: "Couldn't load settings").exists, "Machines opened the away copy's settings")
    XCTAssertTrue(takeover.isEnabled, "M4 has been away for 25 minutes, past the 10-minute wait")
    capture("linked-machines-link-takeover")
    tap(takeover)
    let confirm = app.buttons.matching(NSPredicate(format: "label == %@", "Take over")).firstMatch
    waitForHittable(confirm, "Taking over asks once")
    confirm.tap()
    waitFor(element(containing: "Minis now coordinates this project."), "The phone should say who coordinates now")
    capture("linked-machines-link-takeover-done")
  }

  func testTitleOfAnUnreachableCoordinatorOpensAReachableCopysSettings() throws {
    launchLinked("coordinator-away", route: "coordinator")
    let capsule = hittableButton(NSPredicate(format: "label BEGINSWITH %@", "SpecWeave, Coordinator"))
    capsule.tap()
    let takeover = button("Take over coordinator here")
    scroll(to: takeover)
    waitForHittable(takeover, "The title should open settings that list the machines")
    XCTAssertFalse(element(containing: "Couldn't load settings").exists, "The title opened the away copy's settings")
  }

  func testSettingsThatCannotLoadStillListTheMachines() throws {
    launchLinked("coordinator-away")
    let takeover = button("Take over coordinator here")
    scroll(to: takeover)
    waitForHittable(takeover, "Settings of any copy should list the machines")
    capture("linked-settings-machines")
  }

  func testTappingTheLinkedProjectOpensTheActiveCoordinatorsCopy() throws {
    // M4 is listed first and still claims epoch 3; Minis took over at epoch 4.
    launchLinked("auto-takeover", route: nil)
    openDrawer(firstRow: "SpecWeave")
    let row = hittableButton(titled("SpecWeave"))
    capture("linked-active-copy-drawer")
    row.tap()
    let capsule = button(startingWith: "SpecWeave, Coordinator")
    waitForHittable(capsule, "The title capsule should show the project's coordinator")
    waitForGone(button("Close menu"), "The drawer should close after picking the project")
    let machine = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Minis")).firstMatch
    waitFor(machine, "The project should open on Minis, whose coordinator is active at the highest epoch")
    XCTAssertFalse(capsule.label.contains("M4"), "The project opened M4's copy: \(capsule.label)")
    capture("linked-active-copy-open")
  }

  func testAutomaticTakeoverShowsTheRearmStatus() throws {
    launchLinked("auto-takeover")
    let status = element(containing: "No standby armed yet: M4 did not answer. Trying again.")
    scroll(to: status)
    waitFor(status, "The machine that took over should say why it has no standby yet")
    XCTAssertTrue(element(containing: "took over from M4 at").exists)
    capture("linked-auto-takeover-rearm")
  }

  func testSwitchedOffLinkedMachineIsOfferedOnceWhenTheProjectOpens() throws {
    launchLinked("switched-off", route: "coordinator", forgetPrompts: true)
    let turnOn = app.alerts.buttons["Turn on"]
    waitFor(turnOn, "Opening the project should offer to turn on Minis")
    capture("linked-switched-off-prompt")
    app.alerts.buttons["Not now"].tap()
    // Opening the same project again does not ask twice.
    launchLinked("switched-off", route: "coordinator")
    settle(2)
    XCTAssertFalse(app.alerts.buttons["Turn on"].exists, "The prompt shows once per project")
  }
}
