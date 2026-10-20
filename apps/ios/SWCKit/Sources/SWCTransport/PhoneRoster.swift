import Foundation

/// The other machines of a paired machine's fleet, from
/// `POST /api/studio/fleet/phone`. A machine the phone asked to `mint` for
/// carries a one-time pairing code that the phone spends on that machine
/// itself, so every machine issues its own token (one token per machine).
public struct PhoneRoster: Sendable, Hashable, Decodable {
  public struct Hub: Sendable, Hashable, Decodable {
    public var environmentId: String
    public var label: String
  }

  public struct Route: Sendable, Hashable, Decodable {
    /// `lan`, `tailnet` or `fleet` (the machine's private fleet address).
    public var kind: String
    public var httpBaseUrl: String
  }

  public struct Pairing: Sendable, Hashable, Decodable {
    public var code: String
    public var expiresAt: String
  }

  public struct Machine: Sendable, Hashable, Decodable {
    public var environmentId: String
    public var label: String
    /// Best first: the private fleet address, then the addresses the machine reported.
    public var routes: [Route]
    public var pairing: Pairing?
    /// Why no code came back: `unreachable`, `identity_mismatch`,
    /// `pairing_unavailable` or `update_required`.
    public var problem: String?
  }

  public var hub: Hub
  public var machines: [Machine]
}

extension MachineHTTP {
  /// At most this many machines mint a code per request.
  public static let phoneRosterMintLimit = 16

  /// Asks a paired machine for the rest of its fleet. `mint` names the
  /// machines the phone has no working token for. A machine older than the
  /// roster answers 404 or 405.
  public func phoneRoster(token: String, at httpBase: URL, mint: [String] = []) async throws -> PhoneRoster {
    var request = try makeRequest(httpBase, "/api/studio/fleet/phone", timeout: requestTimeout)
    request.httpMethod = "POST"
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    let ids = Array(mint.prefix(Self.phoneRosterMintLimit))
    request.httpBody = try JSONEncoder().encode(ids.isEmpty ? PhoneRosterBody(mint: nil) : PhoneRosterBody(mint: ids))
    let data = try await perform(request, timeout: requestTimeout, authenticated: true)
    return try decode(PhoneRoster.self, from: data)
  }
}

private struct PhoneRosterBody: Encodable {
  let mint: [String]?
}
