import Foundation
import Security
import SWCWire
import Synchronization

/// The bearer token for one machine. The pairing code is never stored.
public struct MachineCredential: Sendable, Hashable, Codable {
  public var token: String
  public var expiresAt: Date
  /// Permissions granted to the token, e.g. `orchestration:operate`.
  public var permissions: [String]

  public init(token: String, expiresAt: Date, permissions: [String]) {
    self.token = token
    self.expiresAt = expiresAt
    self.permissions = permissions
  }

  public init(grant: TokenGrant) {
    self.init(token: grant.accessToken, expiresAt: grant.expiresAt, permissions: grant.scopes)
  }

  public func isExpired(now: Date = Date()) -> Bool { expiresAt <= now }

  /// Whole days until expiry, never negative.
  public func daysLeft(now: Date = Date()) -> Int {
    max(0, Int((expiresAt.timeIntervalSince(now) / 86_400).rounded(.down)))
  }

  public func allows(_ permission: String) -> Bool { permissions.contains(permission) }
}

/// Where machine tokens live. Every token is bound to the machine and to the
/// route that issued it (its `issuer`, a route address), as client-runtime keys
/// `bearer:<environmentId>:<origin>`. A token is only sent to its issuer and to
/// routes a socket it authenticated reported, never to another saved route.
public protocol CredentialStore: Sendable {
  /// The token `issuer` issued for the machine.
  func credential(for environmentId: String, issuer: String) throws -> MachineCredential?
  func save(_ credential: MachineCredential, for environmentId: String, issuer: String) throws
  /// Removes every token of the machine.
  func remove(for environmentId: String) throws
  /// Moves a token saved before tokens were bound to their route under
  /// `issuer` and returns it; nil when there is none.
  func adoptLegacyCredential(for environmentId: String, issuer: String) throws -> MachineCredential?
}

extension CredentialStore {
  public func adoptLegacyCredential(for environmentId: String, issuer: String) throws -> MachineCredential? { nil }

  /// The token a route uses: the one its issuer issued.
  public func credential(for route: MachineRoute, of environmentId: String) throws -> MachineCredential? {
    try credential(for: environmentId, issuer: route.issuer)
  }

  /// The token of the best-ranked route holding an unexpired one, else of the
  /// best-ranked route holding any. For permissions and days left.
  public func bestCredential(for record: MachineRecord, now: Date = Date()) -> MachineCredential? {
    var fallback: MachineCredential?
    var seen: Set<String> = []
    for route in record.rankedRoutes where seen.insert(route.issuer).inserted {
      guard let credential = try? credential(for: record.environmentId, issuer: route.issuer) else { continue }
      if !credential.isExpired(now: now) { return credential }
      if fallback == nil { fallback = credential }
    }
    return fallback
  }
}

public struct KeychainError: Error, Sendable, Hashable, CustomStringConvertible {
  public let status: OSStatus
  public init(status: OSStatus) { self.status = status }
  public var description: String {
    (SecCopyErrorMessageString(status, nil) as String?) ?? "Keychain error \(status)"
  }
}

/// One generic-password item per machine and issuing route: service
/// `com.specwithcode.ios.machine`, account = `<environment id> <issuer address>`,
/// readable only while the device is unlocked, on this device only, never
/// synced. The value is JSON `{token, expiresAt, permissions}`. Items from
/// before tokens were bound to a route have account = environment id.
public struct KeychainCredentialStore: CredentialStore {
  public static let defaultService = "com.specwithcode.ios.machine"

  public let service: String

  public init(service: String = KeychainCredentialStore.defaultService) {
    self.service = service
  }

  /// Environment ids and route addresses never contain a space.
  static func account(_ environmentId: String, _ issuer: String) -> String {
    "\(environmentId) \(issuer)"
  }

  private func serviceQuery() -> [String: Any] {
    var query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrSynchronizable as String: kCFBooleanFalse as Any,
    ]
    #if os(macOS)
    query[kSecUseDataProtectionKeychain as String] = true
    #endif
    return query
  }

  private func itemQuery(_ account: String) -> [String: Any] {
    var query = serviceQuery()
    query[kSecAttrAccount as String] = account
    return query
  }

  public func credential(for environmentId: String, issuer: String) throws -> MachineCredential? {
    try read(Self.account(environmentId, issuer))
  }

  public func save(_ credential: MachineCredential, for environmentId: String, issuer: String) throws {
    try write(credential, Self.account(environmentId, issuer))
  }

  public func remove(for environmentId: String) throws {
    for account in try accounts() where account == environmentId || account.hasPrefix("\(environmentId) ") {
      try delete(account)
    }
  }

  public func adoptLegacyCredential(for environmentId: String, issuer: String) throws -> MachineCredential? {
    guard let legacy = try read(environmentId) else { return nil }
    try write(legacy, Self.account(environmentId, issuer))
    try delete(environmentId)
    return legacy
  }

  private func read(_ account: String) throws -> MachineCredential? {
    var query = itemQuery(account)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess else { throw KeychainError(status: status) }
    guard let data = result as? Data else { return nil }
    return try WireCoding.decoder.decode(MachineCredential.self, from: data)
  }

  private func write(_ credential: MachineCredential, _ account: String) throws {
    let data = try WireCoding.encoder.encode(credential)
    let attributes: [String: Any] = [
      kSecValueData as String: data,
      // The app reads tokens only in the foreground; it closes every socket when it leaves.
      kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
    ]
    let status = SecItemUpdate(itemQuery(account) as CFDictionary, attributes as CFDictionary)
    if status == errSecSuccess { return }
    guard status == errSecItemNotFound else { throw KeychainError(status: status) }
    var add = itemQuery(account)
    add.merge(attributes) { _, new in new }
    let addStatus = SecItemAdd(add as CFDictionary, nil)
    guard addStatus == errSecSuccess else { throw KeychainError(status: addStatus) }
  }

  private func delete(_ account: String) throws {
    let status = SecItemDelete(itemQuery(account) as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainError(status: status) }
  }

  /// Accounts of every item in the service.
  private func accounts() throws -> [String] {
    var query = serviceQuery()
    query[kSecReturnAttributes as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitAll
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return [] }
    guard status == errSecSuccess else { throw KeychainError(status: status) }
    let items = (result as? [[String: Any]]) ?? []
    return items.compactMap { $0[kSecAttrAccount as String] as? String }
  }
}

/// A token's key in a store: the machine and the route that issued it.
public struct CredentialKey: Sendable, Hashable {
  public var environmentId: String
  public var issuer: String

  public init(environmentId: String, issuer: String) {
    self.environmentId = environmentId
    self.issuer = issuer
  }
}

/// For tests, previews and fixtures.
public final class InMemoryCredentialStore: CredentialStore {
  private let items: Mutex<[CredentialKey: MachineCredential]>
  private let legacy: Mutex<[String: MachineCredential]>

  public init(_ items: [CredentialKey: MachineCredential] = [:], legacy: [String: MachineCredential] = [:]) {
    self.items = Mutex(items)
    self.legacy = Mutex(legacy)
  }

  public func credential(for environmentId: String, issuer: String) throws -> MachineCredential? {
    items.withLock { $0[CredentialKey(environmentId: environmentId, issuer: issuer)] }
  }

  public func save(_ credential: MachineCredential, for environmentId: String, issuer: String) throws {
    items.withLock { $0[CredentialKey(environmentId: environmentId, issuer: issuer)] = credential }
  }

  public func remove(for environmentId: String) throws {
    items.withLock { items in items = items.filter { $0.key.environmentId != environmentId } }
    _ = legacy.withLock { $0.removeValue(forKey: environmentId) }
  }

  public func adoptLegacyCredential(for environmentId: String, issuer: String) throws -> MachineCredential? {
    guard let credential = legacy.withLock({ $0.removeValue(forKey: environmentId) }) else { return nil }
    try save(credential, for: environmentId, issuer: issuer)
    return credential
  }
}
