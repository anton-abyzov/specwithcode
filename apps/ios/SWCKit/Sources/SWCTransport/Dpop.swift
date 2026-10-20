import CryptoKit
import Foundation
import Security
import Synchronization

/// A P-256 key that signs DPoP proofs (RFC 9449). The relay and the machine
/// bind their access tokens to its thumbprint, so a stolen token is useless
/// without the key.
public protocol DpopKey: Sendable {
  /// Uncompressed public point coordinates, 32 bytes each.
  var publicX: Data { get }
  var publicY: Data { get }
  /// ES256 over `message`: raw `r || s`, 64 bytes, in any S form.
  func sign(_ message: Data) throws -> Data
}

extension DpopKey {
  public var jwk: DpopJWK { DpopJWK(x: Base64URL.encode(publicX), y: Base64URL.encode(publicY)) }
  public var thumbprint: String { jwk.thumbprint }
}

/// The public JWK of a DPoP key.
public struct DpopJWK: Sendable, Hashable, Codable {
  public var kty = "EC"
  public var crv = "P-256"
  public var x: String
  public var y: String

  public init(x: String, y: String) {
    self.x = x
    self.y = y
  }

  /// RFC 7638: SHA-256 of the required members in lexicographic order.
  public var thumbprint: String {
    let canonical = #"{"crv":"P-256","kty":"EC","x":"\#(x)","y":"\#(y)"}"#
    return Base64URL.encode(Data(SHA256.hash(data: Data(canonical.utf8))))
  }
}

/// Builds DPoP proofs as the relay and the machine verify them
/// (`packages/shared/src/dpop.ts`).
public enum DpopProof {
  /// The P-256 group order. The verifier rejects high-S signatures.
  static let order: [UInt8] = hexBytes("FFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551")
  static let halfOrder: [UInt8] = hexBytes("7FFFFFFF800000007FFFFFFFFFFFFFFFDE737D56D38BCF4279DCE5617E3192A8")

  struct Header: Encodable {
    let typ = "dpop+jwt"
    let alg = "ES256"
    let jwk: DpopJWK
  }

  struct Payload: Encodable {
    let htm: String
    let htu: String
    let jti: String
    let iat: Int
    let ath: String?
  }

  /// A compact JWS for one request. `accessToken` adds `ath`, required on
  /// requests that carry `Authorization: DPoP <token>`.
  public static func make(
    key: any DpopKey,
    method: String,
    url: URL,
    accessToken: String? = nil,
    now: Date = Date(),
    jti: String = UUID().uuidString.lowercased()
  ) throws -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    let header = try encoder.encode(Header(jwk: key.jwk))
    let payload = try encoder.encode(Payload(
      htm: method.uppercased(),
      htu: htu(url),
      jti: jti,
      iat: Int(now.timeIntervalSince1970.rounded(.down)),
      ath: accessToken.map(accessTokenHash)
    ))
    let signingInput = Base64URL.encode(header) + "." + Base64URL.encode(payload)
    let signature = try lowS(key.sign(Data(signingInput.utf8)))
    return signingInput + "." + Base64URL.encode(signature)
  }

  public static func accessTokenHash(_ token: String) -> String {
    Base64URL.encode(Data(SHA256.hash(data: Data(token.utf8))))
  }

  /// The URL without query and fragment, as WHATWG `URL.toString()` prints it:
  /// lowercase scheme and host, no default port, `/` for an empty path.
  public static func htu(_ url: URL) -> String {
    guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return url.absoluteString }
    components.query = nil
    components.fragment = nil
    components.scheme = components.scheme?.lowercased()
    components.host = components.host?.lowercased()
    if (components.scheme == "https" && components.port == 443) || (components.scheme == "http" && components.port == 80) {
      components.port = nil
    }
    if components.percentEncodedPath.isEmpty { components.percentEncodedPath = "/" }
    return components.string ?? url.absoluteString
  }

  /// Rewrites `r || s` with `s > n/2` as `r || n - s`; both verify, but noble
  /// (the relay's verifier) accepts only the low form.
  public static func lowS(_ signature: Data) throws -> Data {
    guard signature.count == 64 else { throw DpopError.invalidSignature }
    let r = Array(signature.prefix(32))
    let s = Array(signature.suffix(32))
    guard compare(s, halfOrder) > 0 else { return signature }
    return Data(r + subtract(order, s))
  }

  static func compare(_ a: [UInt8], _ b: [UInt8]) -> Int {
    for (x, y) in zip(a, b) where x != y { return x < y ? -1 : 1 }
    return 0
  }

  /// `a - b` for big-endian numbers of equal length with `a >= b`.
  static func subtract(_ a: [UInt8], _ b: [UInt8]) -> [UInt8] {
    var result = [UInt8](repeating: 0, count: a.count)
    var borrow = 0
    for i in stride(from: a.count - 1, through: 0, by: -1) {
      var digit = Int(a[i]) - Int(b[i]) - borrow
      borrow = digit < 0 ? 1 : 0
      if digit < 0 { digit += 256 }
      result[i] = UInt8(digit)
    }
    return result
  }

  static func hexBytes(_ hex: String) -> [UInt8] {
    var bytes: [UInt8] = []
    var index = hex.startIndex
    while index < hex.endIndex {
      let next = hex.index(index, offsetBy: 2)
      bytes.append(UInt8(hex[index..<next], radix: 16) ?? 0)
      index = next
    }
    return bytes
  }
}

public enum DpopError: Error, Sendable, Hashable {
  case invalidSignature
  case keyUnavailable(String)
}

public enum Base64URL {
  public static func encode(_ data: Data) -> String {
    data.base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }

  public static func decode(_ string: String) -> Data? {
    var s = string.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    while s.count % 4 != 0 { s += "=" }
    return Data(base64Encoded: s)
  }
}

// MARK: - Keys

/// A software key, for the simulator, Macs without a Secure Enclave and tests.
public struct SoftwareDpopKey: DpopKey {
  public let privateKey: P256.Signing.PrivateKey

  public init(privateKey: P256.Signing.PrivateKey = P256.Signing.PrivateKey()) {
    self.privateKey = privateKey
  }

  public var publicX: Data { Data(privateKey.publicKey.rawRepresentation.prefix(32)) }
  public var publicY: Data { Data(privateKey.publicKey.rawRepresentation.suffix(32)) }

  public func sign(_ message: Data) throws -> Data {
    try privateKey.signature(for: message).rawRepresentation
  }
}

/// A key that never leaves the Secure Enclave. Its `dataRepresentation` is an
/// encrypted handle only this device's enclave can use.
public struct SecureEnclaveDpopKey: DpopKey {
  public let privateKey: SecureEnclave.P256.Signing.PrivateKey

  public init(privateKey: SecureEnclave.P256.Signing.PrivateKey) {
    self.privateKey = privateKey
  }

  public var publicX: Data { Data(privateKey.publicKey.rawRepresentation.prefix(32)) }
  public var publicY: Data { Data(privateKey.publicKey.rawRepresentation.suffix(32)) }

  public func sign(_ message: Data) throws -> Data {
    try privateKey.signature(for: message).rawRepresentation
  }
}

/// Where the device's DPoP key lives.
public protocol DpopKeyStore: Sendable {
  /// The saved key, or a new one saved first.
  func loadOrCreate() throws -> any DpopKey
  /// Forgets the key, e.g. on sign-out. Tokens bound to it stop working.
  func reset() throws
}

/// Keeps one key in the Keychain: a Secure Enclave handle where the device
/// has an enclave, else the software key itself. Readable after first unlock,
/// on this device only, never synced.
public final class KeychainDpopKeyStore: DpopKeyStore {
  public static let defaultService = "com.specwithcode.ios.connect"
  static let account = "dpop-key"
  private static let enclaveTag: UInt8 = 1
  private static let softwareTag: UInt8 = 2

  public let service: String
  private let preferEnclave: Bool
  private let cached = Mutex<(any DpopKey)?>(nil)

  public init(service: String = KeychainDpopKeyStore.defaultService, preferEnclave: Bool = SecureEnclave.isAvailable) {
    self.service = service
    self.preferEnclave = preferEnclave
  }

  public func loadOrCreate() throws -> any DpopKey {
    if let key = cached.withLock({ $0 }) { return key }
    let key = try read() ?? create()
    cached.withLock { $0 = key }
    return key
  }

  public func reset() throws {
    cached.withLock { $0 = nil }
    let status = SecItemDelete(query() as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainError(status: status) }
  }

  private func create() throws -> any DpopKey {
    let key: any DpopKey
    let stored: Data
    if preferEnclave, let enclave = try? SecureEnclave.P256.Signing.PrivateKey() {
      key = SecureEnclaveDpopKey(privateKey: enclave)
      stored = Data([Self.enclaveTag]) + enclave.dataRepresentation
    } else {
      let software = P256.Signing.PrivateKey()
      key = SoftwareDpopKey(privateKey: software)
      stored = Data([Self.softwareTag]) + software.rawRepresentation
    }
    var add = query()
    add[kSecValueData as String] = stored
    add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    let status = SecItemAdd(add as CFDictionary, nil)
    guard status == errSecSuccess else { throw KeychainError(status: status) }
    return key
  }

  private func read() throws -> (any DpopKey)? {
    var lookup = query()
    lookup[kSecReturnData as String] = true
    lookup[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(lookup as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess else { throw KeychainError(status: status) }
    guard let data = result as? Data, let tag = data.first else { return nil }
    let body = data.dropFirst()
    do {
      switch tag {
      case Self.enclaveTag:
        return SecureEnclaveDpopKey(privateKey: try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: Data(body)))
      case Self.softwareTag:
        return SoftwareDpopKey(privateKey: try P256.Signing.PrivateKey(rawRepresentation: Data(body)))
      default:
        return nil
      }
    } catch {
      // A restored backup carries an enclave handle another device cannot use.
      try reset()
      return nil
    }
  }

  private func query() -> [String: Any] {
    var query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: Self.account,
      kSecAttrSynchronizable as String: kCFBooleanFalse as Any,
    ]
    #if os(macOS)
    query[kSecUseDataProtectionKeychain as String] = true
    #endif
    return query
  }
}

/// For tests and previews.
public final class InMemoryDpopKeyStore: DpopKeyStore {
  private let key = Mutex<(any DpopKey)?>(nil)

  public init(_ key: (any DpopKey)? = nil) {
    self.key.withLock { $0 = key }
  }

  public func loadOrCreate() throws -> any DpopKey {
    key.withLock { stored in
      if let stored { return stored }
      let created = SoftwareDpopKey()
      stored = created
      return created
    }
  }

  public func reset() throws { key.withLock { $0 = nil } }
}
