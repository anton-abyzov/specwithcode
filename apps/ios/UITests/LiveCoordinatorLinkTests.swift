import XCTest

/// A real coordinator on a real server starts a real worker, and the phone taps
/// the link it posts and sends it a photo. Skipped unless `SWC_LIVE_COORDINATOR_LINK`
/// holds a fresh pairing link for a server with a project "Live Demo" and a
/// signed-in provider.
@MainActor
final class LiveCoordinatorLinkTests: XCTestCase {
  private let projectName = "Live Demo"
  private var app: XCUIApplication!
  private var shot = 0

  override func setUp() async throws {
    continueAfterFailure = false
    app = XCUIApplication()
    app.launchArguments = ["-SWCAppearance", "light"]
  }

  /// Run with `SWC_LIVE_SECOND_LINK`, `SWC_LIVE_SECOND_ENV` and `SWC_LIVE_SECOND_PROJECT`
  /// for a second server with a project "Second Demo", and a blue picture in Photos.
  func testLinksAndPhotosAcrossMachines() throws {
    let env = ProcessInfo.processInfo.environment
    guard let link = env["SWC_LIVE_COORDINATOR_LINK"], !link.isEmpty,
          let secondLink = env["SWC_LIVE_SECOND_LINK"], !secondLink.isEmpty,
          let secondEnv = env["SWC_LIVE_SECOND_ENV"], let secondProject = env["SWC_LIVE_SECOND_PROJECT"] else {
      throw XCTSkip("Set SWC_LIVE_COORDINATOR_LINK and the SWC_LIVE_SECOND_* values.")
    }
    app.launch()
    pair(link)
    openDrawer()
    let settings = app.buttons["Settings"].firstMatch
    XCTAssertTrue(settings.waitForExistence(timeout: 5))
    settings.tap()
    let pairAnother = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Pair")).firstMatch
    XCTAssertTrue(pairAnother.waitForExistence(timeout: 5))
    pairAnother.tap()
    enterPairingLink(secondLink)
    capture("second-machine-paired")
    let close = app.buttons["Close"].firstMatch
    XCTAssertTrue(close.waitForExistence(timeout: 5), "No way to close settings")
    close.tap()
    sleep(1)

    // A photo to a coordinator on the second machine. The reply proves the model saw it.
    open(project: "Second Demo")
    sendPhoto(text: "Reply with the main color of this photo in one word.")
    capture("second-machine-photo-sent")
    waitForReply(containing: "blue")
    capture("second-machine-photo-answered")

    // A photo with no words at all. It stays after the machine echoes it.
    sendPhoto(text: "")
    sleep(8)
    capture("photo-without-text")
    XCTAssertFalse(app.buttons["Remove photo"].exists, "The photo stayed in the composer")

    // The tap the user reported.
    open(project: projectName)
    let composer = app.textFields["Message"]
    XCTAssertTrue(composer.waitForExistence(timeout: 15))
    composer.tap()
    composer.typeText("Use delegate_task to start one worker titled Live Worker whose whole task is to reply OK. Then reply to me with only the thread link the tool returned, as a Markdown link.")
    app.buttons["Send"].tap()
    let threadLink = app.links.matching(NSPredicate(format: "identifier BEGINSWITH %@", "studio://thread/")).firstMatch
    XCTAssertTrue(threadLink.waitForExistence(timeout: 240), "The coordinator did not post a thread link")
    let canonical = threadLink.identifier
    capture("coordinator-posted-link")
    threadLink.tap()
    assertThreadOpened("canonical worker link")
    capture("worker-thread-open")

    // A photo to the worker, from the thread the link opened.
    sendPhoto(text: "Reply with the main color of this photo in one word.")
    capture("worker-photo-sent")
    waitForReply(containing: "blue")
    capture("worker-photo-answered")
    goBack()

    // Every other form, written into a message so each reaches the same parser.
    let segment = String(canonical.dropFirst("studio://thread/".count))
    let asWritten = "studio://thread/\(segment.removingPercentEncoding ?? segment)"
    let coordinatorId = "project-coordinator%3A\(secondProject)"
    let forms: [(String, String)] = [
      ("as-written", asWritten),
      ("other-machine", "studio://thread/\(secondEnv)/\(coordinatorId)"),
      ("bare-other-machine", "studio://thread/\(coordinatorId)"),
      ("title", "studio://thread/Live%20Worker"),
    ]
    composer.tap()
    composer.typeText(forms.map { "[\($0.0)](\($0.1))" }.joined(separator: " ") + " Ignore these links and reply OK.")
    app.buttons["Send"].tap()
    for (name, url) in forms {
      let element = app.links.matching(NSPredicate(format: "identifier == %@", url)).firstMatch
      XCTAssertTrue(element.waitForExistence(timeout: 20), "No link for \(name): \(url)")
      element.tap()
      assertThreadOpened(name)
      capture("form-\(name)-open")
      goBack()
    }

    // The worker again, once archived.
    let workerLink = app.links.matching(NSPredicate(format: "identifier == %@", canonical)).firstMatch
    XCTAssertTrue(workerLink.waitForExistence(timeout: 20))
    revealBelowTopBar(workerLink)
    workerLink.tap()
    assertThreadOpened("worker before archive")
    app.buttons["Thread actions"].tap()
    let archive = app.buttons["Archive"].firstMatch
    XCTAssertTrue(archive.waitForExistence(timeout: 5), "No Archive action")
    archive.tap()
    let confirm = app.buttons["Archive thread"].firstMatch
    XCTAssertTrue(confirm.waitForExistence(timeout: 5))
    confirm.tap()
    sleep(3)
    capture("worker-archived")
    if !workerLink.exists, app.buttons["Back"].firstMatch.exists { goBack() }
    XCTAssertTrue(workerLink.waitForExistence(timeout: 20), "Coordinator chat did not come back")
    revealBelowTopBar(workerLink)
    workerLink.tap()
    assertThreadOpened("archived worker")
    capture("archived-worker-open")
    let text = app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] %@", "Live Worker")).firstMatch
    XCTAssertTrue(text.waitForExistence(timeout: 15), "The archived worker did not show its conversation")
  }

  private func sendPhoto(text: String) {
    let attach = app.buttons["Attach"].firstMatch
    XCTAssertTrue(attach.waitForExistence(timeout: 15), "The composer has no Attach button")
    attach.tap()
    let library = app.buttons["Photo Library"].firstMatch
    if library.waitForExistence(timeout: 3) { capture("attach-choice"); library.tap() }
    sleep(4)
    capture("photo-picker")
    let photo = app.images.matching(NSPredicate(format: "label BEGINSWITH %@", "Photo")).firstMatch
    if photo.waitForExistence(timeout: 8) {
      photo.tap()
    } else {
      XCTContext.runActivity(named: "PICKER \(app.debugDescription.prefix(3000))") { _ in }
      app.coordinate(withNormalizedOffset: CGVector(dx: 0.17, dy: 0.3)).tap()
    }
    sleep(1)
    capture("photo-selected")
    for name in ["Add", "Done", "Choose"] where app.buttons[name].exists {
      app.buttons[name].firstMatch.tap()
      break
    }
    let strip = app.descendants(matching: .any)["composer.attachments"]
    XCTAssertTrue(strip.waitForExistence(timeout: 15), "The picked photo did not reach the composer")
    let remove = app.buttons["Remove photo"].firstMatch
    XCTAssertTrue(remove.waitForExistence(timeout: 20), "The photo did not finish preparing")
    capture("photo-in-composer")
    let composer = app.textFields["Message"]
    if !text.isEmpty {
      composer.tap()
      composer.typeText(text)
    }
    let shownBefore = app.descendants(matching: .any).matching(identifier: "message.attachment").count
    app.buttons.matching(NSPredicate(format: "label == %@ OR label == %@", "Send", "Queue message")).firstMatch.tap()
    let shown = app.descendants(matching: .any).matching(identifier: "message.attachment")
    let deadline = Date().addingTimeInterval(20)
    while shown.count <= shownBefore, Date() < deadline { usleep(250_000) }
    XCTAssertGreaterThan(shown.count, shownBefore, "The sent photo is not in the transcript")
  }

  /// A tap on a link under the glass top bar lands on the bar.
  private func revealBelowTopBar(_ element: XCUIElement) {
    let top = app.buttons["Menu"].firstMatch.frame.maxY
    for _ in 0..<8 where element.frame.minY < top || !element.isHittable {
      let older = element.frame.minY < top
      let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: older ? 0.35 : 0.65))
      let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: older ? 0.5 : 0.5))
      start.press(forDuration: 0.05, thenDragTo: end)
      sleep(1)
    }
  }

  private func waitForReply(containing word: String) {
    let reply = app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] %@", word)).firstMatch
    XCTAssertTrue(reply.waitForExistence(timeout: 180), "No reply containing \(word)")
    sleep(2)
  }

  private func assertThreadOpened(_ name: String) {
    let actions = app.buttons["Thread actions"]
    guard actions.waitForExistence(timeout: 10) else {
      let texts = app.staticTexts.allElementsBoundByIndex.prefix(30).map(\.label).joined(separator: " | ")
      capture("failed-\(name)")
      XCTFail("\(name) did not open the thread. Screen: \(texts)")
      return
    }
    sleep(1)
  }

  private func goBack() {
    let back = app.buttons["Back"].firstMatch
    XCTAssertTrue(back.waitForExistence(timeout: 5), "No Back button")
    back.tap()
    sleep(1)
  }

  private func open(project title: String) {
    openDrawer()
    let project = app.buttons.matching(NSPredicate(format: "label == %@", title)).firstMatch
    // A project in a scratch folder lists under the collapsed "Automated" group.
    let automated = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Automated")).firstMatch
    if !project.waitForExistence(timeout: 5), automated.waitForExistence(timeout: 10) { automated.tap() }
    XCTAssertTrue(project.waitForExistence(timeout: 30), "\(title) missing from drawer")
    project.tap()
    sleep(2)
  }

  private func pair(_ link: String) {
    let pair = app.buttons["Pair a machine"]
    XCTAssertTrue(pair.waitForExistence(timeout: 20), "Welcome screen did not appear")
    pair.tap()
    enterPairingLink(link)
  }

  private func enterPairingLink(_ link: String) {
    let field = app.textFields["Pairing link"]
    XCTAssertTrue(field.waitForExistence(timeout: 5))
    field.tap()
    field.typeText(link)
    app.buttons["Connect"].tap()
    XCTAssertTrue(field.waitForNonExistence(timeout: 30), "Pairing did not finish")
  }

  private func openDrawer() {
    let close = app.descendants(matching: .any)["Close menu"]
    if close.exists { return }
    let menu = app.buttons["Menu"].firstMatch
    if !menu.waitForExistence(timeout: 3), app.buttons["Back"].firstMatch.exists { goBack() }
    XCTAssertTrue(menu.waitForExistence(timeout: 10), "No menu button")
    // The pairing toast can swallow the first tap; a native coordinate tap as in SWCUITestCase.
    for _ in 0..<4 where !close.exists {
      menu.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
      _ = close.waitForExistence(timeout: 4)
    }
    capture("drawer")
    XCTAssertTrue(close.exists, "Drawer did not open")
    sleep(1)
  }

  private func capture(_ name: String) {
    shot += 1
    let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
    attachment.name = String(format: "%02d-%@", shot, name)
    attachment.lifetime = .keepAlways
    add(attachment)
  }
}
