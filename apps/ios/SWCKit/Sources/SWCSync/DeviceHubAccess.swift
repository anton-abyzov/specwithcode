import Foundation

/// What the device viewer's media requests need to reach `/api/device-hub`
/// on a machine. `<img>`, `EventSource` and `WebSocket` can't set bearer or
/// DPoP headers, so a short-lived WebSocket ticket goes in the query instead
/// (packages/client-runtime/src/device/hubAccess.ts).
public struct DeviceHubAccess: Codable, Hashable, Sendable {
  /// Absolute URL ending in the hub path, e.g. `http://mac:8319/api/device-hub`.
  public var httpBase: String
  /// Same base with the `ws(s)` scheme.
  public var wsBase: String
  /// `wsTicket`, and `hostId` for the host the device runs on.
  public var query: [String: String]
  /// Always false: the phone has no cookie session.
  public var credentials: Bool

  public init(httpBase: String, wsBase: String, query: [String: String], credentials: Bool = false) {
    self.httpBase = httpBase
    self.wsBase = wsBase
    self.query = query
    self.credentials = credentials
  }

  /// The hub under a route's origin. Nil for a path that isn't origin-relative.
  public init?(origin: URL, hubPath: String, ticket: String, hostId: String) {
    guard hubPath.hasPrefix("/"), var components = URLComponents(url: origin, resolvingAgainstBaseURL: false) else { return nil }
    let base = components.path.hasSuffix("/") ? String(components.path.dropLast()) : components.path
    components.path = base + hubPath
    components.query = nil
    components.fragment = nil
    guard let http = components.url?.absoluteString else { return nil }
    switch components.scheme?.lowercased() {
    case "https": components.scheme = "wss"
    case "http": components.scheme = "ws"
    default: return nil
    }
    guard let ws = components.url?.absoluteString else { return nil }
    self.init(httpBase: http, wsBase: ws, query: ["wsTicket": ticket, "hostId": hostId])
  }
}
