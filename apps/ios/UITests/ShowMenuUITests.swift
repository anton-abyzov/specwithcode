import XCTest

/// The chat menu's Show and Agent replies sections (docs/transcript-detail.md).
@MainActor
final class ShowMenuUITests: SWCUITestCase {
  /// The Show picker inside an open chat menu.
  func showPicker() -> XCUIElement {
    let byId = app.buttons["chat.show"]
    return byId.exists ? byId : button(startingWith: "Show,")
  }

  func scopePicker() -> XCUIElement {
    let byId = app.buttons["chat.show-scope"]
    return byId.exists ? byId : button(startingWith: "Applies to")
  }

  func choose(_ option: String, in picker: XCUIElement) {
    tap(picker)
    tap(button(option))
    settle()
  }

  func testAThreadsMenuChangesItsShowLevel() throws {
    launch(route: "thread")
    waitForHittable(button("Thread actions"))
    settle(1.5)
    attachScreenshot("Thread, Folded steps")

    openThreadMenu()
    waitFor(showPicker(), "The thread menu should hold Show")
    waitFor(scopePicker(), "The thread menu should say which threads Show changes")
    waitFor(element(containing: "Agent replies"), "A project's thread should show its reply style")
    attachScreenshot("Thread menu")

    // Every thread: the phone's default changes.
    choose("Everything", in: showPicker())
    attachScreenshot("Everything")

    // This thread: the thread keeps its own level from now on.
    openThreadMenu()
    choose("This thread", in: scopePicker())
    openThreadMenu()
    XCTAssertTrue(element(containing: "This thread").exists, "Applies to should read This thread")
    choose("Results only", in: showPicker())
    attachScreenshot("Results only, this thread")

    openThreadMenu()
    XCTAssertTrue(element(containing: "Results only").exists, "Show should read Results only")
    dismissMenu()
  }

  func testACoordinatorHeaderHoldsShow() throws {
    launch()
    waitForHome()
    let menu = app.buttons["chat.show-menu"]
    waitForHittable(menu, "The coordinator header should hold the Show menu")
    tap(menu)
    waitFor(showPicker(), "The Show menu should open")
    attachScreenshot("Coordinator Show menu")
    choose("Results only", in: showPicker())
    attachScreenshot("Coordinator, Results only")
  }
}
