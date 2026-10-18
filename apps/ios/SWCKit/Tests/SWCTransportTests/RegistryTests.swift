import Foundation
import SWCWire
import Testing
@testable import SWCTransport

@Suite struct RouteKindTests {
  @Test(arguments: [
    ("127.0.0.1", RouteKind.loopback), ("localhost", .loopback), ("::1", .loopback), ("[::1]", .loopback),
    ("192.168.1.5", .lan), ("10.0.0.2", .lan), ("172.20.1.1", .lan), ("m4.local", .lan), ("m4", .lan),
    ("fe80::1", .lan), ("fd12::1", .lan), ("::ffff:192.168.1.5", .lan),
    ("100.101.102.103", .tailnet), ("m4.tail1234.ts.net", .tailnet), ("M4.TAIL1234.TS.NET.", .tailnet), ("fd7a:115c:a1e0::5", .tailnet),
    ("example.com", .public), ("8.8.8.8", .public), ("100.128.0.1", .public), ("2001:4860::8888", .public),
  ])
  func classifies(_ host: String, _ kind: RouteKind) {
    #expect(RouteKind.classify(host: host) == kind)
  }

  @Test func routeDerivesKindAndWsBase() throws {
    let route = try #require(MachineRoute(httpBase: "https://m4.tail1234.ts.net:8443/some/path"))
    #expect(route.httpBase.absoluteString == "https://m4.tail1234.ts.net:8443/")
    #expect(route.wsBase.absoluteString == "wss://m4.tail1234.ts.net:8443/")
    #expect(route.kind == .tailnet)
    #expect(route.learned == false)
    #expect(route.address == "https://m4.tail1234.ts.net:8443")
  }

  @Test func ranksFastestKindFirstKeepingSavedOrder() throws {
    let record = MachineRecord(environmentId: "env", label: "M4", routes: [
      try #require(MachineRoute(httpBase: "https://m4.example.com")),
      try #require(MachineRoute(httpBase: "https://m4.tail1234.ts.net")),
      try #require(MachineRoute(httpBase: "http://192.168.1.21:8319", learned: true)),
      try #require(MachineRoute(httpBase: "http://192.168.1.20:8319")),
      try #require(MachineRoute(httpBase: "http://100.64.0.9:8319")),
    ])
    #expect(record.rankedRoutes.map(\.address) == [
      "http://192.168.1.20:8319",
      "http://192.168.1.21:8319",
      "https://m4.tail1234.ts.net",
      "http://100.64.0.9:8319",
      "https://m4.example.com",
    ])
  }
}

@Suite struct LearnedRouteTests {
  static let issuer = "https://m4.tail1234.ts.net"

  func record() throws -> MachineRecord {
    MachineRecord(environmentId: "env", label: "M4", routes: [try #require(MachineRoute(httpBase: "https://m4.tail1234.ts.net"))])
  }

  @Test func addsReportedAddressesAsLearnedRoutes() throws {
    var record = try record()
    let changed = record.mergeLearnedRoutes([
      "http://192.168.1.20:8319/",
      "http://100.64.0.5:8319",
      "http://127.0.0.1:8319/",
      "ftp://192.168.1.20",
      "not a url",
      "http://192.168.1.20:8319",
    ], issuer: Self.issuer)
    #expect(changed)
    #expect(record.routes.map(\.address) == ["https://m4.tail1234.ts.net", "http://192.168.1.20:8319", "http://100.64.0.5:8319"])
    #expect(record.routes.map(\.learned) == [false, true, true])
    #expect(record.routes.map(\.issuer) == [Self.issuer, Self.issuer, Self.issuer])
    #expect(record.rankedRoutes.first?.address == "http://192.168.1.20:8319")
    #expect(record.routes[1].kind == .lan)
    #expect(record.routes[1].wsBase.absoluteString == "ws://192.168.1.20:8319/")
  }

  @Test func dropsLearnedRoutesNoLongerReportedAndKeepsSavedOnes() throws {
    var record = try record()
    record.mergeLearnedRoutes(["http://192.168.1.20:8319", "http://100.64.0.5:8319"], issuer: Self.issuer)
    let replaced = record.mergeLearnedRoutes(["http://192.168.1.30:8319"], issuer: Self.issuer)
    #expect(replaced)
    #expect(record.routes.map(\.address) == ["https://m4.tail1234.ts.net", "http://192.168.1.30:8319"])
    #expect(record.mergeLearnedRoutes(["http://192.168.1.30:8319"], issuer: Self.issuer) == false)
    let cleared = record.mergeLearnedRoutes([], issuer: Self.issuer)
    #expect(cleared)
    #expect(record.routes.map(\.address) == ["https://m4.tail1234.ts.net"])
  }

  @Test func doesNotLearnAnAddressAlreadySaved() throws {
    var record = try record()
    #expect(record.mergeLearnedRoutes(["https://m4.tail1234.ts.net/"], issuer: Self.issuer) == false)
    #expect(record.routes.count == 1)
    #expect(record.routes[0].learned == false)
  }

  @Test func pairingAnAddressMakesItSaved() throws {
    var record = try record()
    record.mergeLearnedRoutes(["http://192.168.1.20:8319"], issuer: Self.issuer)
    record.upsertRoute(try #require(MachineRoute(httpBase: "http://192.168.1.20:8319")))
    #expect(record.routes.map(\.learned) == [false, false])
    #expect(record.routes.map(\.issuer) == [Self.issuer, "http://192.168.1.20:8319"])
    #expect(record.mergeLearnedRoutes([], issuer: Self.issuer) == false)
  }

  @Test func eachIssuerManagesOnlyItsOwnLearnedRoutes() throws {
    var record = try record()
    let other = "https://evil.example"
    record.upsertRoute(try #require(MachineRoute(httpBase: other)))
    record.mergeLearnedRoutes(["http://192.168.1.20:8319"], issuer: Self.issuer)
    record.mergeLearnedRoutes(["http://10.9.9.9:8319"], issuer: other)
    #expect(record.routes.map(\.address) == ["https://m4.tail1234.ts.net", other, "http://192.168.1.20:8319", "http://10.9.9.9:8319"])
    #expect(record.routes.map(\.issuer) == [Self.issuer, other, Self.issuer, other])

    // One issuer reporting nothing leaves the other's learned routes alone.
    record.mergeLearnedRoutes([], issuer: other)
    #expect(record.routes.map(\.address) == ["https://m4.tail1234.ts.net", other, "http://192.168.1.20:8319"])

    // An address the current socket reports uses that socket's issuer.
    record.mergeLearnedRoutes(["http://192.168.1.20:8319"], issuer: other)
    #expect(record.routes.last?.issuer == other)
  }

  @Test func recordsWithoutAnIssuerDecodeWithTheirOwnAddress() throws {
    let json = #"{"httpBase":"http://192.168.1.21:8319/","wsBase":"ws://192.168.1.21:8319/","kind":"lan","learned":true}"#
    let route = try WireCoding.decoder.decode(MachineRoute.self, from: Data(json.utf8))
    #expect(route.issuer == "http://192.168.1.21:8319")
    let encoded = try JSONDecoder().decode(JSONValue.self, from: WireCoding.encoder.encode(route))
    #expect(encoded["issuer"] == .string("http://192.168.1.21:8319"))
  }

  @Test func ignoresReportedHostsNoURLCanCarry() throws {
    var record = try record()
    #expect(record.mergeLearnedRoutes(["http://a%20b:8319/", "http://a%5Bb/", "http://a%2Fb%40evil.com/"], issuer: Self.issuer) == false)
    #expect(record.routes.map(\.address) == ["https://m4.tail1234.ts.net"])
  }
}

@Suite struct MachineRegistryTests {
  func tempFile() -> URL {
    FileManager.default.temporaryDirectory
      .appendingPathComponent("swc-registry-\(UUID().uuidString)", isDirectory: true)
      .appendingPathComponent("machines.json")
  }

  @Test func persistsAtomicallyAndReloads() async throws {
    let url = tempFile()
    defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
    let registry = MachineRegistry(fileURL: url)
    #expect(await registry.all().isEmpty)

    let route = try #require(MachineRoute(httpBase: "https://m4.tail1234.ts.net"))
    try await registry.recordPairing(environmentId: "env-1", label: "M4", route: route)
    try await registry.recordPairing(environmentId: "env-2", label: "M1", route: try #require(MachineRoute(httpBase: "http://192.168.1.20:8319")))
    try await registry.setLastShellSequence(42, for: "env-1")
    try await registry.mergeLearnedRoutes(["http://192.168.1.10:8319"], issuer: "https://m4.tail1234.ts.net", for: "env-1")
    try await registry.setEnabled(false, for: "env-2")

    let reloaded = MachineRegistry(fileURL: url)
    let machines = await reloaded.all()
    #expect(machines.map(\.environmentId) == ["env-1", "env-2"])
    #expect(machines[0].lastShellSequence == 42)
    #expect(machines[0].routes.count == 2)
    #expect(machines[0].routes[1].learned)
    #expect(machines[0].routes[1].issuer == "https://m4.tail1234.ts.net")
    #expect(machines[1].enabled == false)

    // Pairing a known machine again adds the route and re-enables it.
    try await reloaded.recordPairing(environmentId: "env-2", label: "M1 Studio", route: try #require(MachineRoute(httpBase: "https://m1.tail1234.ts.net")))
    let m1 = try #require(await reloaded.machine("env-2"))
    #expect(m1.label == "M1 Studio")
    #expect(m1.enabled)
    #expect(m1.routes.count == 2)

    try await reloaded.remove("env-1")
    #expect(await MachineRegistry(fileURL: url).all().map(\.environmentId) == ["env-2"])
  }

  @Test func writesTheDocumentedShape() async throws {
    let url = tempFile()
    defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
    let registry = MachineRegistry(fileURL: url)
    try await registry.recordPairing(environmentId: "env-1", label: "M4", route: try #require(MachineRoute(httpBase: "http://192.168.1.20:8319")))
    let value = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url))
    guard case let .array(list) = value, let first = list.first else {
      Issue.record("Expected a JSON array")
      return
    }
    #expect(first["environmentId"] == .string("env-1"))
    #expect(first["label"] == .string("M4"))
    #expect(first["enabled"] == .bool(true))
    #expect(first["lastShellSequence"] == nil)
    let route = try #require(first["routes"].flatMap { if case let .array(r) = $0 { r.first } else { nil } })
    #expect(route["httpBase"] == .string("http://192.168.1.20:8319/"))
    #expect(route["wsBase"] == .string("ws://192.168.1.20:8319/"))
    #expect(route["kind"] == .string("lan"))
    #expect(route["learned"] == .bool(false))
  }

  @Test func unreadableFileIsAnEmptyList() async throws {
    let url = tempFile()
    defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data("{not json".utf8).write(to: url)
    #expect(await MachineRegistry(fileURL: url).all().isEmpty)
  }
}

@Suite struct CredentialTests {
  @Test func inMemoryStoreKeepsOneTokenPerIssuer() throws {
    let store = InMemoryCredentialStore()
    #expect(try store.credential(for: "env", issuer: "http://192.168.1.20:8319") == nil)
    let lan = MachineCredential(token: "lan", expiresAt: Date(timeIntervalSince1970: 1_800_000_000), permissions: ["orchestration:read"])
    let other = MachineCredential(token: "other", expiresAt: Date(timeIntervalSince1970: 1_800_000_000), permissions: [])
    try store.save(lan, for: "env", issuer: "http://192.168.1.20:8319")
    try store.save(other, for: "env", issuer: "https://evil.example")
    #expect(try store.credential(for: "env", issuer: "http://192.168.1.20:8319") == lan)
    #expect(try store.credential(for: "env", issuer: "https://evil.example") == other)
    try store.remove(for: "env")
    #expect(try store.credential(for: "env", issuer: "http://192.168.1.20:8319") == nil)
    #expect(try store.credential(for: "env", issuer: "https://evil.example") == nil)
  }

  @Test func bestCredentialFollowsRouteRank() throws {
    let record = MachineRecord(environmentId: "env", label: "M4", routes: [
      try #require(MachineRoute(httpBase: "https://m4.tail1234.ts.net")),
      try #require(MachineRoute(httpBase: "http://192.168.1.20:8319")),
    ])
    let now = Date(timeIntervalSince1970: 1_000_000)
    let expired = MachineCredential(token: "lan", expiresAt: now.addingTimeInterval(-1), permissions: [])
    let valid = MachineCredential(token: "tailnet", expiresAt: now.addingTimeInterval(86_400), permissions: [])
    let store = InMemoryCredentialStore([
      CredentialKey(environmentId: "env", issuer: "http://192.168.1.20:8319"): expired,
      CredentialKey(environmentId: "env", issuer: "https://m4.tail1234.ts.net"): valid,
    ])
    #expect(store.bestCredential(for: record, now: now) == valid)
    #expect(InMemoryCredentialStore([CredentialKey(environmentId: "env", issuer: "http://192.168.1.20:8319"): expired]).bestCredential(for: record, now: now) == expired)
  }

  @Test func legacyTokenIsAdoptedUnderAnIssuer() throws {
    let credential = MachineCredential(token: "old", expiresAt: Date(timeIntervalSince1970: 1_800_000_000), permissions: [])
    let store = InMemoryCredentialStore(legacy: ["env": credential])
    #expect(try store.adoptLegacyCredential(for: "env", issuer: "http://192.168.1.20:8319") == credential)
    #expect(try store.credential(for: "env", issuer: "http://192.168.1.20:8319") == credential)
    #expect(try store.adoptLegacyCredential(for: "env", issuer: "https://evil.example") == nil)
  }

  @Test func keychainAccountsBindTheIssuer() {
    #expect(KeychainCredentialStore.account("env-1", "http://192.168.1.20:8319") == "env-1 http://192.168.1.20:8319")
  }

  @Test func encodesTokenExpiryAndPermissions() throws {
    let credential = MachineCredential(token: "tok", expiresAt: Date(timeIntervalSince1970: 1_794_896_312.5), permissions: ["orchestration:read", "orchestration:operate"])
    let value = try JSONDecoder().decode(JSONValue.self, from: WireCoding.encoder.encode(credential))
    #expect(value == .object([
      "token": .string("tok"),
      "expiresAt": .string("2026-11-17T06:18:32.500Z"),
      "permissions": .array([.string("orchestration:read"), .string("orchestration:operate")]),
    ]))
    #expect(try WireCoding.decoder.decode(MachineCredential.self, from: WireCoding.encoder.encode(credential)) == credential)
  }

  @Test func countsDaysLeft() {
    let now = Date(timeIntervalSince1970: 1_000_000)
    let credential = MachineCredential(token: "t", expiresAt: now.addingTimeInterval(4.5 * 86_400), permissions: [])
    #expect(credential.daysLeft(now: now) == 4)
    #expect(credential.isExpired(now: now) == false)
    #expect(credential.daysLeft(now: now.addingTimeInterval(10 * 86_400)) == 0)
    #expect(credential.isExpired(now: now.addingTimeInterval(10 * 86_400)))
  }
}
