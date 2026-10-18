import Foundation

/// A model on a configured provider instance, e.g. `{instanceId: "codex", model: "gpt-6"}`.
///
/// Decoding also accepts the legacy `{provider, model}` form and options written
/// as an object (`{"effort": "high"}`). Encoding always writes the canonical form.
public struct ModelSelection: Codable, Hashable, Sendable {
  public var instanceId: String
  public var model: String
  public var options: [ModelOption]?

  public init(instanceId: String, model: String, options: [ModelOption]? = nil) {
    self.instanceId = instanceId
    self.model = model
    self.options = options
  }

  enum CodingKeys: String, CodingKey { case instanceId, provider, model, options }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    if let id = try c.decodeIfPresent(String.self, forKey: .instanceId) {
      instanceId = id
    } else if let provider = try? c.decodeIfPresent(String.self, forKey: .provider) {
      instanceId = provider
    } else {
      throw DecodingError.keyNotFound(CodingKeys.instanceId, .init(codingPath: c.codingPath, debugDescription: "Model selection has no instanceId or provider"))
    }
    model = try c.decode(String.self, forKey: .model)
    options = try Self.decodeOptions(c)
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(instanceId, forKey: .instanceId)
    try c.encode(model, forKey: .model)
    try c.encodeIfPresent(options, forKey: .options)
  }

  private static func decodeOptions(_ c: KeyedDecodingContainer<CodingKeys>) throws -> [ModelOption]? {
    guard let raw = try c.decodeIfPresent(JSONValue.self, forKey: .options) else { return nil }
    switch raw {
    case let .array(items):
      return items.compactMap { item in
        guard let id = item["id"]?.stringValue else { return nil }
        switch item["value"] {
        case let .string(s)?: return ModelOption(id: id, value: .string(s))
        case let .bool(b)?: return ModelOption(id: id, value: .bool(b))
        default: return nil
        }
      }
    case let .object(map):
      // Legacy object form; keys sorted so the order is stable.
      return map.keys.sorted().compactMap { key in
        let id = key.trimmingCharacters(in: .whitespaces)
        guard !id.isEmpty else { return nil }
        switch map[key] {
        case let .string(s)? where !s.trimmingCharacters(in: .whitespaces).isEmpty:
          return ModelOption(id: id, value: .string(s.trimmingCharacters(in: .whitespaces)))
        case let .bool(b)?: return ModelOption(id: id, value: .bool(b))
        default: return nil
        }
      }
    default:
      return nil
    }
  }

  /// The value of one option, e.g. `option("effort")`.
  public func option(_ id: String) -> ModelOption.Value? {
    options?.first { $0.id == id }?.value
  }
}

/// One provider option chosen for a model, such as reasoning effort or fast mode.
public struct ModelOption: Codable, Hashable, Sendable {
  public enum Value: Codable, Hashable, Sendable {
    case string(String)
    case bool(Bool)

    public init(from decoder: Decoder) throws {
      let c = try decoder.singleValueContainer()
      if let b = try? c.decode(Bool.self) { self = .bool(b) } else { self = .string(try c.decode(String.self)) }
    }

    public func encode(to encoder: Encoder) throws {
      var c = encoder.singleValueContainer()
      switch self {
      case let .string(s): try c.encode(s)
      case let .bool(b): try c.encode(b)
      }
    }
  }

  public var id: String
  public var value: Value

  public init(id: String, value: Value) {
    self.id = id
    self.value = value
  }
}
