import Foundation
import Testing
@testable import SWCTransport

private struct PriorityAuthorizer: ConnectAuthorizing {
  let signedOut: Bool
  let key = SoftwareDpopKey()

  func credential(for environmentId: String, at route: MachineRoute, refresh: Bool) async throws -> (MachineCredential, any DpopKey) {
    if signedOut { throw ConnectError.signedOut }
    return (MachineCredential(token: "connect-token", expiresAt: Date().addingTimeInterval(3600), permissions: ["orchestration:read"]), key)
  }
}

@Suite struct ConnectPriorityTests {
  private func setup(connectDown: Bool = false, directDown: Bool = false, signedOut: Bool = false,
                     version: Int = 2, socketFailure: Bool = false) throws -> (MachineConnection, FakeHTTP, FakeConnector) {
    let support = MachineConnectionTests()
    var record = support.record(["https://m4.tail1234.ts.net"])
    record.connectRoute = try #require(ConnectAuthorizer.route(for: ConnectEndpoint(
      httpBaseUrl: "https://env-1.tunnels.example.com", wsBaseUrl: "wss://env-1.tunnels.example.com")))
    let http = FakeHTTP { request in
      let isConnect = request.url?.host == "env-1.tunnels.example.com"
      if isConnect ? connectDown : directDown { throw URLError(.cannotConnectToHost) }
      switch request.url?.path {
      case "/.well-known/studio/environment":
        return (200, Captured.descriptor(environmentId: "env-1", version: isConnect ? version : 2))
      case "/api/auth/websocket-ticket":
        return (200, #"{"ticket":"tk.sig","expiresAt":"2026-10-18T06:23:32.519Z"}"#)
      default: return (404, "")
      }
    }
    let connector = FakeConnector(socketFailure ? [.fail(.upgradeFailed(status: 503))] : [])
    let connection = MachineConnection(record: record, credentials: support.credentials(),
      http: MachineHTTP(transport: http, now: { MachineConnectionTests.now }), connector: connector,
      configuration: support.configuration(), authorizer: PriorityAuthorizer(signedOut: signedOut))
    return (connection, http, connector)
  }

  @Test func connectWinsEvenWhenTailscaleAlsoAnswers() async throws {
    let (connection, http, connector) = try setup()
    await connection.setActive(true)
    #expect(await eventually { await connection.status.state == .connected })
    #expect(await connection.status.route?.issuer == ConnectAuthorizer.issuer)
    #expect(http.requests.allSatisfy { $0.url?.host == "env-1.tunnels.example.com" })
    #expect(connector.urls.first?.query?.contains("connectionMethod=relay") == true)
    #expect(http.requests(path: "/api/auth/websocket-ticket").first?.value(forHTTPHeaderField: "Authorization") == "DPoP connect-token")
    await connection.setActive(false)
  }

  @Test(arguments: [false, true]) func tailscaleIsFallbackAfterConnectFailure(socketFailure: Bool) async throws {
    let (connection, http, connector) = try setup(connectDown: !socketFailure, socketFailure: socketFailure)
    await connection.setActive(true)
    #expect(await eventually { await connection.status.state == .connected })
    #expect(http.requests.first?.url?.host == "env-1.tunnels.example.com")
    #expect(await connection.status.route?.address == "https://m4.tail1234.ts.net")
    #expect(connector.urls.last?.host == "m4.tail1234.ts.net")
    let direct = http.requests.filter { $0.url?.host == "m4.tail1234.ts.net" }
    #expect(direct.allSatisfy { $0.value(forHTTPHeaderField: "DPoP") == nil })
    #expect(direct.first { $0.url?.path == "/api/auth/websocket-ticket" }?.value(forHTTPHeaderField: "Authorization") == "Bearer tok")
    await connection.setActive(false)
  }

  @Test func accountErrorSurvivesAnUnreachableFallback() async throws {
    let (connection, _, _) = try setup(directDown: true, signedOut: true)
    await connection.setActive(true)
    #expect(await eventually { await connection.status.state == .needsRepair })
    #expect(await connection.status.lastError == .connect(.signedOut))
    await connection.setActive(false)
  }

  @Test func reconnectReturnsToConnectAfterUsingFallback() async throws {
    let (connection, _, _) = try setup(socketFailure: true)
    await connection.setActive(true)
    #expect(await eventually { await connection.status.state == .connected })
    #expect(await connection.status.route?.address == "https://m4.tail1234.ts.net")
    await connection.reconnect()
    #expect(await eventually {
      let status = await connection.status
      return status.state == .connected && status.route?.issuer == ConnectAuthorizer.issuer
    })
    await connection.setActive(false)
  }

  @Test func aValidDirectPairingStillWorksWhenConnectIsSignedOut() async throws {
    let (connection, _, _) = try setup(signedOut: true)
    await connection.setActive(true)
    #expect(await eventually { await connection.status.state == .connected })
    #expect(await connection.status.route?.address == "https://m4.tail1234.ts.net")
    await connection.setActive(false)
  }

  @Test func incompatibleConnectMachineDoesNotTryToBypassTheVersionGate() async throws {
    let (connection, http, _) = try setup(version: 1)
    await connection.setActive(true)
    #expect(await eventually { await connection.status.state == .unsupported })
    #expect(http.requests.allSatisfy { $0.url?.host == "env-1.tunnels.example.com" })
    await connection.setActive(false)
  }
}
