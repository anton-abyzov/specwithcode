import Foundation

// Pairing links, ported from `packages/shared/src/remote.ts` and
// `apps/mobile/src/features/connection/pairing.ts`.
//
// Accepted forms:
//   http(s)://host[:port][/pair]#token=CODE      (also ?token=CODE)
//   https://app.example/pair?host=<url>&label=<name>#token=CODE
//   studio:…?pairingUrl=<url>, studio-dev:…, specwithcode:…
//   a host plus a code typed by hand
// Only the origin of the machine address is kept.

/// Where to pair and with which one-time code.
public struct PairingTarget: Sendable, Hashable {
  public let code: String
  /// Origin with a trailing slash, e.g. `https://m4.tailnet.ts.net/`.
  public let httpBase: URL
  /// The same origin with `ws` or `wss`.
  public let wsBase: URL
  /// Label from a hosted link, when it carried one.
  public let label: String?

  public init(code: String, httpBase: URL, wsBase: URL, label: String? = nil) {
    self.code = code
    self.httpBase = httpBase
    self.wsBase = wsBase
    self.label = label
  }

  public var route: MachineRoute { MachineRoute(httpBase: httpBase, wsBase: wsBase) }
}

public enum PairingLinkError: Error, Sendable, Hashable {
  public enum HostSource: Sendable, Hashable { case directHost, hostedPairingHost }

  /// Nothing was entered or scanned.
  case empty
  /// A host is needed for manual pairing.
  case missingHost
  /// The link is not a URL, or uses a scheme other than http, https, ws or wss.
  case invalidLink(scheme: String?)
  /// The machine address is not a usable URL.
  case invalidHost(source: HostSource, scheme: String?)
  /// A link without a token.
  case missingToken(host: String)
  /// A manual host without a code.
  case missingCode(host: String)
}

extension PairingLinkError: LocalizedError {
  public var errorDescription: String? {
    switch self {
    case .empty: "Scan or paste a pairing link."
    case .missingHost: "Enter the computer's address."
    case .invalidLink: "That pairing link is not valid."
    case .invalidHost: "That computer address is not valid."
    case .missingToken: "That pairing link is missing its code."
    case .missingCode: "Enter a pairing code."
    }
  }
}

public enum PairingLink {
  /// App schemes that wrap a pairing link in `?pairingUrl=` or `?link=`.
  public static let wrapperSchemes: Set<String> = ["studio", "studio-dev", "specwithcode"]

  static let backendSchemes: Set<String> = ["http", "https", "ws", "wss"]

  /// Parses a scanned or pasted pairing link.
  public static func parse(_ text: String) throws(PairingLinkError) -> PairingTarget {
    try parse(text, depth: 0)
  }

  /// Pairs from a host and a code typed by hand. A bare IP address defaults
  /// to http, any other bare host to https.
  public static func manual(host: String, code: String) throws(PairingLinkError) -> PairingTarget {
    let trimmedHost = host.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmedHost.isEmpty else { throw .missingHost }
    let origin = try normalizeBase(trimmedHost, source: .directHost, defaultScheme: defaultScheme(for:))
    let trimmedCode = code.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmedCode.isEmpty else { throw .missingCode(host: origin.hostAndPort) }
    return PairingTarget(code: trimmedCode, httpBase: origin.httpBase, wsBase: origin.wsBase)
  }

  /// The pairing link inside an app-scheme wrapper, or the trimmed text itself.
  public static func unwrap(_ payload: String) -> String {
    let trimmed = payload.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let components = URLComponents(string: trimmed, encodingInvalidCharacters: false),
          let scheme = components.scheme?.lowercased(), wrapperSchemes.contains(scheme) else { return trimmed }
    let query = FormQuery(components.percentEncodedQuery)
    let inner = (query["pairingUrl"] ?? query["link"])?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return inner.isEmpty ? trimmed : inner
  }

  /// The http and ws origins for a backend address. Accepts a bare host, a
  /// protocol-relative host, or a full URL; drops path, query, fragment and user info.
  public static func origin(of address: String) throws(PairingLinkError) -> (httpBase: URL, wsBase: URL) {
    let origin = try normalizeBase(address, source: .directHost, defaultScheme: { _ in "https" })
    return (origin.httpBase, origin.wsBase)
  }

  // MARK: - Internals

  private static func parse(_ text: String, depth: Int) throws(PairingLinkError) -> PairingTarget {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { throw .empty }

    let explicitScheme = schemePrefix(of: trimmed)
    if let scheme = explicitScheme, wrapperSchemes.contains(scheme) {
      return try parseWrapper(trimmed, scheme: scheme, depth: depth)
    }

    // A pasted link without a scheme, like `m4.local:8319#token=…`.
    let candidate = trimmed.contains("://") ? trimmed : "\(defaultScheme(for: trimmed))://\(trimmed.drop(while: { $0 == "/" }))"
    guard let link = ParsedURL(candidate) else {
      throw .invalidLink(scheme: trimmed.contains("://") ? explicitScheme : nil)
    }
    guard backendSchemes.contains(link.scheme) else { throw .invalidLink(scheme: link.scheme) }

    if let hosted = hostedRequest(link) {
      let origin = try normalizeBase(hosted.host, source: .hostedPairingHost, defaultScheme: { _ in "https" })
      return PairingTarget(code: hosted.token, httpBase: origin.httpBase, wsBase: origin.wsBase, label: hosted.label)
    }

    guard let origin = Origin(scheme: link.scheme, host: link.host, port: link.port) else {
      throw .invalidLink(scheme: link.scheme)
    }
    guard let token = link.token else { throw .missingToken(host: origin.hostAndPort) }
    return PairingTarget(code: token, httpBase: origin.httpBase, wsBase: origin.wsBase)
  }

  private static func parseWrapper(_ text: String, scheme: String, depth: Int) throws(PairingLinkError) -> PairingTarget {
    guard depth == 0, let components = URLComponents(string: text, encodingInvalidCharacters: false) else { throw .invalidLink(scheme: scheme) }
    let query = FormQuery(components.percentEncodedQuery)
    // `link` is what specwithcode://pair deep links use; `pairingUrl` is the older name.
    if let inner = (query["pairingUrl"] ?? query["link"])?.trimmingCharacters(in: .whitespacesAndNewlines), !inner.isEmpty {
      return try parse(inner, depth: depth + 1)
    }
    let host = query["host"]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let token = query["token"]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    guard !host.isEmpty, !token.isEmpty else { throw .invalidLink(scheme: scheme) }
    let origin = try normalizeBase(host, source: .hostedPairingHost, defaultScheme: { _ in "https" })
    let label = query["label"]?.trimmingCharacters(in: .whitespacesAndNewlines)
    return PairingTarget(code: token, httpBase: origin.httpBase, wsBase: origin.wsBase, label: label?.isEmpty == false ? label : nil)
  }

  private static func hostedRequest(_ link: ParsedURL) -> (host: String, token: String, label: String?)? {
    let host = link.query["host"]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    guard !host.isEmpty, let token = link.token else { return nil }
    let label = link.query["label"]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return (host, token, label.isEmpty ? nil : label)
  }

  /// `http` for an IP literal, `https` otherwise, as the mobile app does.
  static func defaultScheme(for hostAndRest: String) -> String {
    let stripped = hostAndRest.drop(while: { $0 == "/" })
    let authority = stripped.prefix { $0 != "/" && $0 != "?" && $0 != "#" }
    return HostClassification.isIPLiteral(String(authority)) ? "http" : "https"
  }

  /// The scheme before the first colon, when the text starts with one.
  static func schemePrefix(of text: String) -> String? {
    guard let colon = text.firstIndex(of: ":") else { return nil }
    let candidate = text[..<colon]
    guard let first = candidate.first, first.isASCII, first.isLetter,
          candidate.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "+" || $0 == "-" || $0 == ".") })
    else { return nil }
    return candidate.lowercased()
  }

  static func normalizeBase(_ raw: String, source: PairingLinkError.HostSource, defaultScheme: (String) -> String) throws(PairingLinkError) -> Origin {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { throw .missingHost }
    let withoutSlashes = String(trimmed.drop(while: { $0 == "/" }))
    let hasScheme = withoutSlashes.range(of: "^[a-zA-Z][a-zA-Z0-9+-]*://", options: .regularExpression) != nil
    let input = hasScheme ? withoutSlashes : "\(defaultScheme(withoutSlashes))://\(withoutSlashes)"
    guard let url = ParsedURL(input) else { throw .invalidHost(source: source, scheme: nil) }
    guard backendSchemes.contains(url.scheme) else { throw .invalidHost(source: source, scheme: url.scheme) }
    guard let origin = Origin(scheme: url.scheme, host: url.host, port: url.port) else {
      throw .invalidHost(source: source, scheme: nil)
    }
    return origin
  }
}

// MARK: - URL helpers

/// An origin with its http and ws forms.
struct Origin: Hashable {
  let httpScheme: String
  let host: String
  let port: Int?
  let hostAndPort: String
  let httpBase: URL
  let wsBase: URL

  /// Nil for an unknown scheme, or a host that is not a DNS name, IPv4
  /// address or IPv6 literal. `URLComponents.host` is percent-decoded, so it
  /// can hold spaces, brackets, `/`, `@` and other characters that no URL can
  /// carry or that would move the authority to another host.
  init?(scheme: String, host: String, port: Int?) {
    let h = HostClassification.normalize(host)
    guard Self.isValidHost(h) else { return nil }
    let httpScheme: String
    switch scheme {
    case "http", "ws": httpScheme = "http"
    case "https", "wss": httpScheme = "https"
    default: return nil
    }
    if let port, !(0...65_535).contains(port) { return nil }
    let defaultPort = httpScheme == "https" ? 443 : 80
    let port = port == defaultPort ? nil : port
    let hostForURL = h.contains(":") ? "[\(h)]" : h
    let hostAndPort = port.map { "\(hostForURL):\($0)" } ?? hostForURL
    let wsScheme = httpScheme == "https" ? "wss" : "ws"
    guard let httpBase = URL(string: "\(httpScheme)://\(hostAndPort)/"),
          let wsBase = URL(string: "\(wsScheme)://\(hostAndPort)/"),
          httpBase.host() != nil, wsBase.host() != nil else { return nil }
    self.httpScheme = httpScheme
    self.host = h
    self.port = port
    self.hostAndPort = hostAndPort
    self.httpBase = httpBase
    self.wsBase = wsBase
  }

  var wsScheme: String { httpScheme == "https" ? "wss" : "ws" }

  /// ASCII letters, digits, `-`, `_` and `.` (the host is already lowercased),
  /// or an IPv6 literal.
  static func isValidHost(_ h: String) -> Bool {
    guard !h.isEmpty else { return false }
    if h.contains(":") { return HostClassification.ipv6(h) != nil || HostClassification.ipv4Mapped(h) != nil }
    return h.utf8.allSatisfy { b in
      (0x30...0x39).contains(b) || (0x61...0x7A).contains(b) || b == 0x2D || b == 0x2E || b == 0x5F
    }
  }
}

struct ParsedURL {
  let scheme: String
  let host: String
  let port: Int?
  let query: FormQuery
  let fragment: FormQuery

  init?(_ string: String) {
    guard let c = URLComponents(string: string, encodingInvalidCharacters: false),
          let scheme = c.scheme?.lowercased(), let host = c.host, !host.isEmpty else { return nil }
    self.scheme = scheme
    self.host = host
    self.port = c.port
    self.query = FormQuery(c.percentEncodedQuery)
    self.fragment = FormQuery(c.percentEncodedFragment)
  }

  /// The token from the fragment, falling back to the query.
  var token: String? {
    for source in [fragment, query] {
      if let t = source["token"]?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty { return t }
    }
    return nil
  }
}

/// `application/x-www-form-urlencoded` pairs, read like `URLSearchParams`.
struct FormQuery {
  let pairs: [(String, String)]

  init(_ encoded: String?) {
    guard let encoded, !encoded.isEmpty else { pairs = []; return }
    pairs = encoded.split(separator: "&", omittingEmptySubsequences: true).map { part in
      let kv = part.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
      let key = Self.decode(kv[0])
      let value = kv.count > 1 ? Self.decode(kv[1]) : ""
      return (key, value)
    }
  }

  subscript(name: String) -> String? { pairs.first { $0.0 == name }?.1 }

  static func decode(_ s: Substring) -> String {
    let spaced = s.replacingOccurrences(of: "+", with: " ")
    return spaced.removingPercentEncoding ?? spaced
  }

  /// Encodes like `URLSearchParams.toString()`.
  static func encode(_ pairs: [(String, String)]) -> String {
    pairs.map { "\(encodeComponent($0.0))=\(encodeComponent($0.1))" }.joined(separator: "&")
  }

  static func encodeComponent(_ s: String) -> String {
    var out = ""
    for byte in s.utf8 {
      switch byte {
      case 0x2A, 0x2D, 0x2E, 0x5F, 0x30...0x39, 0x41...0x5A, 0x61...0x7A:
        out.unicodeScalars.append(Unicode.Scalar(byte))
      case 0x20:
        out.append("+")
      default:
        out += String(format: "%%%02X", byte)
      }
    }
    return out
  }
}
