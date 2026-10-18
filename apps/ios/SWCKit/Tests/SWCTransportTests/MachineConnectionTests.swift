import Foundation
import Testing
@testable import SWCTransport

@Suite struct MachineConnectionTests {
  static let environmentId = "env-1"
  static let now = Date(timeIntervalSince1970: 1_792_304_312)

  struct Server: Sendable {
    var descriptor: @Sendable (URL) -> (Int, String) = { _ in (200, Captured.descriptor(environmentId: MachineConnectionTests.environmentId, version: 2)) }
    var ticket: @Sendable () -> (Int, String) = { (200, #"{"ticket":"tk.sig","expiresAt":"2026-10-18T06:23:32.519Z"}"#) }
    var session: @Sendable () -> (Int, String) = { (200, Captured.session) }
  }

  func http(_ server: Server) -> FakeHTTP {
    FakeHTTP { request in
      switch request.url?.path {
      case "/.well-known/studio/environment": server.descriptor(request.url!)
      case "/api/auth/websocket-ticket": server.ticket()
      case "/api/auth/session": server.session()
      default: (404, "")
      }
    }
  }

  func record(_ addresses: [String] = ["http://192.168.1.20:8319"]) -> MachineRecord {
    MachineRecord(environmentId: Self.environmentId, label: "M4", routes: addresses.compactMap { MachineRoute(httpBase: $0) })
  }

  /// A token issued by each of the addresses the tests pair.
  func credentials(daysLeft: Double = 12.5, issuers: [String] = ["http://192.168.1.20:8319", "https://m4.tail1234.ts.net"]) -> InMemoryCredentialStore {
    let credential = MachineCredential(token: "tok", expiresAt: Self.now.addingTimeInterval(daysLeft * 86_400), permissions: ["orchestration:read"])
    return InMemoryCredentialStore(Dictionary(uniqueKeysWithValues: issuers.map { (CredentialKey(environmentId: Self.environmentId, issuer: $0), credential) }))
  }

  func configuration(delays: Recorder<Duration> = Recorder()) -> MachineConnection.Configuration {
    MachineConnection.Configuration(
      probeStagger: .milliseconds(20),
      stableConnection: .zero,
      sleepBeforeRetry: { delay in
        delays.append(delay)
        await Task.yield()
      },
      random: { 0.5 },
      now: { MachineConnectionTests.now }
    )
  }

  func wait(for state: MachineConnection.State, on connection: MachineConnection) async -> Bool {
    await eventually { await connection.status.state == state }
  }

  @Test func connectsOverTheFirstRouteThatAnswersAsTheMachine() async throws {
    let server = Server(descriptor: { url in
      url.host() == "192.168.1.20"
        ? (200, Captured.descriptor(environmentId: "someone-else", version: 2))
        : (200, Captured.descriptor(environmentId: MachineConnectionTests.environmentId, version: 2))
    })
    let fake = http(server)
    let connector = FakeConnector()
    let connection = MachineConnection(
      record: record(["https://m4.tail1234.ts.net", "http://192.168.1.20:8319"]),
      credentials: credentials(),
      http: MachineHTTP(transport: fake, now: { Self.now }),
      connector: connector,
      configuration: configuration()
    )
    let sockets = await connection.connectedSockets()
    await connection.setActive(true)
    #expect(await wait(for: .connected, on: connection))

    let status = await connection.status
    #expect(status.route?.address == "https://m4.tail1234.ts.net")
    #expect(status.descriptor?.environmentId == Self.environmentId)
    #expect(status.tokenDaysLeft == 12)
    #expect(status.lastError == nil)
    #expect(connector.urls.map(\.absoluteString) == ["wss://m4.tail1234.ts.net/ws?wsTicket=tk.sig&orchestrationProtocol=2&clientSurface=mobile&clientOs=iOS&clientDeviceType=phone&connectionMethod=direct"])
    #expect(fake.requests(path: "/api/auth/websocket-ticket").first?.value(forHTTPHeaderField: "Authorization") == "Bearer tok")

    var iterator = sockets.makeAsyncIterator()
    let socket = try #require(await iterator.next())
    #expect(socket === (await connection.socket))
    #expect(await connection.tokenDaysLeft() == 12)
    await connection.setActive(false)
  }

  @Test func socketURLEncodesTheTicket() throws {
    let url = try #require(MachineConnection.socketURL(wsBase: URL(string: "ws://192.168.1.20:8319/")!, ticket: "a+b/c=="))
    #expect(url.absoluteString == "ws://192.168.1.20:8319/ws?wsTicket=a%2Bb%2Fc%3D%3D&orchestrationProtocol=2&clientSurface=mobile&clientOs=iOS&clientDeviceType=phone&connectionMethod=direct")
  }

  @Test func rejectedTicketNeedsRepair() async throws {
    let fake = http(Server(ticket: { (401, Captured.invalidCredential) }))
    let connector = FakeConnector()
    let connection = MachineConnection(record: record(), credentials: credentials(), http: MachineHTTP(transport: fake), connector: connector, configuration: configuration())
    await connection.setActive(true)
    #expect(await wait(for: .needsRepair, on: connection))
    #expect(await connection.status.lastError == .needsRepair)
    #expect(connector.urls.isEmpty)
    // It stays put instead of retrying.
    try await Task.sleep(for: .milliseconds(50))
    #expect(fake.requests(path: "/api/auth/websocket-ticket").count == 1)
    await connection.setActive(false)
  }

  @Test func missingOrExpiredTokenNeedsRepair() async throws {
    let fake = http(Server())
    let missing = MachineConnection(record: record(), credentials: InMemoryCredentialStore(), http: MachineHTTP(transport: fake), connector: FakeConnector(), configuration: configuration())
    await missing.setActive(true)
    #expect(await wait(for: .needsRepair, on: missing))
    await missing.setActive(false)

    let expired = MachineConnection(record: record(), credentials: credentials(daysLeft: -1), http: MachineHTTP(transport: fake), connector: FakeConnector(), configuration: configuration())
    await expired.setActive(true)
    #expect(await wait(for: .needsRepair, on: expired))
    #expect(await expired.tokenDaysLeft() == 0)
    await expired.setActive(false)
  }

  @Test func refusedUpgradeWithARevokedSessionNeedsRepair() async throws {
    let fake = http(Server(session: { (200, Captured.anonymousSession) }))
    let connector = FakeConnector([.fail(.upgradeFailed(status: 401))])
    let connection = MachineConnection(record: record(), credentials: credentials(), http: MachineHTTP(transport: fake), connector: connector, configuration: configuration())
    await connection.setActive(true)
    #expect(await wait(for: .needsRepair, on: connection))
    #expect(fake.requests(path: "/api/auth/session").count == 1)
    await connection.setActive(false)
  }

  @Test func refusedUpgradeWithAValidSessionRetries() async throws {
    let fake = http(Server())
    let delays = Recorder<Duration>()
    let connector = FakeConnector([.fail(.upgradeFailed(status: 503))])
    let connection = MachineConnection(record: record(), credentials: credentials(), http: MachineHTTP(transport: fake), connector: connector, configuration: configuration(delays: delays))
    let updates = await connection.statusUpdates()
    await connection.setActive(true)
    #expect(await wait(for: .connected, on: connection))
    #expect(delays.values == [.milliseconds(500)])
    #expect(connector.urls.count == 2)

    await connection.setActive(false)
    var states: [MachineConnection.State] = []
    var errors: [TransportError?] = []
    for await status in updates {
      states.append(status.state)
      errors.append(status.lastError)
      if status.state == .offline, states.contains(.connected) { break }
    }
    #expect(states.first == .offline)
    #expect(states.contains(.connecting))
    #expect(errors.contains(.upgradeFailed(status: 503)))
    #expect(states.firstIndex(of: .connected)! > states.firstIndex(of: .connecting)!)
  }

  @Test func incompatibleServerIsUnsupported() async throws {
    let fake = http(Server(descriptor: { _ in (200, Captured.descriptor(environmentId: MachineConnectionTests.environmentId, version: 1)) }))
    let connector = FakeConnector()
    let connection = MachineConnection(record: record(), credentials: credentials(), http: MachineHTTP(transport: fake), connector: connector, configuration: configuration())
    await connection.setActive(true)
    #expect(await wait(for: .unsupported, on: connection))
    let status = await connection.status
    guard case let .serverTooOld(descriptor)? = status.lastError else {
      Issue.record("Expected serverTooOld, got \(String(describing: status.lastError))")
      return
    }
    #expect(descriptor.protocolVersion == 1)
    #expect(status.descriptor?.protocolVersion == 1)
    #expect(connector.urls.isEmpty)
    await connection.setActive(false)
  }

  @Test func backoffGrowsAndResetsAfterAConnection() async throws {
    let fake = http(Server())
    let delays = Recorder<Duration>()
    let first = ScriptedConnection(responder: ScriptedConnection.pongs)
    let connector = FakeConnector([
      .fail(.unreachable("down")),
      .fail(.timedOut),
      .connect(first),
      .fail(.unreachable("down again")),
    ])
    let connection = MachineConnection(record: record(), credentials: credentials(), http: MachineHTTP(transport: fake), connector: connector, configuration: configuration(delays: delays))
    let sockets = await connection.connectedSockets()
    var socketIterator = sockets.makeAsyncIterator()

    await connection.setActive(true)
    let firstSocket = try #require(await socketIterator.next())
    #expect(delays.values == [.milliseconds(500), .seconds(1)])
    #expect(await connection.status.state == .connected)

    first.close()
    let secondSocket = try #require(await socketIterator.next())
    #expect(firstSocket !== secondSocket)
    #expect(delays.values == [.milliseconds(500), .seconds(1), .milliseconds(500)])
    #expect(connector.urls.count == 5)
    await connection.setActive(false)
  }

  @Test func shortLivedConnectionsBackOff() async throws {
    let fake = http(Server())
    let delays = Recorder<Duration>()
    var config = configuration(delays: delays)
    config.stableConnection = .seconds(60)
    let first = ScriptedConnection(responder: ScriptedConnection.pongs)
    let second = ScriptedConnection(responder: ScriptedConnection.pongs)
    let connector = FakeConnector([.connect(first), .connect(second)])
    let connection = MachineConnection(record: record(), credentials: credentials(), http: MachineHTTP(transport: fake), connector: connector, configuration: config)
    await connection.setActive(true)
    #expect(await wait(for: .connected, on: connection))
    first.close()
    #expect(await eventually { connector.urls.count == 2 })
    #expect(await wait(for: .connected, on: connection))
    second.close()
    #expect(await eventually { connector.urls.count == 3 })
    #expect(delays.values == [.milliseconds(500), .seconds(1)])
    await connection.setActive(false)
  }

  @Test func backgroundClosesAndForegroundReconnectsAtOnce() async throws {
    let fake = http(Server())
    let delays = Recorder<Duration>()
    let connector = FakeConnector()
    let connection = MachineConnection(record: record(), credentials: credentials(), http: MachineHTTP(transport: fake), connector: connector, configuration: configuration(delays: delays))
    await connection.setActive(true)
    #expect(await wait(for: .connected, on: connection))
    let firstConnection = try #require(connector.connections.first)

    await connection.setActive(false)
    #expect(await connection.status.state == .offline)
    #expect(await connection.socket == nil)
    #expect(await eventually { firstConnection.isClosed })

    await connection.setActive(true)
    #expect(await wait(for: .connected, on: connection))
    #expect(connector.connections.count == 2)
    #expect(delays.values.isEmpty)
    // The ticket is reused while it is fresh.
    #expect(fake.requests(path: "/api/auth/websocket-ticket").count == 1)
    await connection.setActive(false)
  }

  @Test func revokedSessionFoundLaterNeedsRepair() async throws {
    let revoked = Recorder<Bool>()
    let fake = http(Server(session: { revoked.values.last == true ? (401, Captured.invalidCredential) : (200, Captured.session) }))
    let connector = FakeConnector()
    let connection = MachineConnection(record: record(), credentials: credentials(), http: MachineHTTP(transport: fake), connector: connector, configuration: configuration())
    await connection.setActive(true)
    #expect(await wait(for: .connected, on: connection))
    await connection.verifySession()
    #expect(await connection.status.state == .connected)

    revoked.append(true)
    await connection.verifySession()
    #expect(await connection.status.state == .needsRepair)
    #expect(await eventually { connector.connections.first?.isClosed == true })

    // After pairing again, reconnect clears it.
    revoked.append(false)
    await connection.reconnect()
    #expect(await wait(for: .connected, on: connection))
    #expect(connector.connections.count == 2)
    await connection.setActive(false)
  }

  @Test func disabledMachineStaysOffline() async throws {
    let fake = http(Server())
    let connector = FakeConnector()
    var disabled = record()
    disabled.enabled = false
    let connection = MachineConnection(record: disabled, credentials: credentials(), http: MachineHTTP(transport: fake), connector: connector, configuration: configuration())
    await connection.setActive(true)
    try await Task.sleep(for: .milliseconds(50))
    #expect(await connection.status.state == .offline)
    #expect(connector.urls.isEmpty)

    disabled.enabled = true
    await connection.update(disabled)
    #expect(await wait(for: .connected, on: connection))
    await connection.setActive(false)
  }

  /// A machine at `real` and an attacker at `evil` that claims the same environment id.
  func spoofedServer(realAnswers: @escaping @Sendable () -> Bool) -> FakeHTTP {
    FakeHTTP { request in
      let isReal = request.url?.host() == "192.168.1.20"
      if isReal, !realAnswers() { throw URLError(.cannotConnectToHost) }
      switch request.url?.path {
      case "/.well-known/studio/environment": return (200, Captured.descriptor(environmentId: MachineConnectionTests.environmentId, version: 2))
      case "/api/auth/websocket-ticket": return (200, isReal ? #"{"ticket":"real.sig","expiresAt":"2026-10-18T06:23:32.519Z"}"# : #"{"ticket":"evil.sig","expiresAt":"2026-10-18T06:23:32.519Z"}"#)
      case "/api/auth/session": return (200, Captured.session)
      default: return (404, "")
      }
    }
  }

  func bearers(_ fake: FakeHTTP, host: String) -> Set<String> {
    Set(fake.requests.filter { $0.url?.host() == host }.compactMap { $0.value(forHTTPHeaderField: "Authorization") })
  }

  @Test func eachRouteGetsOnlyTheTokenItsAddressIssued() async throws {
    // The attacker's address was paired first with a junk token, then the real machine.
    let credential = { (token: String) in MachineCredential(token: token, expiresAt: Self.now.addingTimeInterval(86_400), permissions: []) }
    let store = InMemoryCredentialStore([
      CredentialKey(environmentId: Self.environmentId, issuer: "https://evil.example"): credential("junk"),
      CredentialKey(environmentId: Self.environmentId, issuer: "http://192.168.1.20:8319"): credential("real"),
    ])
    let realAnswers = Recorder<Bool>()
    let fake = spoofedServer(realAnswers: { realAnswers.values.last ?? false })
    let connector = FakeConnector()
    let connection = MachineConnection(
      record: record(["https://evil.example", "http://192.168.1.20:8319"]),
      credentials: store,
      http: MachineHTTP(transport: fake, now: { Self.now }),
      connector: connector,
      configuration: configuration()
    )

    // Away from home the attacker answers first: it gets its own junk token only.
    await connection.setActive(true)
    #expect(await wait(for: .connected, on: connection))
    #expect(await connection.status.route?.address == "https://evil.example")
    #expect(bearers(fake, host: "evil.example") == ["Bearer junk"])
    #expect(connector.urls.last?.absoluteString.contains("wsTicket=evil.sig") == true)

    // At home the real machine answers: only it gets the real token, and the
    // attacker's cached ticket is not reused for it.
    await connection.setActive(false)
    realAnswers.append(true)
    await connection.setActive(true)
    #expect(await wait(for: .connected, on: connection))
    #expect(await connection.status.route?.address == "http://192.168.1.20:8319")
    #expect(bearers(fake, host: "192.168.1.20") == ["Bearer real"])
    #expect(bearers(fake, host: "evil.example") == ["Bearer junk"])
    #expect(connector.urls.last?.absoluteString.contains("wsTicket=real.sig") == true)

    // A revoke check after an authorization error asks the route in use with its own token.
    await connection.verifySession()
    #expect(bearers(fake, host: "evil.example") == ["Bearer junk"])
    await connection.setActive(false)
  }

  @Test func aRouteWithoutItsOwnTokenIsNeverContacted() async throws {
    let store = InMemoryCredentialStore([
      CredentialKey(environmentId: Self.environmentId, issuer: "http://192.168.1.20:8319"): MachineCredential(token: "real", expiresAt: Self.now.addingTimeInterval(86_400), permissions: []),
    ])
    let fake = spoofedServer(realAnswers: { true })
    let connector = FakeConnector()
    let connection = MachineConnection(record: record(["https://evil.example", "http://192.168.1.20:8319"]), credentials: store, http: MachineHTTP(transport: fake, now: { Self.now }), connector: connector, configuration: configuration())
    await connection.setActive(true)
    #expect(await wait(for: .connected, on: connection))
    #expect(fake.requests.allSatisfy { $0.url?.host() == "192.168.1.20" })
    await connection.setActive(false)

    // No route holding its own token: pair again.
    let orphan = MachineConnection(record: record(["https://evil.example"]), credentials: store, http: MachineHTTP(transport: fake, now: { Self.now }), connector: FakeConnector(), configuration: configuration())
    await orphan.setActive(true)
    #expect(await wait(for: .needsRepair, on: orphan))
    await orphan.setActive(false)
  }

  @Test func learnedRoutesUseTheirIssuersToken() async throws {
    var record = record(["https://m4.tail1234.ts.net"])
    record.mergeLearnedRoutes(["http://192.168.1.20:8319"], issuer: "https://m4.tail1234.ts.net")
    let store = InMemoryCredentialStore([
      CredentialKey(environmentId: Self.environmentId, issuer: "https://m4.tail1234.ts.net"): MachineCredential(token: "tailnet", expiresAt: Self.now.addingTimeInterval(86_400), permissions: []),
    ])
    let fake = http(Server())
    let connection = MachineConnection(record: record, credentials: store, http: MachineHTTP(transport: fake, now: { Self.now }), connector: FakeConnector(), configuration: configuration())
    await connection.setActive(true)
    #expect(await wait(for: .connected, on: connection))
    #expect(await connection.status.route?.address == "http://192.168.1.20:8319")
    #expect(fake.requests(path: "/api/auth/websocket-ticket").first?.value(forHTTPHeaderField: "Authorization") == "Bearer tailnet")
    let socket = try #require(await connection.socket)
    #expect(await connection.route(of: socket)?.issuer == "https://m4.tail1234.ts.net")
    await connection.setActive(false)
  }

  @Test func backoffDelaysStayInRange() {
    let backoff = MachineConnection.Backoff()
    #expect(backoff.delay(afterFailures: 1, random: 0.5) == .milliseconds(500))
    #expect(backoff.delay(afterFailures: 1, random: 0) == .milliseconds(500))
    #expect(backoff.delay(afterFailures: 2, random: 0.5) == .seconds(1))
    #expect(backoff.delay(afterFailures: 3, random: 0.5) == .seconds(2))
    #expect(backoff.delay(afterFailures: 20, random: 0.99) == .seconds(30))
    #expect(backoff.delay(afterFailures: 20, random: 0) == .seconds(24))
    let jittered = backoff.delay(afterFailures: 4, random: 0.9)
    #expect(jittered > .seconds(4) && jittered <= .seconds(4.8))
  }
}
