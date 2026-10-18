import Foundation
import Testing
@testable import SWCTransport

// Bodies are the ones captured from a 1.0.43 server.
enum Captured {
  static let descriptor = #"{"environmentId":"caed14a8-c16c-43ea-89d1-29cd01b88336","label":"Wire Probe","platform":{"os":"darwin","arch":"arm64","machine":"laptop"},"serverVersion":"1.0.43","orchestrationProtocolVersion":2,"capabilities":{"repositoryIdentity":true,"threadPinning":true,"fileAttachments":{"maxUploadBytes":52428800}}}"#
  static let token = #"{"access_token":"eyJ2IjoxfQ.sig","issued_token_type":"urn:ietf:params:oauth:token-type:access_token","token_type":"Bearer","expires_in":2592000,"scope":"orchestration:read orchestration:operate settings:write"}"#
  static let invalidCredential = #"{"_tag":"EnvironmentAuthInvalidError","code":"auth_invalid","reason":"invalid_credential","traceId":"d878879a261189aa1061b3dca19f8f2f"}"#
  static let missingCredential = #"{"_tag":"EnvironmentAuthInvalidError","code":"auth_invalid","reason":"missing_credential","traceId":"90f1cd790b04104728dfa96611220e65"}"#
  static let ticket = #"{"ticket":"eyJ2IjoxLCJraW5kIjoid2Vic29ja2V0In0.6FwXkoc6y4G9","expiresAt":"2026-10-18T06:23:32.519Z"}"#
  static let session = #"{"authenticated":true,"auth":{"policy":"loopback-browser"},"scopes":["orchestration:read","orchestration:operate"],"permissions":["orchestration:read","orchestration:operate","settings:write"],"sessionMethod":"bearer-access-token","expiresAt":"2026-11-17T06:18:32.514Z"}"#
  static let anonymousSession = #"{"authenticated":false,"auth":{"policy":"loopback-browser","bootstrapMethods":["one-time-token"]}}"#

  static func descriptor(environmentId: String = "caed14a8-c16c-43ea-89d1-29cd01b88336", version: Int?) -> String {
    let versionField = version.map { #","orchestrationProtocolVersion":\#($0)"# } ?? ""
    return #"{"environmentId":"\#(environmentId)","label":"Wire Probe","platform":{"os":"darwin","arch":"arm64"},"serverVersion":"1.0.43"\#(versionField),"capabilities":{}}"#
  }
}

@Suite struct MachineHTTPTests {
  let base = URL(string: "http://127.0.0.1:8431/")!

  @Test func fetchesDescriptorWithAFiveSecondTimeout() async throws {
    let fake = FakeHTTP { _ in (200, Captured.descriptor) }
    let descriptor = try await MachineHTTP(transport: fake).descriptor(at: base)
    #expect(descriptor.environmentId == "caed14a8-c16c-43ea-89d1-29cd01b88336")
    #expect(descriptor.label == "Wire Probe")
    #expect(descriptor.serverVersion == "1.0.43")
    #expect(descriptor.protocolVersion == 2)
    #expect(descriptor.platformLabel == "macOS · arm64")
    let request = try #require(fake.requests.first)
    #expect(request.url?.absoluteString == "http://127.0.0.1:8431/.well-known/studio/environment")
    #expect(request.httpMethod == "GET")
    #expect(request.timeoutInterval == 5)
    #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
  }

  @Test func missingVersionMeansProtocolOneAndAnOldServer() async throws {
    let fake = FakeHTTP { _ in (200, Captured.descriptor(version: nil)) }
    await #expect(throws: TransportError.serverTooOld(EnvironmentDescriptorLite(environmentId: "caed14a8-c16c-43ea-89d1-29cd01b88336", label: "Wire Probe", serverVersion: "1.0.43", orchestrationProtocolVersion: nil, platform: .init(os: "darwin", arch: "arm64")))) {
      try await MachineHTTP(transport: fake).descriptor(at: base)
    }
  }

  @Test func newerServerMeansTheAppIsTooOld() async throws {
    let fake = FakeHTTP { _ in (200, Captured.descriptor(version: 3)) }
    do {
      _ = try await MachineHTTP(transport: fake).descriptor(at: base)
      Issue.record("Expected appTooOld")
    } catch let TransportError.appTooOld(descriptor) {
      #expect(descriptor.protocolVersion == 3)
      #expect(TransportError.appTooOld(descriptor).localizedDescription == "Wire Probe runs a newer SpecWithCode. Update the app to connect.")
    }
  }

  @Test func olderServerVersionIsDistinctFromNewer() async throws {
    let fake = FakeHTTP { _ in (200, Captured.descriptor(version: 1)) }
    do {
      _ = try await MachineHTTP(transport: fake).descriptor(at: base)
      Issue.record("Expected serverTooOld")
    } catch let TransportError.serverTooOld(descriptor) {
      #expect(descriptor.protocolVersion == 1)
      #expect(TransportError.serverTooOld(descriptor).localizedDescription == "Update SpecWithCode on Wire Probe to connect.")
    }
  }

  @Test func checksTheEnvironmentBeforeTheVersion() async throws {
    let fake = FakeHTTP { _ in (200, Captured.descriptor(environmentId: "other", version: 1)) }
    await #expect(throws: TransportError.environmentMismatch(expected: "env-1", actual: "other")) {
      try await MachineHTTP(transport: fake).descriptor(at: base, expectedEnvironmentId: "env-1")
    }
  }

  @Test func descriptorTimesOut() async throws {
    let fake = FakeHTTP { _ in
      try await Task.sleep(for: .seconds(5))
      return (200, Captured.descriptor)
    }
    let clock = ContinuousClock()
    let start = clock.now
    await #expect(throws: TransportError.timedOut) {
      try await MachineHTTP(transport: fake, descriptorTimeout: .milliseconds(50)).descriptor(at: base)
    }
    #expect(clock.now - start < .seconds(2))
  }

  @Test func mapsNetworkFailures() async throws {
    let refused = FakeHTTP { _ in throw URLError(.cannotConnectToHost) }
    do {
      _ = try await MachineHTTP(transport: refused).descriptor(at: base)
      Issue.record("Expected unreachable")
    } catch TransportError.unreachable {
    }
    let slow = FakeHTTP { _ in throw URLError(.timedOut) }
    await #expect(throws: TransportError.timedOut) { try await MachineHTTP(transport: slow).descriptor(at: base) }
  }

  @Test func exchangesThePairingCodeFormEncoded() async throws {
    let fake = FakeHTTP { _ in (200, Captured.token) }
    let now = Date(timeIntervalSince1970: 1_792_304_312)
    let http = MachineHTTP(transport: fake, now: { now })
    let grant = try await http.exchangePairingCode("W779DCWZZ3P3", at: base, clientLabel: "Anton's iPhone (17 Pro)")
    #expect(grant.accessToken == "eyJ2IjoxfQ.sig")
    #expect(grant.expiresAt == now.addingTimeInterval(2_592_000))
    #expect(grant.scopes == ["orchestration:read", "orchestration:operate", "settings:write"])

    let request = try #require(fake.requests.first)
    #expect(request.url?.absoluteString == "http://127.0.0.1:8431/oauth/token")
    #expect(request.httpMethod == "POST")
    #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/x-www-form-urlencoded")
    let body = String(decoding: try #require(request.httpBody), as: UTF8.self)
    #expect(body == "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange&subject_token=W779DCWZZ3P3&subject_token_type=urn%3Aspecweave-studio%3Aparams%3Aoauth%3Atoken-type%3Aenvironment-bootstrap&requested_token_type=urn%3Aietf%3Aparams%3Aoauth%3Atoken-type%3Aaccess_token&client_device_type=mobile&client_os=iOS&client_label=Anton%27s+iPhone+%2817+Pro%29")
    #expect(formFields(body) == [
      "grant_type": "urn:ietf:params:oauth:grant-type:token-exchange",
      "subject_token": "W779DCWZZ3P3",
      "subject_token_type": "urn:specweave-studio:params:oauth:token-type:environment-bootstrap",
      "requested_token_type": "urn:ietf:params:oauth:token-type:access_token",
      "client_device_type": "mobile",
      "client_os": "iOS",
      "client_label": "Anton's iPhone (17 Pro)",
    ])
  }

  @Test func encodesLikeTheCapturedProbe() {
    // The probe sent client_label "Wire probe (Swift stand-in)" as below.
    #expect(FormQuery.encodeComponent("Wire probe (Swift stand-in)") == "Wire+probe+%28Swift+stand-in%29")
    #expect(FormQuery.encodeComponent("a~b*c_d.e-f") == "a%7Eb*c_d.e-f")
    #expect(FormQuery.encodeComponent("é") == "%C3%A9")
  }

  @Test func aSpentCodeIsRejectedNotARepair() async throws {
    let fake = FakeHTTP { _ in (401, Captured.invalidCredential) }
    await #expect(throws: TransportError.pairingCodeRejected) {
      try await MachineHTTP(transport: fake).exchangePairingCode("USED", at: base, clientLabel: "iPhone")
    }
  }

  @Test func getsAWebSocketTicket() async throws {
    let fake = FakeHTTP { _ in (200, Captured.ticket) }
    let ticket = try await MachineHTTP(transport: fake).websocketTicket(token: "tok", at: base)
    #expect(ticket.ticket == "eyJ2IjoxLCJraW5kIjoid2Vic29ja2V0In0.6FwXkoc6y4G9")
    let expiresAt = try #require(ticket.expiresAt)
    #expect(abs(expiresAt.timeIntervalSince1970 - 1_792_304_612.519) < 0.001)
    let request = try #require(fake.requests.first)
    #expect(request.url?.absoluteString == "http://127.0.0.1:8431/api/auth/websocket-ticket")
    #expect(request.httpMethod == "POST")
    #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer tok")
  }

  @Test func invalidCredentialNeedsRepair() async throws {
    let fake = FakeHTTP { _ in (401, Captured.invalidCredential) }
    let http = MachineHTTP(transport: fake)
    await #expect(throws: TransportError.needsRepair) { try await http.websocketTicket(token: "revoked", at: base) }
    await #expect(throws: TransportError.needsRepair) { try await http.session(token: "revoked", at: base) }
  }

  @Test func missingCredentialIsAnHTTPError() async throws {
    let fake = FakeHTTP { _ in (401, Captured.missingCredential) }
    await #expect(throws: TransportError.http(status: 401, code: "missing_credential")) {
      try await MachineHTTP(transport: fake).websocketTicket(token: "tok", at: base)
    }
  }

  @Test func readsTheSession() async throws {
    let fake = FakeHTTP { request in
      request.value(forHTTPHeaderField: "Authorization") == "Bearer tok" ? (200, Captured.session) : (200, Captured.anonymousSession)
    }
    let http = MachineHTTP(transport: fake)
    let session = try await http.session(token: "tok", at: base)
    #expect(session.authenticated)
    #expect(session.permissions == ["orchestration:read", "orchestration:operate", "settings:write"])
    #expect(session.expiresAt != nil)
    let anonymous = try await http.session(token: "other", at: base)
    #expect(anonymous.authenticated == false)
    #expect(anonymous.permissions.isEmpty)
    #expect(fake.requests.first?.url?.path == "/api/auth/session")
  }

  @Test func otherStatusesKeepTheirCode() async throws {
    let fake = FakeHTTP { _ in (503, #"{"code":"update_in_progress"}"#) }
    await #expect(throws: TransportError.http(status: 503, code: "update_in_progress")) {
      try await MachineHTTP(transport: fake).websocketTicket(token: "tok", at: base)
    }
  }
}

@Suite struct MachinePairingTests {
  @Test func pairsAndRemembersTheMachine() async throws {
    let fake = FakeHTTP { request in
      switch request.url?.path {
      case "/.well-known/studio/environment": (200, Captured.descriptor)
      case "/oauth/token": (200, Captured.token)
      default: (404, "")
      }
    }
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("swc-pair-\(UUID().uuidString)/machines.json")
    defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
    let credentials = InMemoryCredentialStore()
    let pairing = MachinePairing(http: MachineHTTP(transport: fake), credentials: credentials, registry: MachineRegistry(fileURL: url))

    let result = try await pairing.pair(link: "http://192.168.1.20:8319/pair#token=W779DCWZZ3P3", clientLabel: "iPhone")
    #expect(result.record.environmentId == "caed14a8-c16c-43ea-89d1-29cd01b88336")
    #expect(result.record.label == "Wire Probe")
    #expect(result.record.routes.map(\.address) == ["http://192.168.1.20:8319"])
    #expect(try credentials.credential(for: result.record.environmentId, issuer: "http://192.168.1.20:8319")?.token == "eyJ2IjoxfQ.sig")
    #expect(result.record.routes.map(\.issuer) == ["http://192.168.1.20:8319"])
    #expect(fake.requests.map { $0.url?.path } == ["/.well-known/studio/environment", "/oauth/token"])
  }

  @Test func anAddressClaimingAKnownMachineGetsItsOwnTokenSlot() async throws {
    let env = "caed14a8-c16c-43ea-89d1-29cd01b88336"
    let fake = FakeHTTP { request in
      let evil = request.url?.host() == "evil.example"
      switch request.url?.path {
      case "/.well-known/studio/environment":
        return (200, Captured.descriptor.replacingOccurrences(of: "Wire Probe", with: evil ? "Evil" : "Wire Probe"))
      case "/oauth/token":
        return (200, Captured.token.replacingOccurrences(of: "eyJ2IjoxfQ.sig", with: evil ? "junk" : "real"))
      default:
        return (404, "")
      }
    }
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("swc-pair-\(UUID().uuidString)/machines.json")
    defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
    let credentials = InMemoryCredentialStore()
    let registry = MachineRegistry(fileURL: url)
    let pairing = MachinePairing(http: MachineHTTP(transport: fake), credentials: credentials, registry: registry)

    _ = try await pairing.pair(link: "http://192.168.1.20:8319/pair#token=REAL", clientLabel: "iPhone")
    let spoofed = try await pairing.pair(link: "https://evil.example/pair#token=x", clientLabel: "iPhone")
    // The real token is untouched; the attacker's lives under its own address.
    #expect(try credentials.credential(for: env, issuer: "http://192.168.1.20:8319")?.token == "real")
    #expect(try credentials.credential(for: env, issuer: "https://evil.example")?.token == "junk")
    #expect(spoofed.record.routes.map(\.issuer) == ["http://192.168.1.20:8319", "https://evil.example"])
    // An unverified address does not rename the known machine.
    #expect(spoofed.record.label == "Wire Probe")

    // Pairing again at a known address takes that machine's label.
    _ = try await pairing.pair(link: "http://192.168.1.20:8319/pair#token=REAL2", clientLabel: "iPhone")
    #expect(try credentials.credential(for: env, issuer: "http://192.168.1.20:8319")?.token == "real")
    #expect(try credentials.credential(for: env, issuer: "https://evil.example")?.token == "junk")
  }

  @Test func doesNotSpendTheCodeOnTheWrongMachine() async throws {
    let fake = FakeHTTP { _ in (200, Captured.descriptor) }
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("swc-pair-\(UUID().uuidString)/machines.json")
    let pairing = MachinePairing(http: MachineHTTP(transport: fake), credentials: InMemoryCredentialStore(), registry: MachineRegistry(fileURL: url))
    await #expect(throws: TransportError.environmentMismatch(expected: "env-1", actual: "caed14a8-c16c-43ea-89d1-29cd01b88336")) {
      try await pairing.pair(link: "http://192.168.1.20:8319/#token=CODE", clientLabel: "iPhone", expectedEnvironmentId: "env-1")
    }
    #expect(fake.requests(path: "/oauth/token").isEmpty)
  }
}
