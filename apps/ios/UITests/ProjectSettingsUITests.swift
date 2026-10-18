import XCTest

@MainActor
final class ProjectSettingsUITests: SWCUITestCase {
  func testEditingTheGoalSavesAndPersists() throws {
    launch()
    waitForHome()
    openProject("SpecWeave")
    let capsule = button(startingWith: "SpecWeave, Coordinator")

    tap(capsule)
    let goal = field("Goal")
    waitForHittable(goal, "The capsule should open project settings")
    let save = button("Save")
    waitFor(save)
    XCTAssertFalse(save.isEnabled, "Save stays off until something changes")
    attachScreenshot("Project settings")

    let addition = " Ship 3.1 by Friday."
    // Tap the end of the last line so the text goes after the current goal.
    goal.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: 0.92)).tap()
    goal.typeText(addition)
    XCTAssertTrue(waitUntil { save.isEnabled }, "Save should enable after editing the goal")
    attachScreenshot("Project settings edited")
    save.tap()
    waitForGone(goal, "Saving should close the sheet")
    waitForHittable(capsule)

    tap(capsule)
    let reopened = field("Goal")
    waitForHittable(reopened)
    let value = reopened.value as? String ?? ""
    XCTAssertTrue(value.hasSuffix(addition.trimmingCharacters(in: .whitespaces)), "The saved goal should come back: \(value)")
    XCTAssertTrue(value.hasPrefix("Plan work in a spec"), "The rest of the goal should be kept: \(value)")
    XCTAssertFalse(button("Save").isEnabled)
  }
}
