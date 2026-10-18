import XCTest

@MainActor
final class PairingUITests: SWCUITestCase {
  func testBadLinkShowsAnErrorAndGoodLinkAddsAMachine() throws {
    launch(route: "pair")
    let link = field("Pairing link")
    waitForHittable(link, "The pair route should open pairing")
    let connect = button("Connect")
    XCTAssertFalse(connect.isEnabled, "Connect waits for a link")

    link.tap()
    link.typeText("https://bad.example.com/pair#token=expired")
    tap(connect)
    waitFor(element(containing: "Couldn't pair"), "A bad link should show an error")
    let error = element(containing: "didn't work")
    waitFor(error)
    XCTAssertTrue(error.label.contains("Create a new one"), "The error should say what to do: \(error.label)")
    XCTAssertTrue(connect.exists, "A failed pairing stays on the screen")
    attachScreenshot("Pairing error")

    tap(hittableButton(NSPredicate(format: "label IN %@", ["Clear link", "Clear"])))
    XCTAssertTrue(waitUntil { !connect.isEnabled }, "Clear should empty the link")
    link.tap()
    link.typeText("http://192.168.1.20:3773/#token=ABC")
    tap(connect)
    waitForGone(connect, "A good link should pair and go back")
    waitForHome()

    openDrawer()
    hittableButton(titled("Release 3.1 checklist")).swipeUp()
    waitFor(element(containing: "Machine at 192.168.1.20"), "The new machine should be listed")
    attachScreenshot("Drawer with new machine")
  }

  func testSampleDataCanBeExploredAndLeft() throws {
    launch(fixture: "empty")
    tap(button("Explore with sample data"))
    waitForHome()
    XCTAssertTrue(button(startingWith: "Aide, Coordinator").exists, "Sample data should open on Aide")
    waitForHittable(button("Exit sample data"), "Sample data should say so on every screen")
    attachScreenshot("Sample data")

    // Pairing is not possible on sample data; the pair screen says how to leave.
    openDrawer()
    tap(hittableButton("Settings"))
    tap(hittableButton(titled("Pair a machine")))
    waitFor(element(containing: "This is sample data"), "Pairing should point out the sample data")
    XCTAssertFalse(button("Connect").isEnabled, "Connect is off on sample data")
    tap(hittableButton("Exit sample data"))

    waitForHittable(button("Pair a machine"), "Leaving sample data goes back to the welcome screen")
    XCTAssertFalse(button("Exit sample data").exists)
    XCTAssertTrue(button("Explore with sample data").exists)
  }
}
