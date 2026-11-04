import Testing
@testable import SWCSync

@MainActor
@Suite struct ConnectStateTests {
  @Test func machineRowOffersSignInOnlyWhenSignedOut() {
    #expect(ConnectState(methods: []).machineRowSubtitle == "Primary connection · sign in to reach your computers")
  }

  @Test func machineRowNamesTheSignedInAccount() {
    let email = ConnectState(methods: [], user: ConnectUser(id: "u", displayName: "Sam", email: "sam@example.com"))
    #expect(email.machineRowSubtitle == "Primary connection · signed in as sam@example.com")
    let name = ConnectState(methods: [], user: ConnectUser(id: "u", displayName: "Sam"))
    #expect(name.machineRowSubtitle == "Primary connection · signed in as Sam")
    let neither = ConnectState(methods: [], user: ConnectUser(id: "u"))
    #expect(neither.machineRowSubtitle == "Primary connection · signed in")
  }
}
