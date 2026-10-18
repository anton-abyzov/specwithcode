import Foundation
import SwiftUI
import Testing
@testable import SpecWithCode

@MainActor
struct EngineActivityTests {
  @Test func foregroundActivatesTheEngine() {
    #expect(EngineActivity.isActive(in: .active) == true)
  }

  @Test func backgroundDeactivatesTheEngine() {
    #expect(EngineActivity.isActive(in: .background) == false)
  }

  // Control Center, system alerts and the app switcher must not close machine sockets.
  @Test func inactiveLeavesTheEngineAlone() {
    #expect(EngineActivity.isActive(in: .inactive) == nil)
  }

  @Test func onlyBackgroundEverDeactivates() {
    let phases: [ScenePhase] = [.active, .inactive, .background]
    #expect(phases.filter { EngineActivity.isActive(in: $0) == false } == [.background])
  }
}

@MainActor
struct DeviceLabelTests {
  @Test func chosenNameWins() {
    #expect(DeviceLabel.resolve(stored: "Anton's iPhone", deviceName: "iPhone") == "Anton's iPhone")
  }

  @Test func chosenNameIsTrimmed() {
    #expect(DeviceLabel.resolve(stored: "  Work phone \n", deviceName: "iPhone") == "Work phone")
  }

  @Test func blankChosenNameFallsBackToTheSystemName() {
    #expect(DeviceLabel.resolve(stored: nil, deviceName: "iPhone") == "iPhone")
    #expect(DeviceLabel.resolve(stored: "", deviceName: "Anton's iPhone") == "Anton's iPhone")
    #expect(DeviceLabel.resolve(stored: "   ", deviceName: "Anton's iPhone") == "Anton's iPhone")
  }

  @Test func emptySystemNameFallsBackToIPhone() {
    #expect(DeviceLabel.resolve(stored: nil, deviceName: " ") == DeviceLabel.fallback)
  }

  @Test func currentReadsTheStoredName() throws {
    let suite = "DeviceLabelTests.\(UUID().uuidString)"
    let defaults = try #require(UserDefaults(suiteName: suite))
    defer { defaults.removePersistentDomain(forName: suite) }

    #expect(!DeviceLabel.current(defaults: defaults).isEmpty)
    defaults.set("Work phone", forKey: DeviceLabel.defaultsKey)
    #expect(DeviceLabel.current(defaults: defaults) == "Work phone")
  }
}
