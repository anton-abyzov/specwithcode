import XCTest

@MainActor
final class SettingsUITests: SWCUITestCase {
  func testGlobalSettingsAppearanceMachinesAndPairing() throws {
    launch()
    waitForHome()
    openDrawer()
    tap(hittableButton("Settings"))
    waitForHittable(button("Light appearance"), "Settings should open from the drawer")
    attachScreenshot("Settings")

    let light = button("Light appearance")
    let dark = button("Dark appearance")
    let system = button("System appearance")
    XCTAssertTrue(light.isSelected, "The launch appearance is light")

    dark.tap()
    XCTAssertTrue(waitUntil { dark.isSelected && !light.isSelected && !system.isSelected }, "Dark should be the only selected tile")
    attachScreenshot("Settings, dark")
    system.tap()
    XCTAssertTrue(waitUntil { system.isSelected && !dark.isSelected && !light.isSelected }, "System should be the only selected tile")
    light.tap()
    XCTAssertTrue(waitUntil { light.isSelected && !dark.isSelected && !system.isSelected }, "Light should be the only selected tile")

    hittableButton(NSPredicate(format: "label CONTAINS %@", "Office Mac, Online")).tap()
    waitForHittable(button("Reconnect"), "A machine row should open machine detail")
    XCTAssertTrue(button("Remove machine").exists)
    XCTAssertTrue(app.staticTexts["Office Mac"].exists)
    attachScreenshot("Machine detail")
    tap(hittableButton("Back"))
    waitForHittable(button("Pair a machine"))

    tap(button("Pair a machine"))
    waitForHittable(button("Connect"), "Pair a machine should open pairing")
    XCTAssertTrue(field("Pairing link").exists)
    attachScreenshot("Pairing from settings")
    tap(hittableButton("Back"))
    waitForHittable(button("Light appearance"))

    tap(hittableButton("Close"))
    waitForGone(button("Light appearance"), "Close should dismiss settings")
  }
}
