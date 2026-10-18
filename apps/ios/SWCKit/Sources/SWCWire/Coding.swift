import Foundation

// Decoding helpers shared by the wire models.

/// A coding key built at runtime, for maps and for reading a `type` or `kind` tag.
public struct AnyCodingKey: CodingKey, Hashable, Sendable {
  public let stringValue: String
  public let intValue: Int?
  public init(_ string: String) { self.stringValue = string; self.intValue = nil }
  public init?(stringValue: String) { self.init(stringValue) }
  public init?(intValue: Int) { self.stringValue = String(intValue); self.intValue = intValue }
}

extension KeyedDecodingContainer {
  /// An array that may be missing or null on older servers. Elements must decode.
  func decodeArray<T: Decodable>(_ type: T.Type, forKey key: Key) throws -> [T] {
    try decodeIfPresent([T].self, forKey: key) ?? []
  }

  /// A forward-compatible array: elements this build cannot decode are dropped.
  func decodeLossyArray<T: Decodable>(_ type: T.Type, forKey key: Key) throws -> [T] {
    guard contains(key), try !decodeNil(forKey: key) else { return [] }
    var nested = try nestedUnkeyedContainer(forKey: key)
    var result: [T] = []
    while !nested.isAtEnd {
      if let value = try? nested.decode(T.self) {
        result.append(value)
      } else {
        _ = try nested.decode(JSONValue.self)
      }
    }
    return result
  }

  /// Distinguishes a missing key (nil) from an explicit null (`.null`).
  func decodeNullable<T: Decodable>(_ type: T.Type, forKey key: Key) throws -> Nullable<T>? {
    guard contains(key) else { return nil }
    if try decodeNil(forKey: key) { return .null }
    return .value(try decode(T.self, forKey: key))
  }
}

/// A patch field that can be set to a value or cleared with an explicit null.
/// Use it as `Nullable<T>?`: nil leaves the key out, `.null` sends `null`.
public enum Nullable<Wrapped> {
  case null
  case value(Wrapped)

  public var value: Wrapped? {
    if case let .value(v) = self { return v }
    return nil
  }

  /// `.value` for a value and `.null` for nil.
  public init(_ optional: Wrapped?) {
    if let optional { self = .value(optional) } else { self = .null }
  }
}

extension Nullable: Sendable where Wrapped: Sendable {}
extension Nullable: Equatable where Wrapped: Equatable {}
extension Nullable: Hashable where Wrapped: Hashable {}

extension Nullable: Codable where Wrapped: Codable {
  public init(from decoder: Decoder) throws {
    let c = try decoder.singleValueContainer()
    self = c.decodeNil() ? .null : .value(try c.decode(Wrapped.self))
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.singleValueContainer()
    switch self {
    case .null: try c.encodeNil()
    case let .value(v): try c.encode(v)
    }
  }
}

/// A file or image attached to a message. Unknown attachment types keep their base fields.
public struct ChatAttachment: Codable, Hashable, Sendable, Identifiable {
  /// `image`, `file`, or a type from a newer server.
  public var type: String
  public var id: String
  public var name: String
  public var mimeType: String
  public var sizeBytes: Int

  public init(type: String, id: String, name: String, mimeType: String, sizeBytes: Int) {
    self.type = type
    self.id = id
    self.name = name
    self.mimeType = mimeType
    self.sizeBytes = sizeBytes
  }

  enum CodingKeys: String, CodingKey { case type, id, name, mimeType, sizeBytes }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    type = try c.decodeIfPresent(String.self, forKey: .type) ?? "file"
    id = try c.decode(String.self, forKey: .id)
    name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
    mimeType = try c.decodeIfPresent(String.self, forKey: .mimeType) ?? "application/octet-stream"
    sizeBytes = try c.decodeIfPresent(Int.self, forKey: .sizeBytes) ?? 0
  }

  public var isImage: Bool { type == "image" }
}
