import XCTest

/// A thread's composer shows its model and options, and changes them as the
/// desktop's options menu does: reasoning, Ultracode, fast mode and access.
@MainActor
final class ModelOptionsUITests: SWCUITestCase {
  func testOptionsMenuTurnsOnUltracodeForTheNextMessage() throws {
    launch(route: "thread", appearance: "dark")
    // The chip appears once the thread has loaded.
    let chip = app.buttons["chat.model-options"]
    waitForHittable(chip, "The composer should show the thread's model options")
    XCTAssertTrue(chip.label.contains("Opus 5.5"), "The chip should name the model: \(chip.label)")
    XCTAssertTrue(chip.label.contains("High"), "The chip should show the reasoning effort: \(chip.label)")
    XCTAssertFalse(chip.label.contains("Ultracode"), "Ultracode starts off: \(chip.label)")

    chip.tap()
    settle()
    for name in ["Reasoning", "Context window", "Ultracode", "Fast Mode", "Access"] {
      XCTAssertTrue(element(containing: name).waitForExistence(timeout: timeout), "The menu should offer \(name)")
    }
    attachScreenshot("Model options menu")
    // Held open for a moment so a simulator screenshot can catch the menu.
    if ProcessInfo.processInfo.environment["SWC_HOLD_MENU"] != nil { Thread.sleep(forTimeInterval: 8) }

    let ultracode = app.switches.matching(NSPredicate(format: "label BEGINSWITH 'Ultracode'")).firstMatch.exists
      ? app.switches.matching(NSPredicate(format: "label BEGINSWITH 'Ultracode'")).firstMatch
      : app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Ultracode'")).firstMatch
    tap(ultracode)
    settle()
    XCTAssertTrue(waitUntil { chip.label.contains("Ultracode") }, "The chip should show Ultracode on: \(chip.label)")
    XCTAssertTrue(chip.label.contains("Thinking On"), "Other options keep their values: \(chip.label)")
    attachScreenshot("Ultracode chosen")
  }

  /// The chip's model name opens the model picker; the next message runs on the pick.
  func testModelPickerSwitchesTheModelForTheNextMessage() throws {
    launch(route: "thread", appearance: "dark")
    // The chip appears once the thread has loaded.
    let chip = app.buttons["chat.model-options"]
    waitForHittable(chip, "The composer should show the thread's model options")
    XCTAssertTrue(chip.label.contains("Opus 5.5"), "The chip starts on the thread's model: \(chip.label)")

    openModelPicker()
    tap(provider("codex"))
    settle()
    tap(reveal(row("codex", "codex/gpt-5.5")))
    settle()
    XCTAssertTrue(waitUntil { chip.label.contains("GPT-5.5") }, "The chip should name the picked model: \(chip.label)")
    XCTAssertFalse(chip.label.contains("High"), "Opus's options do not carry over to Codex: \(chip.label)")
    XCTAssertTrue(modelButton.label.contains("GPT-5.5"), "The model part names the pick: \(modelButton.label)")
    attachScreenshot("GPT-5.5 picked")

    // Sending runs the message on the picked model; the chip keeps naming it.
    tap(composer)
    composer.typeText("Try this on Codex")
    hittableButton("Send").tap()
    settle()
    XCTAssertTrue(waitUntil { chip.label.contains("GPT-5.5") }, "After sending the chip still names GPT-5.5: \(chip.label)")
    attachScreenshot("Sent on GPT-5.5")

    openModelPicker()
    tap(provider("claudeAgent"))
    settle()
    tap(reveal(row("claudeAgent", "claudeAgent/claude-sonnet-5-5")))
    settle()
    XCTAssertTrue(waitUntil { chip.label.contains("Sonnet 5.5") }, "The chip should name Sonnet: \(chip.label)")
    XCTAssertTrue(chip.label.contains("High"), "Sonnet starts from its own default options: \(chip.label)")

    // A model picked on this phone is offered again under Recent.
    openModelPicker()
    XCTAssertTrue(row("recent", "codex/gpt-5.5").waitForExistence(timeout: timeout), "GPT-5.5 was picked here, so it is recent")
    attachScreenshot("Recent picks")
  }

  /// The picked model's family leads the list, across the providers that serve it.
  func testModelPickerPutsTheFamilyFirst() throws {
    launch(route: "thread", appearance: "dark")
    openModelPicker()
    let current = row("family", "claudeAgent/claude-opus-5-5")
    waitFor(current, "The thread's own model should lead the list")
    XCTAssertTrue(current.isSelected, "The thread's model is the checked row")
    XCTAssertTrue(element(containing: "Opus family").exists || element(containing: "OPUS FAMILY").exists, "The section names the family")
    let viaCursor = row("family", "cursor/claude-opus-5-5")
    let viaCopilot = row("family", "acpRegistry_copilot/claude-opus-5-5")
    waitFor(viaCursor, "Opus through Cursor is one tap away")
    waitFor(viaCopilot, "Opus through Copilot is one tap away")
    XCTAssertLessThan(current.frame.minY, viaCursor.frame.minY, "The thread's model is the first row")
    let own = providerRow("claudeAgent")
    waitFor(own, "The thread's own provider leads the providers")
    XCTAssertLessThan(viaCopilot.frame.maxY, own.frame.minY, "The family sits above the providers")
    attachScreenshot("Model picker")
    // The thread's own provider is open, with its other models; every other provider follows.
    waitFor(reveal(row("claudeAgent", "claudeAgent/claude-sonnet-5-5")), "Claude Code's models show without a tap")
    XCTAssertFalse(row("codex", "codex/gpt-5.5").exists, "Other providers start closed")
    waitFor(reveal(providerRow("opencode")), "Every provider is listed below")
    attachScreenshot("Providers")
    app.collectionViews.firstMatch.swipeDown()
    app.collectionViews.firstMatch.swipeDown()
    settle()

    tap(viaCursor)
    settle()
    let chip = app.buttons["chat.model-options"]
    XCTAssertTrue(waitUntil { self.modelButton.label.contains("Opus 5.5") }, "Still Opus: \(modelButton.label)")
    XCTAssertFalse(chip.label.contains("High"), "Cursor's Opus starts from its own options: \(chip.label)")
  }

  /// One search covers every model and provider, and says so when it guesses.
  func testModelPickerSearchFindsModelsAndProviders() throws {
    launch(route: "thread", appearance: "dark")
    openModelPicker()
    let search = app.searchFields.firstMatch
    waitForHittable(search, "The picker should have a search field")
    search.tap()
    search.typeText("sol")
    settle()
    waitFor(row("search", "codex/gpt-6.2-sol"), "Sol on Codex should match")
    waitFor(row("search", "acpRegistry_copilot/gpt-6.2-sol"), "Sol on Copilot should match")
    XCTAssertFalse(row("search", "claudeAgent/claude-opus-5-5").exists, "Only matches are listed")
    attachScreenshot("Model search")

    search.typeText(" copilot")
    settle()
    XCTAssertFalse(row("search", "codex/gpt-6.2-sol").exists, "Both words must match")
    waitFor(row("search", "acpRegistry_copilot_personal/gpt-6.1-sol"), "A provider name narrows the search")

    clear(search)
    search.typeText("wnder")
    settle()
    waitFor(row("search", "muse/muse-wonder-1.0"), "A typo falls back to the closest names")
    XCTAssertTrue(element(containing: "Closest").exists || element(containing: "CLOSEST").exists, "The fallback is labelled")
    attachScreenshot("Closest matches")

    clear(search)
    search.typeText("zzzz")
    settle()
    waitFor(app.descendants(matching: .any).matching(identifier: "model-picker.empty").firstMatch, "Nothing matching says so")

    clear(search)
    search.typeText("wonder")
    settle()
    tap(row("search", "muse/muse-wonder-full-1.0"))
    settle()
    XCTAssertTrue(waitUntil { self.modelButton.label.contains("Wonder Full 1.0") }, "The pick from search applies: \(modelButton.label)")
  }

  /// The list keeps its place while the thread behind it is working.
  func testModelPickerKeepsItsPlaceWhileTheThreadWorks() throws {
    launch(fixture: "streaming", route: "thread", appearance: "dark")
    openModelPicker()
    for id in ["codex", "muse", "cursor", "acpRegistry_copilot"] {
      tap(provider(id))
      settle(0.3)
    }
    let last = reveal(providerRow("opencode"))
    waitFor(last, "The last provider should be reachable by scrolling")
    settle()
    let before = last.frame
    let ticksBefore = streamedTicks()
    attachScreenshot("Scrolled")
    Thread.sleep(forTimeInterval: 4)
    let ticksAfter = streamedTicks()
    XCTAssertGreaterThan(ticksBefore, 0, "The reply behind the sheet is streaming")
    XCTAssertGreaterThan(ticksAfter, ticksBefore + 20, "The transcript kept changing while the sheet was open: \(ticksBefore) to \(ticksAfter)")
    XCTAssertTrue(last.exists, "The row is still on screen")
    XCTAssertEqual(last.frame.minY, before.minY, accuracy: 1, "The list did not jump back to the top")
    attachScreenshot("Still scrolled")
  }

  /// How far the `streaming` fixture's reply ("tick 1 tick 2 ...") has got.
  /// The chat stays in the tree under the sheet.
  private func streamedTicks() -> Int {
    let label = element(containing: "tick 1 tick 2").label
    return label.split(separator: " ").last.flatMap { Int($0) } ?? 0
  }

  private var modelButton: XCUIElement { app.buttons["chat.model-picker"] }

  private func openModelPicker() {
    waitForHittable(modelButton, "The chip's model name should open the picker")
    modelButton.tap()
    // A tap can land while the transcript is still settling under the chip.
    let sheet = app.navigationBars["Model"]
    if !sheet.waitForExistence(timeout: 3) { modelButton.tap() }
    waitFor(sheet, "The model sheet should open")
    settle()
  }

  /// A model's row in one of the picker's sections.
  private func row(_ section: String, _ id: String) -> XCUIElement {
    app.buttons.matching(identifier: "model-picker.\(section).\(id)").firstMatch
  }

  /// A provider's row, scrolled into view.
  private func provider(_ id: String) -> XCUIElement {
    reveal(providerRow(id))
  }

  /// The row and its label share the identifier.
  private func providerRow(_ id: String) -> XCUIElement {
    app.buttons.matching(identifier: "model-picker.provider.\(id)").firstMatch
  }

  /// Scrolls the picker until the row is on screen: a list builds only the rows near it.
  @discardableResult
  private func reveal(_ element: XCUIElement) -> XCUIElement {
    let list = app.collectionViews.firstMatch
    for _ in 0..<8 where !(element.exists && element.isHittable) {
      list.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.7)).press(forDuration: 0.05, thenDragTo: list.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.35)))
      settle(0.4)
    }
    return element
  }

  private func clear(_ field: XCUIElement) {
    let typed = (field.value as? String) ?? ""
    field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: typed.count))
  }

  /// On an unfolded Duo the thread's controls sit at the foot of the status
  /// rail, clear of the system's clock, Wi-Fi and indicators at its top.
  func testDuoRailSitsBelowTheSystemStatusIcons() throws {
    launch(route: "thread", appearance: "dark")
    // The chip appears once the thread has loaded.
    let rail = app.descendants(matching: .any).matching(identifier: "chat.rail").firstMatch
    guard rail.waitForExistence(timeout: 3) else {
      throw XCTSkip("No status rail on this device: it shows only on an unfolded iPhone Duo")
    }
    let window = app.windows.firstMatch.frame
    XCTAssertGreaterThan(rail.frame.minY, window.height / 2, "The rail should start in the lower half, below the status icons")
    XCTAssertLessThanOrEqual(rail.frame.maxY, window.maxY, "The rail should stay on screen")
    attachScreenshot("Duo status rail")
  }
}
