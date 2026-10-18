import Foundation

/// How a route reaches a machine, fastest first. Ported from
/// `packages/client-runtime/src/connection/routes.ts` and
/// `packages/shared/src/hostClassification.ts`.
public enum RouteKind: String, Sendable, Hashable, Codable, CaseIterable, Comparable {
  case loopback, lan, tailnet
  case `public`

  public var rank: Int {
    switch self {
    case .loopback: 0
    case .lan: 1
    case .tailnet: 2
    case .public: 3
    }
  }

  public static func < (lhs: RouteKind, rhs: RouteKind) -> Bool { lhs.rank < rhs.rank }

  /// Short label for settings, e.g. "LAN" or "Tailscale".
  public var label: String {
    switch self {
    case .loopback: "This device"
    case .lan: "LAN"
    case .tailnet: "Tailscale"
    case .public: "Internet"
    }
  }

  public static func classify(host: String) -> RouteKind {
    if HostClassification.isLoopback(host) { return .loopback }
    if HostClassification.isTailnet(host) { return .tailnet }
    return HostClassification.isPrivateNetwork(host) ? .lan : .public
  }
}

public enum HostClassification {
  public static func normalize(_ host: String) -> String {
    var h = host.lowercased()
    if h.hasPrefix("[") { h.removeFirst() }
    if h.hasSuffix("]") { h.removeLast() }
    while h.hasSuffix(".") { h.removeLast() }
    return h
  }

  static func ipv4(_ host: String) -> [Int]? {
    let parts = normalize(host).split(separator: ".", omittingEmptySubsequences: false)
    guard parts.count == 4 else { return nil }
    var out: [Int] = []
    for part in parts {
      guard !part.isEmpty, part.allSatisfy(\.isASCIIDigit), let n = Int(part), n <= 255 else { return nil }
      out.append(n)
    }
    return out
  }

  static func ipv4Mapped(_ host: String) -> [Int]? {
    let h = normalize(host)
    guard h.hasPrefix("::ffff:") else { return nil }
    let suffix = String(h.dropFirst("::ffff:".count))
    if let dotted = ipv4(suffix) { return dotted }
    let hextets = suffix.split(separator: ":", omittingEmptySubsequences: false)
    guard hextets.count == 2, hextets.allSatisfy(isHextet),
          let high = Int(hextets[0], radix: 16), let low = Int(hextets[1], radix: 16) else { return nil }
    return [high >> 8, high & 0xff, low >> 8, low & 0xff]
  }

  static func ipv6(_ host: String) -> [Int]? {
    let h = normalize(host)
    guard h.contains(":") else { return nil }
    let halves = h.components(separatedBy: "::")
    guard halves.count <= 2 else { return nil }
    let head = halves[0].isEmpty ? [] : halves[0].split(separator: ":", omittingEmptySubsequences: false).map(String.init)
    let tail = halves.count == 2 && !halves[1].isEmpty ? halves[1].split(separator: ":", omittingEmptySubsequences: false).map(String.init) : []
    guard (head + tail).allSatisfy({ isHextet(Substring($0)) }) else { return nil }
    let missing = 8 - head.count - tail.count
    if halves.count == 1 && missing != 0 { return nil }
    if halves.count == 2 && missing < 1 { return nil }
    let parts = head + Array(repeating: "0", count: max(missing, 0)) + tail
    return parts.compactMap { Int($0, radix: 16) }
  }

  private static func isHextet(_ s: Substring) -> Bool {
    (1...4).contains(s.count) && s.allSatisfy { $0.isASCII && $0.isHexDigit }
  }

  private static func isPrivateIPv4(_ p: [Int]) -> Bool {
    p[0] == 0 || p[0] == 10 || p[0] == 127
      || (p[0] == 100 && (64...127).contains(p[1]))
      || (p[0] == 172 && (16...31).contains(p[1]))
      || (p[0] == 192 && p[1] == 168)
      || (p[0] == 169 && p[1] == 254)
      || (p[0] == 198 && (18...19).contains(p[1]))
  }

  public static func isLoopback(_ host: String) -> Bool {
    let h = normalize(host)
    if h == "localhost" || h == "::1" { return true }
    return ipv4(h)?.first == 127
  }

  /// A MagicDNS name, the 100.64.0.0/10 range, or fd7a:115c:a1e0::/48.
  public static func isTailnet(_ host: String) -> Bool {
    let h = normalize(host)
    if h.hasSuffix(".ts.net") { return true }
    if let p = ipv4(h) { return p[0] == 100 && (64...127).contains(p[1]) }
    guard let v6 = ipv6(h), v6.count == 8 else { return false }
    return v6[0] == 0xfd7a && v6[1] == 0x115c && v6[2] == 0xa1e0
  }

  public static func isPrivateNetwork(_ host: String) -> Bool {
    let h = normalize(host)
    if h == "::" || isLoopback(h) || h.hasSuffix(".localhost") || h.hasSuffix(".local")
      || h == "home.arpa" || h.hasSuffix(".home.arpa") || (!h.contains(".") && !h.contains(":")) {
      return true
    }
    if h.hasSuffix(".ts.net") { return true }
    if let p = ipv4(h) ?? ipv4Mapped(h) { return isPrivateIPv4(p) }
    guard h.contains(":") else { return false }
    let first = h.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false).first ?? ""
    guard isHextet(first), let hextet = Int(first, radix: 16) else { return false }
    return (hextet & 0xfe00) == 0xfc00 || (hextet & 0xffc0) == 0xfe80
  }

  /// A bare IPv4 or IPv6 literal, with or without a port.
  public static func isIPLiteral(_ hostAndPort: String) -> Bool {
    var h = hostAndPort
    if h.hasPrefix("[") { return true }
    if h.filter({ $0 == ":" }).count > 1 { return ipv6(h) != nil }
    if let colon = h.lastIndex(of: ":") { h = String(h[..<colon]) }
    return ipv4(h) != nil
  }
}

private extension Character {
  var isASCIIDigit: Bool { isASCII && isNumber }
}
