import XCTest

@MainActor
final class DrawerUITests: SWCUITestCase {
  func testArchivedAndAutomatedAreSeparateProjectGroups() throws {
    launch(fixture: "duplicates")
    waitForHome()
    tap(button("Menu"))
    waitFor(button("Close menu"))
    waitFor(button("Automated (1)"))
    waitFor(button("Archived (1)"))
    attachScreenshot("Project partitions folded")
    button("Archived (1)").tap()
    waitForHittable(button(startingWith: "Archived check"))
    XCTAssertFalse(button(startingWith: "Active check").exists)
    attachScreenshot("Archived project group")
    button("Hide archived").tap()
    button("Automated (1)").tap()
    waitForHittable(button(startingWith: "Active check"))
    XCTAssertFalse(button(startingWith: "Archived check").exists)
    attachScreenshot("Automated project group")
  }

  func testDrawerListsAideProjectsRecentsAndMachines() throws {
    launch()
    waitForHome()
    openDrawer()
    attachScreenshot("Drawer")

    for title in ["Aide", "SpecWeave", "Verified Skill", "Recipe app", "Docs site"] {
      XCTAssertTrue(hittableButton(titled(title)).exists, "Drawer is missing \(title)")
    }
    waitFor(app.staticTexts["Projects"])
    waitFor(app.staticTexts["Recents"])
    XCTAssertTrue(hittableButton(titled("Release 3.1 checklist")).exists, "Recents are missing the release thread")

    // Machines sit below the fold.
    hittableButton(titled("Release 3.1 checklist")).swipeUp()
    waitFor(app.staticTexts["Machines"])
    for machine in ["Office Mac", "Build box", "Travel laptop"] {
      XCTAssertTrue(hittableButton(NSPredicate(format: "label CONTAINS %@", machine)).exists, "Drawer is missing machine \(machine)")
    }
    attachScreenshot("Drawer, machines")
  }

  func testTappingAProjectOpensItsCoordinatorChat() throws {
    launch()
    waitForHome()
    XCTAssertTrue(button(startingWith: "Aide, Coordinator").exists, "Home should be the Aide chat")

    openDrawer()
    hittableButton(titled("Recipe app")).tap()

    let capsule = button(startingWith: "Recipe app, Coordinator")
    waitForHittable(capsule, "The title capsule should show the project")
    XCTAssertTrue(capsule.label.contains("Build box"), "Capsule should name the machine: \(capsule.label)")
    waitForGone(button("Close menu"), "The drawer should close after picking a project")
    XCTAssertTrue(field("Message").exists)
    XCTAssertEqual(composer.placeholderValue, "Message the coordinator…")
    attachScreenshot("Recipe app coordinator")
  }

  func testCoveredScreenIsHiddenFromAccessibility() throws {
    continueAfterFailure = true
    launch()
    waitForHome()
    XCTAssertFalse(button("New chat").exists, "The closed drawer's New chat button is still exposed")
    XCTAssertFalse(button("Search projects and threads").exists, "The closed drawer's search button is still exposed")

    openDrawer()
    XCTAssertFalse(button("Threads").exists, "The chat under the open drawer is still exposed")
    XCTAssertFalse(field("Message").exists, "The composer under the open drawer is still exposed")

    // Closing gives the chat back to VoiceOver and hides the drawer again.
    tap(button("Close menu"))
    waitForGone(button("Close menu"))
    waitForHittable(button("Threads"))
    XCTAssertFalse(button("New chat").exists, "The closed drawer's New chat button is exposed again")
  }

  func testCloseMenuClosesTheDrawer() throws {
    launch()
    waitForHome()
    openDrawer()

    let close = button("Close menu")
    if close.isHittable {
      close.tap()
    } else {
      // The dimmed card sits right of the drawer; tap its visible part.
      app.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
    }
    waitForGone(close, "Close menu should close the drawer")
    waitForHittable(button("Menu"))
    XCTAssertTrue(button(startingWith: "Aide, Coordinator").isHittable, "The chat should be usable again")
  }
}
