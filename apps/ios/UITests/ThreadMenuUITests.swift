import XCTest

@MainActor
final class ThreadMenuUITests: SWCUITestCase {
  func testPinRenameResolveAndMarkUnread() throws {
    launch(route: "thread")
    waitForHittable(button("Thread actions"))

    openThreadMenu()
    attachScreenshot("Thread menu")
    tap(button("Pin"))
    openThreadMenu()
    XCTAssertTrue(button("Unpin").exists, "Pin should turn into Unpin")
    XCTAssertFalse(button("Pin").exists)
    dismissMenu()

    let newTitle = "Release 3.1 final"
    tap(button("Rename…"), menuFirst: true)
    let alert = app.alerts["Rename thread"]
    waitFor(alert, "Rename should ask for a name")
    let name = alert.textFields.firstMatch
    waitFor(name)
    let current = name.value as? String ?? ""
    name.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: 0.5)).tap()
    name.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count + 4))
    name.typeText(newTitle)
    attachScreenshot("Rename")
    alert.buttons["Rename"].tap()
    waitForGone(alert)
    waitForHittable(button(startingWith: newTitle), "The title capsule should show the new name")

    tap(button("Resolve"), menuFirst: true)
    openThreadMenu()
    XCTAssertTrue(button("Reopen").exists, "Resolve should turn into Reopen")
    XCTAssertFalse(button("Resolve").exists)
    dismissMenu()

    tap(button("Mark unread"), menuFirst: true)
    _ = button("Mark unread").waitForNonExistence(timeout: timeout)

    // The drawer's recent row carries the new name, the pin and the unread state.
    tap(hittableButton("Back"))
    waitForHome()
    openDrawer()
    let recent = hittableButton(titled(newTitle))
    let spoken = recent.value as? String ?? ""
    XCTAssertTrue(spoken.contains("Unread"), "Mark unread should mark the thread unread: \(spoken)")
    XCTAssertTrue(spoken.contains("Pinned"), "Pin should pin the thread: \(spoken)")
    attachScreenshot("Drawer after thread actions")
  }

  func testDeleteAsksThenRemovesTheThread() throws {
    launch(route: "overview")
    let title = "Fix ledger merge conflicts"
    waitFor(text(startingWith: "Working, 2"))
    tap(button(startingWith: title))
    waitForHittable(button("Thread actions"))

    tap(button("Delete"), menuFirst: true)
    let confirm = button("Delete thread")
    waitForHittable(confirm, "Delete should ask for confirmation")
    XCTAssertTrue(element(containing: "can't be undone").exists, "The confirmation should explain the delete")
    attachScreenshot("Delete confirmation")
    confirm.tap()

    waitFor(text(startingWith: "Needs you"), "Deleting should return to the overview")
    waitForGone(button(startingWith: title), "The deleted thread should leave the overview")
    waitFor(text(startingWith: "Working, 1"))
    attachScreenshot("Overview after delete")
  }

  /// Opens the thread menu, then taps an item in it.
  private func tap(_ item: XCUIElement, menuFirst: Bool, file: StaticString = #filePath, line: UInt = #line) {
    if menuFirst { openThreadMenu(file: file, line: line) }
    tap(item, file: file, line: line)
  }
}
