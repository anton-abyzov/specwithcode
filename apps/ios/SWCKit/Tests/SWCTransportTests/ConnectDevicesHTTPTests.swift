import Foundation
import Testing
import SWCWire
@testable import SWCTransport

private struct ApprovalAuthorizer: ConnectAuthorizing {
  let tokens: Recorder<Bool>
  let key = SoftwareDpopKey()

  func credential(for environmentId: String, at route: MachineRoute, refresh: Bool) async throws -> (MachineCredential, any DpopKey) {
    tokens.append(refresh)
    return (MachineCredential(token: refresh ? "fresh-token" : "connect-token", expiresAt: Date().addingTimeInterval(3600), permissions: []), key)
  }
}

@Suite struct ConnectDevicesHTTPTests {
  private static let base = URL(string: "https://machine.example.test")!
  private static let list = #"{"machine":"Test machine","health":"ok","canApprove":true,"canRepair":false,"needsReview":false,"devices":[],"notices":[],"later":["x"],"pending":[{"id":"r1","kind":"connect","label":"Test tablet","shortId":"K3PX","device":"hash","askedAt":"2026-10-18T06:00:00.000Z","expiresAt":"2026-10-18T06:05:00.000Z"}]}"#

  @Test func listIsASignedPostAndDecodesOnlyWhatItShows() async throws {
    let fake = FakeHTTP { _ in (200, Self.list) }
    let http = MachineHTTP(transport: fake, now: { MachineConnectionTests.now })
    let key = SoftwareDpopKey()
    let result = try await http.connectDevicesList(credential: .dpop(token: "tok", key: key), at: Self.base)

    #expect(result.canApprove)
    #expect(result.pending.map(\.label) == ["Test tablet"])
    #expect(result.pending.first?.shortId == "K3PX")
    #expect(result.pending.first?.expiresAt != nil)
    let request = try #require(fake.requests(path: "/api/auth/connect-devices/list").first)
    #expect(request.httpMethod == "POST")
    #expect(String(decoding: try #require(request.httpBody), as: UTF8.self) == "{}")
    #expect(request.value(forHTTPHeaderField: "Authorization") == "DPoP tok")
    #expect(request.value(forHTTPHeaderField: "DPoP") != nil)
    #expect(request.timeoutInterval == 15)
  }

  @Test func aDamagedListCannotApprove() async throws {
    let body = Self.list.replacingOccurrences(of: #""health":"ok""#, with: #""health":"damaged""#)
    let http = MachineHTTP(transport: FakeHTTP { _ in (200, body) })
    #expect(try await http.connectDevicesList(credential: .bearer("tok"), at: Self.base).canApprove == false)
  }

  @Test(arguments: [
    (#"{"status":"approved","device":{"key":"k","kind":"connect","label":"Test tablet","shortId":"K3PX","approvedAt":"2026-10-18T06:00:00.000Z","approvedBy":"x","keptByUpdate":false}}"#, ConnectDeviceApproval.Status.approved),
    (#"{"status":"not-found"}"#, .notFound),
    (#"{"status":"self"}"#, .own),
    (#"{"status":"paused"}"#, .paused),
  ])
  func approveReadsEachStatus(body: String, status: ConnectDeviceApproval.Status) async throws {
    let fake = FakeHTTP { _ in (200, body) }
    let result = try await MachineHTTP(transport: fake).approveConnectDevice(code: "ABC234", credential: .bearer("tok"), at: Self.base)
    #expect(result.status == status)
    if status == .approved {
      #expect(result.deviceLabel == "Test tablet")
      #expect(result.deviceShortId == "K3PX")
    }
    let sent = try #require(fake.requests(path: "/api/auth/connect-devices/approve").first?.httpBody)
    #expect(try JSONDecoder().decode([String: String].self, from: sent) == ["code": "ABC234"])
  }

  private func connected(_ handler: @escaping FakeHTTP.Handler, tokens: Recorder<Bool> = Recorder()) async throws -> (MachineConnection, FakeHTTP) {
    let support = MachineConnectionTests()
    var record = support.record(["https://machine.tail1234.ts.net"])
    record.connectRoute = try #require(ConnectAuthorizer.route(for: ConnectEndpoint(
      httpBaseUrl: "https://env-1.tunnels.example.com", wsBaseUrl: "wss://env-1.tunnels.example.com")))
    let http = FakeHTTP { request in
      if request.url?.path.hasPrefix("/api/auth/connect-devices/") == true { return try await handler(request) }
      switch request.url?.path {
      case "/.well-known/studio/environment":
        // The socket goes direct, so Connect stays the preferred credential only here.
        if request.url?.host == "env-1.tunnels.example.com" { throw URLError(.cannotConnectToHost) }
        return (200, Captured.descriptor(environmentId: "env-1", version: 2))
      case "/api/auth/websocket-ticket":
        return (200, #"{"ticket":"tk.sig","expiresAt":"2026-10-18T06:23:32.519Z"}"#)
      default: return (404, "")
      }
    }
    let connection = MachineConnection(
      record: record,
      credentials: support.credentials(issuers: ["https://machine.tail1234.ts.net"]),
      http: MachineHTTP(transport: http, now: { MachineConnectionTests.now }),
      connector: FakeConnector([]),
      configuration: support.configuration(),
      authorizer: ApprovalAuthorizer(tokens: tokens)
    )
    await connection.setActive(true)
    #expect(await eventually { await connection.status.state == .connected })
    return (connection, http)
  }

  private func list(_ connection: MachineConnection, _ fake: FakeHTTP) async throws -> ConnectDevicesList {
    let http = MachineHTTP(transport: fake, now: { MachineConnectionTests.now })
    return try await connection.withDeviceApprovalCredential { credential, base in
      try await http.connectDevicesList(credential: credential, at: base)
    }
  }

  @Test func prefersTheConnectCredentialWhileTheSocketIsDirect() async throws {
    let (connection, fake) = try await connected { _ in (200, Self.list) }
    defer { Task { await connection.setActive(false) } }
    #expect(await connection.status.route?.issuer != ConnectAuthorizer.issuer)
    _ = try await list(connection, fake)
    let request = try #require(fake.requests(path: "/api/auth/connect-devices/list").first)
    #expect(request.url?.host == "env-1.tunnels.example.com")
    #expect(request.value(forHTTPHeaderField: "Authorization") == "DPoP connect-token")
  }

  @Test func a401OverConnectRefreshesTheCredentialOnce() async throws {
    let tokens = Recorder<Bool>()
    let (connection, fake) = try await connected({ request in
      request.value(forHTTPHeaderField: "Authorization") == "DPoP fresh-token"
        ? (200, Self.list)
        : (401, #"{"code":"auth_invalid","reason":"invalid_credential"}"#)
    }, tokens: tokens)
    defer { Task { await connection.setActive(false) } }
    #expect(try await list(connection, fake).canApprove)
    #expect(tokens.values.suffix(2) == [false, true])
    #expect(await connection.status.state == .connected)
  }

  @Test func fallsBackToTheActiveRoutesCredential() async throws {
    let (connection, fake) = try await connected { request in
      request.url?.host == "env-1.tunnels.example.com" ? (403, #"{"message":"no"}"#) : (200, Self.list)
    }
    defer { Task { await connection.setActive(false) } }
    #expect(try await list(connection, fake).canApprove)
    let direct = try #require(fake.requests(path: "/api/auth/connect-devices/list").last)
    #expect(direct.url?.host == "machine.tail1234.ts.net")
    #expect(direct.value(forHTTPHeaderField: "Authorization") == "Bearer tok")
    #expect(direct.value(forHTTPHeaderField: "DPoP") == nil)
  }

  @Test(arguments: [URLError.Code.timedOut, .networkConnectionLost])
  func aRequestThatMayHaveLandedIsNotReplayedOnAnotherRoute(failure: URLError.Code) async throws {
    let (connection, fake) = try await connected { _ in throw URLError(failure) }
    defer { Task { await connection.setActive(false) } }
    await #expect(throws: TransportError.self) { _ = try await list(connection, fake) }
    #expect(fake.requests(path: "/api/auth/connect-devices/list").count == 1)
  }

  @Test func aConnectOutageIsNotMistakenForADirectRefusal() async throws {
    let (connection, fake) = try await connected { request in
      request.url?.host == "env-1.tunnels.example.com" ? (503, "") : (403, #"{"message":"no"}"#)
    }
    defer { Task { await connection.setActive(false) } }
    await #expect(throws: TransportError.http(status: 503, code: nil)) { _ = try await list(connection, fake) }
  }

  @Test func aRefusalLeavesTheConnectionAlone() async throws {
    let (connection, fake) = try await connected { _ in (403, #"{"message":"no"}"#) }
    defer { Task { await connection.setActive(false) } }
    await #expect(throws: TransportError.self) { _ = try await list(connection, fake) }
    #expect(await connection.status.state == .connected)
    #expect(await connection.status.lastError == nil)
  }

  @Test func offlineThrowsWithoutARequest() async throws {
    let support = MachineConnectionTests()
    let fake = FakeHTTP { _ in (200, Self.list) }
    let connection = MachineConnection(record: support.record(), credentials: support.credentials(), http: MachineHTTP(transport: fake))
    await #expect(throws: TransportError.self) {
      _ = try await connection.withDeviceApprovalCredential { _, _ in 1 }
    }
    #expect(fake.requests.isEmpty)
  }
}
