import XCTest

/// One Percy for linked machines (1448 AC-14), on the `one-percy` sample
/// data: Studio and Laptop hold linked seats, Desktop's assistant never joined.
@MainActor
final class OnePercyUITests: SWCUITestCase {
  private let offlineLine = "Laptop is offline: its chats appear when it is back"

  func testDrawerShowsOnePercyForLinkedMachines() throws {
    launch(fixture: "one-percy")
    waitForHome()
    openDrawer()

    let percy = app.buttons["drawer.percy.env-studio"]
    let own = app.buttons["drawer.percy.env-desktop"]
    waitFor(percy, "The drawer should list the linked Percy")
    waitFor(own, "The drawer should list the assistant that did not join")
    XCTAssertFalse(app.buttons["drawer.percy.env-laptop"].exists, "Laptop's seat should not be a row of its own")
    XCTAssertEqual(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "drawer.percy.")).count, 2)
    // The linked row names no machine; the other says where it is and that it did not join.
    XCTAssertFalse(percy.label.contains("Studio") || percy.label.contains("Laptop"), "The linked row should name no machine: \(percy.label)")
    XCTAssertTrue(own.label.contains("Percy on Desktop"), "Unexpected label: \(own.label)")
    XCTAssertTrue(own.label.contains("not joined"), "Unexpected label: \(own.label)")
    attachScreenshot("Drawer with one Percy")
  }

  func testPercysChatsComeFromEverySeatWithTheirMachine() throws {
    launch(fixture: "one-percy")
    waitForHome()
    tap(hittableButton("Topics"))
    waitFor(text(startingWith: "Topics"), "Percy's chat list did not open")

    // Chats from both seats, each naming its machine.
    let onStudio = button(startingWith: "Plan the week")
    let onLaptop = button(startingWith: "Book flights to Lisbon")
    waitFor(onStudio)
    waitFor(onLaptop)
    XCTAssertTrue(onStudio.label.contains("Studio") || (onStudio.value as? String)?.contains("Studio") == true, "The chat should name Studio: \(onStudio.label) / \(String(describing: onStudio.value))")
    XCTAssertTrue(onLaptop.label.contains("Laptop") || (onLaptop.value as? String)?.contains("Laptop") == true, "The chat should name Laptop: \(onLaptop.label) / \(String(describing: onLaptop.value))")
    XCTAssertFalse(button(startingWith: "Sort the old notes").exists, "Desktop's assistant did not join, so its chats stay out")
    XCTAssertFalse(element(containing: offlineLine).exists)
    waitFor(element(containing: "Percy is the same on each machine where you turned it on."))
    attachScreenshot("Percy chats with machine tags")

    // A chat opens on the machine that owns it.
    tap(onLaptop)
    waitForHittable(button("Thread actions"), "The chat did not open")
    waitFor(button("Book flights to Lisbon"))
    let machine = app.buttons["chat.machine"]
    waitFor(machine)
    XCTAssertTrue(machine.label.hasPrefix("Laptop,"), "Unexpected chat machine: \(machine.label)")
    attachScreenshot("Percy chat on Laptop")
  }

  func testAnOfflineSeatIsOneQuietLine() throws {
    launch(fixture: "one-percy-away")
    waitForHome()
    // The phone talks to Studio, which is online.
    XCTAssertTrue(button(startingWith: "Percy, Coordinator").label.contains("Studio"))
    tap(hittableButton("Topics"))
    waitFor(text(startingWith: "Topics"), "Percy's chat list did not open")
    waitFor(element(containing: offlineLine), "The list should say Laptop is offline")
    waitFor(button(startingWith: "Plan the week"))
    XCTAssertFalse(button(startingWith: "Book flights to Lisbon").exists, "Laptop's chats wait for Laptop")
    attachScreenshot("Percy chats with Laptop offline")
  }
}
