import Foundation
import SWCWire

/// One address of a machine.
public struct MachineRoute: Sendable, Hashable, Codable {
  /// Origin with a trailing slash, e.g. `http://192.168.1.20:8319/`.
  public var httpBase: URL
  public var wsBase: URL
  public var kind: RouteKind
  /// Reported by the server in `directEndpoints` rather than paired by the user.
  public var learned: Bool
  /// Address of the route whose pairing issued the token this route uses: its
  /// own address for a saved route, the reporting socket's issuer for a learned
  /// one. A token never goes to a route with another issuer.
  public var issuer: String

  public init(httpBase: URL, wsBase: URL, kind: RouteKind? = nil, learned: Bool = false, issuer: String? = nil) {
    self.httpBase = httpBase
    self.wsBase = wsBase
    self.kind = kind ?? RouteKind.classify(host: httpBase.host() ?? "")
    self.learned = learned
    self.issuer = issuer ?? Self.address(of: httpBase)
  }

  /// A route for an http(s) origin; the ws form is derived.
  public init?(httpBase string: String, learned: Bool = false, issuer: String? = nil) {
    guard let origin = try? PairingLink.origin(of: string) else { return nil }
    self.init(httpBase: origin.httpBase, wsBase: origin.wsBase, learned: learned, issuer: issuer)
  }

  enum CodingKeys: String, CodingKey { case httpBase, wsBase, kind, learned, issuer }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    httpBase = try c.decode(URL.self, forKey: .httpBase)
    wsBase = try c.decode(URL.self, forKey: .wsBase)
    kind = try c.decode(RouteKind.self, forKey: .kind)
    learned = try c.decode(Bool.self, forKey: .learned)
    // Records from before tokens were bound to a route: each route is its own
    // issuer, so a learned one has no token until a socket reports it again.
    issuer = try c.decodeIfPresent(String.self, forKey: .issuer) ?? Self.address(of: httpBase)
  }

  /// The address without a trailing slash, for comparisons and display.
  public var address: String { Self.address(of: httpBase) }

  static func address(of httpBase: URL) -> String {
    var s = httpBase.absoluteString
    while s.hasSuffix("/") { s.removeLast() }
    return s
  }
}

/// A paired machine as the app remembers it. The token lives in the Keychain.
public struct MachineRecord: Sendable, Hashable, Codable, Identifiable {
  public var environmentId: String
  public var label: String
  public var routes: [MachineRoute]
  public var enabled: Bool
  /// Last shell sequence applied, for `subscribeShell{afterSequence}` on resume.
  public var lastShellSequence: Int?

  public var id: String { environmentId }

  public init(environmentId: String, label: String, routes: [MachineRoute], enabled: Bool = true, lastShellSequence: Int? = nil) {
    self.environmentId = environmentId
    self.label = label
    self.routes = routes
    self.enabled = enabled
    self.lastShellSequence = lastShellSequence
  }

  /// Routes fastest kind first; saved order holds within a kind, and
  /// learned routes follow saved ones of the same kind.
  public var rankedRoutes: [MachineRoute] {
    routes.enumerated().sorted { a, b in
      if a.element.kind != b.element.kind { return a.element.kind < b.element.kind }
      if a.element.learned != b.element.learned { return !a.element.learned }
      return a.offset < b.offset
    }.map(\.element)
  }

  /// Adds a route, or replaces the one with the same address. A route the
  /// user pairs is never marked learned, even if it was learned before.
  public mutating func upsertRoute(_ route: MachineRoute) {
    if let i = routes.firstIndex(where: { $0.address == route.address }) {
      routes[i] = route
    } else {
      routes.append(route)
    }
  }

  /// Applies the addresses a socket reported (`ServerConfig.directEndpoints[].httpBaseUrl`).
  /// `issuer` is the issuer of the route that socket was opened on; the new
  /// learned routes use its token. Learned routes of that issuer it no longer
  /// reports are dropped; other issuers' learned routes and saved routes are
  /// kept; loopback and non-http addresses are ignored. Returns whether
  /// anything changed.
  @discardableResult
  public mutating func mergeLearnedRoutes(_ reported: [String], issuer: String) -> Bool {
    var reportedRoutes: [String: MachineRoute] = [:]
    var order: [String] = []
    for raw in reported {
      let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
      guard let components = URLComponents(string: trimmed, encodingInvalidCharacters: false),
            let scheme = components.scheme?.lowercased(), scheme == "http" || scheme == "https",
            let route = MachineRoute(httpBase: trimmed, learned: true, issuer: issuer),
            route.kind != .loopback else { continue }
      if reportedRoutes[route.address] == nil { order.append(route.address) }
      reportedRoutes[route.address] = route
    }
    let saved = Set(routes.filter { !$0.learned }.map(\.address))
    var seen = saved
    var next: [MachineRoute] = []
    for route in routes {
      if !route.learned { next.append(route); continue }
      guard !seen.contains(route.address) else { continue }
      if let reportedRoute = reportedRoutes[route.address] {
        // The socket that reported it last vouches for it.
        seen.insert(route.address)
        next.append(reportedRoute)
      } else if route.issuer != issuer {
        seen.insert(route.address)
        next.append(route)
      }
    }
    for address in order where !seen.contains(address) {
      seen.insert(address)
      if let route = reportedRoutes[address] { next.append(route) }
    }
    let changed = next != routes
    routes = next
    return changed
  }
}

/// The list of paired machines, persisted atomically as a JSON array.
public actor MachineRegistry {
  public let fileURL: URL
  private var cache: [MachineRecord]?

  public init(fileURL: URL) {
    self.fileURL = fileURL
  }

  /// `Application Support/machines.json`.
  public static func defaultFileURL() throws -> URL {
    let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    return base.appendingPathComponent("machines.json", isDirectory: false)
  }

  /// All machines in the order they were paired. A missing or unreadable file
  /// is an empty list; the next save replaces it.
  public func all() -> [MachineRecord] {
    if let cache { return cache }
    let loaded = Self.read(fileURL)
    cache = loaded
    return loaded
  }

  public func machine(_ environmentId: String) -> MachineRecord? {
    all().first { $0.environmentId == environmentId }
  }

  /// Inserts or replaces the record with the same environment id.
  public func upsert(_ record: MachineRecord) throws {
    var list = all()
    if let i = list.firstIndex(where: { $0.environmentId == record.environmentId }) {
      list[i] = record
    } else {
      list.append(record)
    }
    try save(list)
  }

  /// Records a pairing: adds the route to an existing machine, or adds the machine.
  @discardableResult
  public func recordPairing(environmentId: String, label: String, route: MachineRoute) throws -> MachineRecord {
    var record = machine(environmentId) ?? MachineRecord(environmentId: environmentId, label: label, routes: [])
    record.label = label
    record.enabled = true
    // A paired route is saved and uses the token its own pairing issued.
    record.upsertRoute(MachineRoute(httpBase: route.httpBase, wsBase: route.wsBase, kind: route.kind, learned: false, issuer: route.address))
    try upsert(record)
    return record
  }

  /// Applies to one machine; returns the updated record, or nil when it is unknown.
  @discardableResult
  public func update(_ environmentId: String, _ change: @Sendable (inout MachineRecord) -> Void) throws -> MachineRecord? {
    var list = all()
    guard let i = list.firstIndex(where: { $0.environmentId == environmentId }) else { return nil }
    var record = list[i]
    change(&record)
    guard record != list[i] else { return record }
    list[i] = record
    try save(list)
    return record
  }

  @discardableResult
  public func mergeLearnedRoutes(_ reported: [String], issuer: String, for environmentId: String) throws -> MachineRecord? {
    try update(environmentId) { $0.mergeLearnedRoutes(reported, issuer: issuer) }
  }

  public func setEnabled(_ enabled: Bool, for environmentId: String) throws {
    try update(environmentId) { $0.enabled = enabled }
  }

  public func setLastShellSequence(_ sequence: Int?, for environmentId: String) throws {
    try update(environmentId) { $0.lastShellSequence = sequence }
  }

  public func remove(_ environmentId: String) throws {
    let list = all()
    let next = list.filter { $0.environmentId != environmentId }
    guard next.count != list.count else { return }
    try save(next)
  }

  private func save(_ list: [MachineRecord]) throws {
    let encoder = WireCoding.encoder
    encoder.outputFormatting.insert(.prettyPrinted)
    encoder.outputFormatting.insert(.sortedKeys)
    let data = try encoder.encode(list)
    try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
    #if os(iOS)
    try data.write(to: fileURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    #else
    try data.write(to: fileURL, options: [.atomic])
    #endif
    cache = list
  }

  private static func read(_ url: URL) -> [MachineRecord] {
    guard let data = try? Data(contentsOf: url) else { return [] }
    return (try? WireCoding.decoder.decode([MachineRecord].self, from: data)) ?? []
  }
}
