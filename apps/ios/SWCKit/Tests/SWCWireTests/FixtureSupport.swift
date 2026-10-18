import Foundation
import Testing
import SWCWire

enum Fixture {
  struct Missing: Error, CustomStringConvertible {
    let name: String
    var description: String { "Missing fixture \(name)" }
  }

  static func url(_ name: String) throws -> URL {
    let base = (name as NSString).deletingPathExtension
    let ext = (name as NSString).pathExtension
    guard let url = Bundle.module.url(forResource: base, withExtension: ext, subdirectory: "Fixtures") else {
      throw Missing(name: name)
    }
    return url
  }

  static func data(_ name: String) throws -> Data {
    try Data(contentsOf: url(name))
  }

  static func json(_ name: String) throws -> JSONValue {
    try WireCoding.decoder.decode(JSONValue.self, from: data(name))
  }

  static func decode<T: Decodable>(_ type: T.Type, _ name: String) throws -> T {
    try WireCoding.decoder.decode(T.self, from: data(name))
  }

  /// Non-empty lines of a `.jsonl` fixture, parsed.
  static func lines(_ name: String) throws -> [JSONValue] {
    let text = String(decoding: try data(name), as: UTF8.self)
    return try text.split(separator: "\n", omittingEmptySubsequences: true).map { line in
      try WireCoding.decoder.decode(JSONValue.self, from: Data(line.utf8))
    }
  }
}

func decodeJSON<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
  try WireCoding.decoder.decode(T.self, from: Data(json.utf8))
}

func encodeToJSON<T: Encodable>(_ value: T) throws -> JSONValue {
  try JSONValue.from(value)
}

/// Removes null members, so models that leave nil keys out compare equal to
/// server output that writes them as null.
func stripNulls(_ value: JSONValue) -> JSONValue {
  switch value {
  case let .object(map):
    var out: [String: JSONValue] = [:]
    for (key, member) in map where !member.isNull { out[key] = stripNulls(member) }
    return .object(out)
  case let .array(items):
    return .array(items.map(stripNulls))
  default:
    return value
  }
}

extension JSONValue {
  var arrayValue: [JSONValue]? { if case let .array(a) = self { return a }; return nil }
  var objectValue: [String: JSONValue]? { if case let .object(o) = self { return o }; return nil }
}
