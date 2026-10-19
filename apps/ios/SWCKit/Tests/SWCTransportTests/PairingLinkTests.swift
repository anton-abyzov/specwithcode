import Foundation
import Testing
@testable import SWCTransport

// Tables ported from packages/shared/src/remote.test.ts and
// apps/mobile/src/features/connection/pairing.test.ts, plus the app-scheme wrappers.

struct LinkCase: Sendable, CustomTestStringConvertible {
  let input: String
  let code: String
  let http: String
  let ws: String
  var testDescription: String { input }
}

@Suite struct PairingLinkTests {
  static let links: [LinkCase] = [
    // remote.test.ts
    LinkCase(input: "https://remote.example.com/pair#token=pairing-token", code: "pairing-token", http: "https://remote.example.com/", ws: "wss://remote.example.com/"),
    LinkCase(input: "https://remote.example.com/pair?token=pairing-token", code: "pairing-token", http: "https://remote.example.com/", ws: "wss://remote.example.com/"),
    LinkCase(input: "https://app.studio.invalid/pair?host=https%3A%2F%2Fdesktop.tailnet.ts.net%3A44342%2F#token=pairing-token", code: "pairing-token", http: "https://desktop.tailnet.ts.net:44342/", ws: "wss://desktop.tailnet.ts.net:44342/"),
    LinkCase(input: "https://app.studio.invalid/pair?host=%2F%2Fremote.example.com#token=pairing-token", code: "pairing-token", http: "https://remote.example.com/", ws: "wss://remote.example.com/"),
    // pairing.test.ts
    LinkCase(input: "https://app.studio.invalid/pair?host=https%3A%2F%2Fdesktop.tailnet.ts.net%2F#token=pairing-token", code: "pairing-token", http: "https://desktop.tailnet.ts.net/", ws: "wss://desktop.tailnet.ts.net/"),
    LinkCase(input: "  https://remote.example.com/pair#token=pairing-token  ", code: "pairing-token", http: "https://remote.example.com/", ws: "wss://remote.example.com/"),
    LinkCase(input: "studio://pair?pairingUrl=https%3A%2F%2Fremote.example.com%2Fpair%23token%3Dpairing-token", code: "pairing-token", http: "https://remote.example.com/", ws: "wss://remote.example.com/"),
    // App-scheme wrappers
    LinkCase(input: "studio-dev://pair?pairingUrl=http%3A%2F%2F192.168.1.20%3A8319%2Fpair%23token%3DABC234", code: "ABC234", http: "http://192.168.1.20:8319/", ws: "ws://192.168.1.20:8319/"),
    LinkCase(input: "specwithcode://pair?pairingUrl=https%3A%2F%2Fm4.tail1234.ts.net%2F%23token%3DXYZ789", code: "XYZ789", http: "https://m4.tail1234.ts.net/", ws: "wss://m4.tail1234.ts.net/"),
    LinkCase(input: "specwithcode:pair?pairingUrl=https%3A%2F%2Fm4.tail1234.ts.net%2F%23token%3DXYZ789", code: "XYZ789", http: "https://m4.tail1234.ts.net/", ws: "wss://m4.tail1234.ts.net/"),
    LinkCase(input: "specwithcode://pair?link=https%3A%2F%2Fm4.tail1234.ts.net%2Fpair%23token%3DXYZ789", code: "XYZ789", http: "https://m4.tail1234.ts.net/", ws: "wss://m4.tail1234.ts.net/"),
    LinkCase(input: "specwithcode://pair?host=https%3A%2F%2Fm4.tail1234.ts.net&token=XYZ789", code: "XYZ789", http: "https://m4.tail1234.ts.net/", ws: "wss://m4.tail1234.ts.net/"),
    // Origin only: path, query, user info and default ports go
    LinkCase(input: "http://192.168.1.20:8319/pair#token=ABC", code: "ABC", http: "http://192.168.1.20:8319/", ws: "ws://192.168.1.20:8319/"),
    LinkCase(input: "https://user:secret@M4.Example.COM:443/deep/path?x=1#token=ABC", code: "ABC", http: "https://m4.example.com/", ws: "wss://m4.example.com/"),
    LinkCase(input: "http://m4.local:80/#token=ABC", code: "ABC", http: "http://m4.local/", ws: "ws://m4.local/"),
    LinkCase(input: "wss://m4.example.com/ws#token=ABC", code: "ABC", http: "https://m4.example.com/", ws: "wss://m4.example.com/"),
    LinkCase(input: "http://[fd7a:115c:a1e0::1]:8319/#token=ABC", code: "ABC", http: "http://[fd7a:115c:a1e0::1]:8319/", ws: "ws://[fd7a:115c:a1e0::1]:8319/"),
    // The fragment token wins over the query token; tokens are trimmed
    LinkCase(input: "https://remote.example.com/pair?token=query-token#token=hash-token", code: "hash-token", http: "https://remote.example.com/", ws: "wss://remote.example.com/"),
    LinkCase(input: "https://remote.example.com/pair#token=%20padded%20", code: "padded", http: "https://remote.example.com/", ws: "wss://remote.example.com/"),
    // A pasted link without a scheme
    LinkCase(input: "192.168.1.20:8319/pair#token=ABC", code: "ABC", http: "http://192.168.1.20:8319/", ws: "ws://192.168.1.20:8319/"),
    LinkCase(input: "m4.tail1234.ts.net#token=ABC", code: "ABC", http: "https://m4.tail1234.ts.net/", ws: "wss://m4.tail1234.ts.net/"),
  ]

  @Test(arguments: links)
  func parsesLink(_ c: LinkCase) throws {
    let target = try PairingLink.parse(c.input)
    #expect(target.code == c.code)
    #expect(target.httpBase.absoluteString == c.http)
    #expect(target.wsBase.absoluteString == c.ws)
  }

  @Test func hostedLinkCarriesLabel() throws {
    let target = try PairingLink.parse("https://app.studio.invalid/pair?host=https%3A%2F%2Fm4.tail1234.ts.net&label=Office%20Mac#token=ABC")
    #expect(target.label == "Office Mac")
    #expect(try PairingLink.parse("https://remote.example.com/#token=ABC").label == nil)
  }

  struct ManualCase: Sendable, CustomTestStringConvertible {
    let host: String
    let http: String
    let ws: String
    var testDescription: String { host }
  }

  static let manualHosts: [ManualCase] = [
    // remote.test.ts
    ManualCase(host: "https://remote.example.com", http: "https://remote.example.com/", ws: "wss://remote.example.com/"),
    ManualCase(host: "//remote.example.com", http: "https://remote.example.com/", ws: "wss://remote.example.com/"),
    ManualCase(host: "//remote.example.com:3000", http: "https://remote.example.com:3000/", ws: "wss://remote.example.com:3000/"),
    ManualCase(host: "///example.com", http: "https://example.com/", ws: "wss://example.com/"),
    ManualCase(host: "//https://example.com", http: "https://example.com/", ws: "wss://example.com/"),
    ManualCase(host: "myserver.com:3000", http: "https://myserver.com:3000/", ws: "wss://myserver.com:3000/"),
    // pairing.test.ts buildPairingUrl
    ManualCase(host: "192.168.1.100:8319", http: "http://192.168.1.100:8319/", ws: "ws://192.168.1.100:8319/"),
    ManualCase(host: "remote.example.com", http: "https://remote.example.com/", ws: "wss://remote.example.com/"),
    ManualCase(host: "https://192.168.1.100:8319", http: "https://192.168.1.100:8319/", ws: "wss://192.168.1.100:8319/"),
  ]

  @Test(arguments: manualHosts)
  func parsesManualHost(_ c: ManualCase) throws {
    let target = try PairingLink.manual(host: c.host, code: " pairing-token ")
    #expect(target.code == "pairing-token")
    #expect(target.httpBase.absoluteString == c.http)
    #expect(target.wsBase.absoluteString == c.ws)
    #expect(target.label == nil)
  }

  @Test func rejectsUnsupportedSchemes() {
    #expect(throws: PairingLinkError.invalidLink(scheme: "ftp")) {
      try PairingLink.parse("ftp://remote.example.com/pair#token=pairing-token")
    }
    #expect(throws: PairingLinkError.invalidHost(source: .hostedPairingHost, scheme: "ftp")) {
      try PairingLink.parse("https://app.studio.invalid/pair?host=ftp%3A%2F%2Fremote.example.com#token=pairing-token")
    }
    #expect(throws: PairingLinkError.invalidHost(source: .directHost, scheme: "ftp")) {
      try PairingLink.manual(host: "ftp://remote.example.com", code: "pairing-token")
    }
  }

  @Test func distinguishesMissingInputs() {
    #expect(throws: PairingLinkError.empty) { try PairingLink.parse("   ") }
    #expect(throws: PairingLinkError.missingHost) { try PairingLink.manual(host: "", code: "") }
    #expect(throws: PairingLinkError.missingToken(host: "remote.example.com")) {
      try PairingLink.parse("https://remote.example.com/pair")
    }
    #expect(throws: PairingLinkError.missingCode(host: "remote.example.com")) {
      try PairingLink.manual(host: "https://user:secret@remote.example.com/path?token=sensitive#fragment", code: "")
    }
    #expect(throws: PairingLinkError.missingToken(host: "remote.example.com:3000")) {
      try PairingLink.parse("https://remote.example.com:3000/pair#token=")
    }
  }

  @Test func rejectsMalformedInput() {
    #expect(throws: PairingLinkError.invalidLink(scheme: nil)) { try PairingLink.parse("not a url") }
    #expect(throws: PairingLinkError.invalidHost(source: .directHost, scheme: nil)) {
      try PairingLink.manual(host: "https://[invalid", code: "pairing-token")
    }
    #expect(throws: PairingLinkError.invalidLink(scheme: "studio")) {
      try PairingLink.parse("studio://pair?other=1")
    }
  }

  @Test func rejectsHostsNoURLCanCarryInsteadOfCrashing() {
    // URLComponents percent-decodes the host; these used to trap in URL(string:)!.
    for link in [
      "http://a%20b:8319/pair#token=x",
      "http://a%5Bb/#token=x",
      "http://a%7Cb/#token=x",
      "http://a%22b/#token=x",
      "http://a%00b/#token=x",
      "specwithcode://pair?pairingUrl=http%3A%2F%2Fa%2520b%3A8319%2Fpair%23token%3Dx",
    ] {
      #expect(throws: PairingLinkError.self, "\(link)") { try PairingLink.parse(link) }
    }
    #expect(throws: PairingLinkError.invalidLink(scheme: "http")) { try PairingLink.parse("http://a%20b:8319/pair#token=x") }
    // A decoded `/` or `@` must not move the authority to another host.
    #expect(throws: PairingLinkError.invalidLink(scheme: "http")) { try PairingLink.parse("http://a%2Fb%40evil.com/#token=x") }
    #expect(throws: PairingLinkError.invalidHost(source: .directHost, scheme: nil)) { try PairingLink.manual(host: "a%5Bb", code: "1") }
    #expect(throws: PairingLinkError.invalidHost(source: .hostedPairingHost, scheme: nil)) {
      try PairingLink.parse("https://app.studio.invalid/pair?host=http%3A%2F%2Fa%2520b#token=x")
    }
    #expect(MachineRoute(httpBase: "http://a%20b:8319/") == nil)
  }

  @Test func keepsEveryValidHostForm() throws {
    for (link, http) in [
      ("http://[::ffff:192.168.1.5]:8319/#token=x", "http://[::ffff:192.168.1.5]:8319/"),
      ("http://[::1]:8319/#token=x", "http://[::1]:8319/"),
      ("https://M4.Tail1234.TS.NET.:8443/#token=x", "https://m4.tail1234.ts.net:8443/"),
      ("m4.local:8319#token=x", "https://m4.local:8319/"),
      ("http://my_host.lan:8319/#token=x", "http://my_host.lan:8319/"),
    ] {
      #expect(try PairingLink.parse(link).httpBase.absoluteString == http)
    }
  }

  @Test func unwrapsQRPayloads() {
    #expect(PairingLink.unwrap("  https://remote.example.com/pair#token=pairing-token  ") == "https://remote.example.com/pair#token=pairing-token")
    #expect(PairingLink.unwrap("studio://pair?pairingUrl=https%3A%2F%2Fremote.example.com%2Fpair%23token%3Dpairing-token") == "https://remote.example.com/pair#token=pairing-token")
    #expect(PairingLink.unwrap("studio://pair") == "studio://pair")
    #expect(PairingLink.unwrap("specwithcode://pair?link=https%3A%2F%2Fm4.tail1234.ts.net%2Fpair%23token%3DXYZ789") == "https://m4.tail1234.ts.net/pair#token=XYZ789")
  }

  @Test func errorsHaveUserFacingText() {
    #expect(PairingLinkError.missingCode(host: "x").localizedDescription == "Enter a pairing code.")
    #expect(PairingLinkError.invalidLink(scheme: nil).localizedDescription == "That pairing link is not valid.")
  }
}
