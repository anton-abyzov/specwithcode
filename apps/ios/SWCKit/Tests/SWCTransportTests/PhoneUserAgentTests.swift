import Foundation
import Testing
@testable import SWCTransport

/// The phone names its app version on every request to a machine and the
/// relay, so a machine's approval popup can say which version asks (1447 AC-05).
@Suite struct PhoneUserAgentTests {
  let base = URL(string: "http://127.0.0.1:8431/")!
  /// The server's own pattern, from apps/server/src/fleet/connectDeviceNames.ts.
  let serverPattern = #"(?:SpecWithCode|SpecWeaveStudio(?:\(Alpha\))?)/(\d+\.\d+\.\d+)"#

  private func serverVersion(_ userAgent: String?) -> String? {
    guard let userAgent, let regex = try? NSRegularExpression(pattern: serverPattern),
          let match = regex.firstMatch(in: userAgent, range: NSRange(userAgent.startIndex..., in: userAgent)),
          let range = Range(match.range(at: 1), in: userAgent) else { return nil }
    return String(userAgent[range])
  }

  @Test func namesTheVersionAndBuildTheServerReads() {
    let agent = PhoneUserAgent.make(version: "0.1.9", build: "47")
    #expect(agent == "SpecWithCode/0.1.9 (iOS; build 47)")
    #expect(serverVersion(agent) == "0.1.9")
  }

  @Test func leavesOutAVersionItCannotVouchFor() {
    #expect(PhoneUserAgent.make(version: nil, build: nil) == "SpecWithCode (iOS)")
    #expect(PhoneUserAgent.make(version: "0.1", build: "47") == "SpecWithCode (iOS; build 47)")
    #expect(PhoneUserAgent.make(version: "0.1.9", build: "47; evil") == "SpecWithCode/0.1.9 (iOS)")
    #expect(serverVersion(PhoneUserAgent.make(version: "0.1", build: nil)) == nil)
  }

  /// The session's label and app are recorded when the token is minted.
  @Test func theSessionCreatingRequestsCarryIt() async throws {
    let fake = FakeHTTP { _ in (200, Captured.token) }
    let http = MachineHTTP(transport: fake)
    _ = try await http.exchangePairingCode("W779DCWZZ3P3", at: base, clientLabel: "iPhone")
    _ = try await http.redeemConnectCredential("cred", at: base, clientLabel: "iPhone", key: SoftwareDpopKey())
    #expect(fake.requests.count == 2)
    for request in fake.requests {
      #expect(request.url?.path == "/oauth/token")
      #expect(request.value(forHTTPHeaderField: "User-Agent") == PhoneUserAgent.current)
    }
  }

  @Test func everyMachineRequestCarriesIt() async throws {
    let fake = FakeHTTP { request in
      switch request.url?.path {
      case "/api/auth/websocket-ticket": (200, Captured.ticket)
      case "/api/auth/session": (200, Captured.session)
      default: (200, Captured.descriptor)
      }
    }
    let http = MachineHTTP(transport: fake)
    _ = try await http.descriptor(at: base)
    _ = try await http.websocketTicket(token: "t", at: base)
    _ = try await http.session(token: "t", at: base)
    #expect(fake.requests.count == 3)
    #expect(fake.requests.allSatisfy { $0.value(forHTTPHeaderField: "User-Agent") == PhoneUserAgent.current })
  }

  @Test func theWebSocketHandshakeCarriesIt() throws {
    let connection = URLSessionWebSocketConnection(url: URL(string: "ws://127.0.0.1:8431/ws?ticket=x")!)
    defer { connection.close() }
    #expect(connection.handshakeRequest?.value(forHTTPHeaderField: "User-Agent") == PhoneUserAgent.current)
  }

  @Test func aRequestThatNamesItsOwnAgentKeepsIt() {
    var request = URLRequest(url: base)
    request.setValue("Probe/1", forHTTPHeaderField: "User-Agent")
    request.setPhoneUserAgent()
    #expect(request.value(forHTTPHeaderField: "User-Agent") == "Probe/1")
  }
}
