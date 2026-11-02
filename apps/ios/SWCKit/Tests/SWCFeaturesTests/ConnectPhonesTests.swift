import Foundation
import Testing
@testable import SWCFeatures
import SWCSync

@MainActor
@Suite("Your phones")
struct ConnectPhonesTests {
  private func make() -> (AppModel, FixtureEngine) {
    let engine = FixtureEngine(scenario: .connect)
    engine.latency = .zero
    engine.streamDelay = .zero
    return (AppModel(engine: engine), engine)
  }

  @Test func connectScenarioListsThisPhoneFirstThenTheMostRecent() async throws {
    let (model, engine) = make()
    #expect(model.connect?.isSignedIn == true)
    let phones = try await engine.connectPhones()
    #expect(phones.map(\.label) == ["Anton's iPhone", "Work iPhone", "Old iPhone"])
    #expect(phones.map(\.isThisPhone) == [true, false, false])
  }

  @Test func removingAnotherPhoneKeepsTheAccount() async throws {
    let (model, engine) = make()
    try await engine.connectRemovePhone("phone-old")
    #expect(try await engine.connectPhones().map(\.id) == ["phone-this", "phone-work"])
    #expect(model.connect?.isSignedIn == true)
  }

  @Test func removingThisPhoneSignsOut() async throws {
    let (model, engine) = make()
    try await engine.connectRemovePhone("phone-this")
    #expect(model.connect?.isSignedIn == false)
    #expect(try await engine.connectPhones().isEmpty)
  }

  @Test func subtitleShowsTheModelAndWhenOtherPhonesWereSeen() {
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    let other = ConnectPhone(id: "p", label: "Old iPhone", model: "iPhone 13 mini", lastSeen: now.addingTimeInterval(-30))
    #expect(other.settingsSubtitle(now: now) == "iPhone 13 mini · Seen just now")
    let hours = ConnectPhone(id: "p", label: "Old iPhone", model: nil, lastSeen: now.addingTimeInterval(-2 * 3600))
    #expect(hours.settingsSubtitle(now: now)?.hasPrefix("Seen ") == true)
    let this = ConnectPhone(id: "t", label: "Anton's iPhone", model: "iPhone 16 Pro", lastSeen: now, isThisPhone: true)
    #expect(this.settingsSubtitle(now: now) == "iPhone 16 Pro")
    #expect(ConnectPhone(id: "x", label: "Phone").settingsSubtitle(now: now) == nil)
  }

  @Test func aPhoneThatCanOnlySayIPhoneShowsItsModel() {
    let duo = ConnectPhone(id: "d", label: "iPhone", model: "iPhone Duo", appVersion: "0.1.4", isThisPhone: true)
    #expect(duo.title == "iPhone Duo")
    #expect(duo.settingsSubtitle() == "App 0.1.4")
    let dev = ConnectPhone(id: "v", label: "iPhone", model: "iPhone Duo", appVersion: "0.1.1", iosMajorVersion: 27, isDevBuild: true, isThisPhone: true)
    #expect(dev.settingsSubtitle() == "iOS 27 · App 0.1.1 (dev build)")
    #expect(ConnectPhone(id: "g", label: "iPhone", model: "iPhone").settingsSubtitle() == "Model shows after the app updates")
    #expect(ConnectPhone(id: "o", label: "iPhone").title == "iPhone")
    #expect(ConnectPhone(id: "n", label: "Work phone", model: "iPhone 17").title == "Work phone")
  }

  @Test func confirmationNamesThePhone() {
    let this = ConnectPhone(id: "t", label: "Anton's iPhone", isThisPhone: true)
    let other = ConnectPhone(id: "o", label: "Old iPhone")
    #expect(ConnectPhonesCard.confirmTitle(this) == "Remove this iPhone?")
    #expect(ConnectPhonesCard.confirmTitle(other) == "Remove Old iPhone?")
    #expect(ConnectPhonesCard.confirmMessage(other).hasPrefix("Old iPhone stops getting notifications"))
    #expect(ConnectPhonesCard.confirmMessage(this).hasPrefix("This signs this iPhone out"))
    #expect(!ConnectPhonesCard.confirmMessage(other).contains("this iPhone"))
  }

  @Test func orderingKeepsTheRelayOrderForTies() {
    let a = ConnectPhone(id: "a", label: "A")
    let b = ConnectPhone(id: "b", label: "B")
    let c = ConnectPhone(id: "c", label: "C", lastSeen: Date())
    #expect(ConnectPhone.ordered([a, b, c]).map(\.id) == ["c", "a", "b"])
  }

  @Test func modelNamesForKnownAndUnknownHardware() {
    #expect(ConnectDevice.modelName("iPhone17,1") == "iPhone 16 Pro")
    #expect(ConnectDevice.modelName("iPhone99,9") == "iPhone99,9")
    #expect(ConnectDevice.modelName("iPhone19,4") == "iPhone Duo")
    #expect(ConnectDevice.modelName("iPhone19,2") == "iPhone 18 Pro")
    #expect(ConnectDevice.modelName("arm64") == nil)
    #expect(ConnectDevice.modelName(nil) == nil)
  }
}
