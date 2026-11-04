import XCTest
import UIKit

@MainActor
final class PopupPresentationTests: SWCUITestCase {
  func testAttachmentAnchorsInBothColumnsAndAfterRotation() throws {
    XCUIDevice.shared.orientation = .landscapeLeft
    defer { XCUIDevice.shared.orientation = .portrait }
    launch(route: "thread", coordinatorBeside: true)
    app.terminate()
    app.launchArguments += ["-SWCAttachmentChoices"]
    app.launch()
    waitFor(button("Attach"))
    for orientation in [UIDeviceOrientation.landscapeLeft, .landscapeRight] {
      XCUIDevice.shared.orientation = orientation
      settle()
      let controls = app.buttons.matching(NSPredicate(format: "label == 'Attach'"))
      XCTAssertEqual(controls.count, 2, "Run on an expanded display with both chat columns")
      for index in 0..<controls.count {
        let trigger = controls.element(boundBy: index)
        waitForHittable(trigger)
        let anchor = trigger.frame
        tap(trigger)
        let library = button("Photo Library")
        waitForHittable(library)
        let camera = button("Take Photo")
        waitFor(camera)
        let bounds = library.frame.union(camera.frame)
        XCTAssertTrue(app.windows.firstMatch.frame.contains(bounds), "Choices must fit in the viewport")
        if app.windows.firstMatch.frame.width > 700 {
          XCTAssertLessThan(abs(bounds.maxY - anchor.minY), 130, "Popup detached from Attach: \(bounds), \(anchor)")
          XCTAssertLessThan(abs(bounds.midX - anchor.midX), 220, "Popup belongs to the other column")
        }
        attachScreenshot("attachment-\(orientation.rawValue)-column-\(index)")
        // Keep the choices open while rotating, then verify the same source again.
        XCUIDevice.shared.orientation = orientation == .landscapeLeft ? .landscapeRight : .landscapeLeft
        settle()
        waitFor(library)
        let rotatedBounds = library.frame.union(camera.frame)
        let rotatedAnchor = controls.element(boundBy: index).frame
        XCTAssertTrue(app.windows.firstMatch.frame.contains(rotatedBounds))
        XCTAssertLessThan(abs(rotatedBounds.maxY - rotatedAnchor.minY), 130)
        XCTAssertLessThan(abs(rotatedBounds.midX - rotatedAnchor.midX), 220)
        attachScreenshot("attachment-rotated-column-\(index)")
        tap(library)
        tap(button("Cancel"))
        waitForGone(library)
      }
    }
  }

  func testThreadConfirmationsAreAlertsAndCancelPreservesThread() throws {
    launch(route: "thread")
    for (item, title) in [("Archive", "Archive this thread?"), ("Delete", "Delete this thread?")] {
      let actions = button("Thread actions")
      waitFor(actions)
      XCTAssertTrue(actions.isEnabled)
      XCTAssertTrue(app.windows.firstMatch.frame.contains(actions.frame))
      actions.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
      tap(button(item))
      assertAlert(title)
      tap(app.alerts[title].buttons["Cancel"])
      waitForGone(app.alerts[title])
      waitFor(button("Thread actions"))
    }
  }

  func testAccountAndPhoneConfirmationsAreAlerts() throws {
    launch(fixture: "connect", route: "settings")
    for (label, title) in [("Sign out", "Sign out?"), ("Delete account", "Delete your account?"), ("Old iPhone", "Remove Old iPhone?")] {
      let row = button(startingWith: label)
      for _ in 0..<6 where !row.isHittable { app.swipeUp() }
      tap(row)
      assertAlert(title)
      tap(app.alerts[title].buttons["Cancel"])
      waitForGone(app.alerts[title])
    }
  }

  func testMachineConfirmationIsAnAlert() throws {
    launch(route: "machines")
    tap(hittableButton(NSPredicate(format: "label CONTAINS %@", "Office Mac, Online")))
    let remove = button("Remove machine")
    for _ in 0..<6 where !remove.isHittable { app.scrollViews.containing(.button, identifier: "Remove machine").firstMatch.swipeUp() }
    tap(remove)
    assertAlert("Remove Office Mac?")
    tap(app.alerts.firstMatch.buttons["Cancel"])
    waitForGone(app.alerts.firstMatch)
    XCTAssertTrue(button("Remove machine").exists)
  }

  func testProjectConfirmationsAreAlertsAndKeepEdits() throws {
    launch(route: "projectSettings")
    let archive = button("Archive")
    for _ in 0..<6 where !archive.isHittable { app.swipeUp() }
    tap(archive)
    let alert = app.alerts.firstMatch
    waitFor(alert)
    XCTAssertTrue(alert.label.hasPrefix("Archive "))
    attachScreenshot("Archive project confirmation")
    tap(alert.buttons["Cancel"])
    let goal = field("Goal")
    for _ in 0..<6 where !goal.isHittable { app.swipeDown() }
    tap(goal)
    goal.typeText(" Popup cancellation test")
    tap(button("Close"))
    assertAlert("Discard changes?")
    tap(app.alerts["Discard changes?"].buttons["Keep editing"])
    XCTAssertTrue((field("Goal").value as? String ?? "").contains("Popup cancellation test"))
  }

  private func assertAlert(_ title: String) {
    let alert = app.alerts[title]
    waitFor(alert)
    XCTAssertTrue(app.windows.firstMatch.frame.contains(alert.frame), "Alert clipped by viewport")
    attachScreenshot(title)
  }
}
