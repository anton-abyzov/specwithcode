import Foundation

// Secret requests: an agent asks the person for a secret, such as an API key.
// Mirrors `OrchestrationV2SecretRequestFields` in `packages/contracts/src/orchestrationV2.ts`.

/// Where a secret request stands. Mirrors `OrchestrationV2SecretRequestStatus`.
public struct SecretRequestStatus: OpenStringEnum {
  public enum Known: String, Sendable, CaseIterable {
    case pending, saved, declined, cancelled
  }
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }

  public static let pending = Self(.pending)
  public static let saved = Self(.saved)
  public static let declined = Self(.declined)
  public static let cancelled = Self(.cancelled)
}

extension TurnItem {
  /// A secret the agent asked the person for. The value never passes through
  /// the item: it carries only what was asked and how it was answered.
  public struct SecretRequest: Codable, Hashable, Sendable {
    /// What is asked for, e.g. "OpenAI API key".
    public var label: String
    public var reason: String
    public var placeholder: String?
    public var secretStatus: SecretRequestStatus

    public init(label: String, reason: String = "", placeholder: String? = nil, secretStatus: SecretRequestStatus = .pending) {
      self.label = label
      self.reason = reason
      self.placeholder = placeholder
      self.secretStatus = secretStatus
    }

    enum CodingKeys: String, CodingKey { case label, reason, placeholder, secretStatus }

    public init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      label = (try? c.decodeIfPresent(String.self, forKey: .label)) ?? ""
      reason = (try? c.decodeIfPresent(String.self, forKey: .reason)) ?? ""
      placeholder = try? c.decodeIfPresent(String.self, forKey: .placeholder)
      // A missing or malformed status reads as ended rather than failing the item.
      secretStatus = (try? c.decodeIfPresent(SecretRequestStatus.self, forKey: .secretStatus)) ?? .cancelled
    }

    public var isPending: Bool { secretStatus == .pending }
  }
}
