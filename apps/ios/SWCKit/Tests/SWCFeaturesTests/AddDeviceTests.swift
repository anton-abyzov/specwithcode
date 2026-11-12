import Foundation
import Testing
@testable import SWCFeatures
import SWCSync

@MainActor
@Suite("Add a device or machine")
struct AddDeviceTests {
  private let signedIn = ConnectState(methods: [], user: ConnectUser(id: "u", email: "sam@example.com"))

  @Test func namesTheAccountOnlyWhenSignedIn() {
    #expect(AddDeviceView.account(signedIn) == "sam@example.com")
    #expect(AddDeviceView.account(ConnectState(methods: [])) == nil)
    #expect(AddDeviceView.account(nil) == nil)
  }

  @Test func linksMatchTheDesktopDialog() {
    #expect(AddDeviceView.url(.phone).absoluteString == "https://specwithcode.com/get")
    #expect(AddDeviceView.url(.computer).absoluteString == "https://specwithcode.com/download")
  }

  @Test func stepsSignInWithTheSameAccount() {
    for kind in [AddDeviceView.Kind.phone, .computer] {
      let steps = AddDeviceView.steps(kind, account: "sam@example.com")
      #expect(steps.count == 3)
      #expect(steps[1] == "Sign in as sam@example.com.")
    }
    #expect(AddDeviceView.steps(.computer, account: "a").last?.contains("press Allow there") == true)
  }

  @Test func routeRoundTrips() throws {
    let data = try JSONEncoder().encode(Route.addDevice)
    #expect(try JSONDecoder().decode(Route.self, from: data) == .addDevice)
  }
}
