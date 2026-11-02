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

  func testNoRulesShowNoTeamRules() throws {
    launch()
    waitForHome()
    openDrawer()
    tap(hittableButton("Settings"))
    waitForHittable(button("Light appearance"))
    XCTAssertFalse(element(containing: "Team rules").exists, "No rules, no section")
    XCTAssertFalse(element(containing: "Set by").exists)
  }

  func testTeamRulesSectionLockAndLimitedPicker() throws {
    launch(fixture: "team-rules")
    waitForHome()
    openDrawer()
    tap(hittableButton("Settings"))
    let refused = button(startingWith: "Travel laptop")
    XCTAssertTrue(refused.waitForExistence(timeout: timeout), "Settings should open from the drawer")
    XCTAssertTrue(refused.label.contains("Turned off by team rules"), "A refused machine should say so, not ask to pair again")
    XCTAssertTrue(element(containing: "Team rules").waitForExistence(timeout: timeout), "The rules section should show")
    XCTAssertTrue(element(containing: "Set by Acme IT").exists, "The picker row should name who locked it")
    attachScreenshot("Team rules, settings")

    // The default on this machine is above the limit, so it reads as the limit.
    let picker = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Approval mode for new threads")).firstMatch
    XCTAssertTrue(picker.waitForExistence(timeout: timeout), "The approval mode picker should show")
    XCTAssertTrue(waitUntil { picker.label.contains("Accept edits") }, "A default above the limit reads as the limit")
    picker.tap()
    XCTAssertTrue(app.buttons["Accept edits"].waitForExistence(timeout: timeout), "The picker should open")
    XCTAssertTrue(app.buttons["Ask before changes"].exists)
    XCTAssertFalse(app.buttons["Full access"].exists, "The picker must stop at the limit")
    XCTAssertFalse(app.buttons["Auto"].exists, "The picker must stop at the limit")
    attachScreenshot("Team rules, limited picker")
    app.buttons["Accept edits"].tap()
    waitForGone(app.buttons["Ask before changes"], "Choosing a mode should close the picker")

    app.swipeUp()
    XCTAssertTrue(element(containing: "Agents are paused").waitForExistence(timeout: timeout), "The broken rules file should show")
    attachScreenshot("Team rules, rules listed")
    app.swipeDown()

    // The drawer under the sheet lists the same machine, so take the one on top.
    tap(hittableButton(NSPredicate(format: "label CONTAINS %@", "Turned off by team rules")))
    XCTAssertTrue(element(containing: "turn off phones").waitForExistence(timeout: timeout), "A refusal should read in the machine's words")
    XCTAssertTrue(element(containing: "Your pairing stays").exists)
    attachScreenshot("Team rules, refused machine")
  }

  func testChatAboveTheLimitOffersTheWayDown() throws {
    launch(fixture: "team-rules", route: "thread")
    XCTAssertTrue(element(containing: "Above your team's limit").waitForExistence(timeout: timeout), "A thread above the limit should say so")
    XCTAssertTrue(element(containing: "Set by Acme IT. This thread uses Full access.").exists)
    attachScreenshot("Team rules, chat above limit")
    let lower = button("Switch to Accept edits")
    XCTAssertTrue(lower.exists, "The way down should be offered")
    lower.tap()
    waitForGone(lower, "Lowering the thread should clear the notice")
    XCTAssertFalse(element(containing: "Above your team's limit").exists)
  }

  func testChatWithNoRulesShowsNoNotice() throws {
    launch(route: "thread")
    XCTAssertTrue(composer.waitForExistence(timeout: timeout))
    XCTAssertFalse(element(containing: "team's limit").exists)
    XCTAssertFalse(element(containing: "paused by your team").exists)
  }
}
