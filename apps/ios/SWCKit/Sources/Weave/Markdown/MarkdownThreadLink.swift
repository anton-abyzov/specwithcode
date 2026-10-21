import Foundation

/// Only conversation navigation is allowed from assistant-authored app links.
/// Pairing, credentials and arbitrary app actions must never use this route.
public nonisolated enum MarkdownThreadLink {
  public struct Route: Equatable, Sendable {
    /// Nil means the machine whose conversation contains the link.
    public let environmentId: String?
    public let threadId: String
  }

  public static func threadId(_ url: URL) -> String? { route(url)?.threadId }

  /// Supports local /<thread> and canonical fleet /<environment>/<thread> URLs.
  /// Split before decoding: an encoded slash belongs to an ID, never a route.
  public static func route(_ url: URL) -> Route? {
    guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
          parts.scheme?.lowercased() == "studio", parts.host?.lowercased() == "thread",
          parts.user == nil, parts.password == nil, parts.port == nil,
          parts.query == nil, parts.fragment == nil else { return nil }
    let path = parts.percentEncodedPath
    guard path.hasPrefix("/") else { return nil }
    let segments = path.dropFirst().split(separator: "/", omittingEmptySubsequences: false)
    guard (1...2).contains(segments.count) else { return nil }
    let ids = segments.compactMap { segment -> String? in
      guard let id = String(segment).removingPercentEncoding,
            !id.isEmpty, id != ".", id != "..",
            !id.unicodeScalars.contains(where: { CharacterSet.whitespacesAndNewlines.contains($0) || CharacterSet.controlCharacters.contains($0) }) else { return nil }
      return id
    }
    guard ids.count == segments.count, let thread = ids.last else { return nil }
    return Route(environmentId: ids.count == 2 ? ids[0] : nil, threadId: thread)
  }
}
