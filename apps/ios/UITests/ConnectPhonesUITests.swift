import XCTest

@MainActor
final class ConnectPhonesUITests: SWCUITestCase {
  func testYourPhonesListsAndRemovesAPhone() throws {
    launch(fixture: "connect", route: "settings")
    waitForHittable(button("Light appearance"), "Settings should open")
    let thisPhone = button(startingWith: "Anton's iPhone")
    waitFor(thisPhone, "Your phones should list this iPhone")
    XCTAssertTrue(thisPhone.label.contains("This iPhone"), "This iPhone is marked")
    let old = button(startingWith: "Old iPhone")
    waitFor(old)
    XCTAssertTrue(old.label.contains("iPhone 13 mini"), "The model is shown")
    attachScreenshot("Your phones")

    tap(old)
    let remove = button("Remove")
    waitForHittable(remove, "Removing asks first")
    XCTAssertTrue(element(containing: "Remove Old iPhone?").exists)
    attachScreenshot("Remove a phone")
    remove.tap()
    waitForGone(button(startingWith: "Old iPhone"), "The removed phone leaves the list")
    XCTAssertTrue(button(startingWith: "Work iPhone").exists)

    tap(button(startingWith: "Anton's iPhone"))
    let signOut = button("Remove and sign out")
    waitForHittable(signOut, "Removing this iPhone says it signs out")
    XCTAssertTrue(element(containing: "Remove this iPhone?").exists)
    XCTAssertTrue(element(containing: "This signs this iPhone out").exists)
    signOut.tap()
    waitForGone(button(startingWith: "Work iPhone"), "Removing this iPhone signs out and hides the list")
    waitFor(button("Sign in with Apple"), "Signed out, the account card offers sign-in")
  }
}
