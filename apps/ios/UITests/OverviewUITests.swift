import XCTest

@MainActor
final class OverviewUITests: SWCUITestCase {
  func testOverviewGroupsThreadsAndOpensOne() throws {
    launch()
    waitForHome()
    openProject("SpecWeave")

    tap(hittableButton("Threads"))
    waitFor(text(startingWith: "Threads"), "The overview header is missing")
    XCTAssertTrue(text(startingWith: "Threads").label.contains("SpecWeave"))
    waitFor(text(startingWith: "Needs you"))
    waitFor(text(startingWith: "Working"))
    waitFor(text(startingWith: "Idle"))
    attachScreenshot("Overview")

    tap(button(startingWith: "Fix ledger merge conflicts"))
    let capsule = button(startingWith: "Fix ledger merge conflicts")
    waitForHittable(button("Thread actions"), "The thread did not open")
    XCTAssertTrue(capsule.label.contains("SpecWeave"), "Thread capsule should name the project: \(capsule.label)")
    waitForGone(text(startingWith: "Needs you"))
    attachScreenshot("Thread from overview")

    tap(hittableButton("Back"))
    waitFor(text(startingWith: "Needs you"), "Back should return to the overview")
    waitForHittable(button(startingWith: "Fix ledger merge conflicts"))
    XCTAssertFalse(button("Thread actions").exists)

    tap(hittableButton("Back"))
    waitForHittable(button(startingWith: "SpecWeave, Coordinator"), "Back should return to the project chat")
  }
}
