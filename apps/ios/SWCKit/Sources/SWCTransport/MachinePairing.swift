import Foundation

/// What a successful pairing produced.
public struct PairingResult: Sendable, Hashable {
  public let record: MachineRecord
  public let descriptor: EnvironmentDescriptorLite
  public let credential: MachineCredential
}

/// Pairs a machine: check it, spend the code, keep the token, remember the route.
public struct MachinePairing: Sendable {
  public let http: MachineHTTP
  public let credentials: any CredentialStore
  public let registry: MachineRegistry

  public init(http: MachineHTTP = MachineHTTP(), credentials: any CredentialStore, registry: MachineRegistry) {
    self.http = http
    self.credentials = credentials
    self.registry = registry
  }

  /// Pairs from a scanned or pasted link.
  public func pair(link: String, clientLabel: String, expectedEnvironmentId: String? = nil) async throws -> PairingResult {
    try await pair(target: PairingLink.parse(link), clientLabel: clientLabel, expectedEnvironmentId: expectedEnvironmentId)
  }

  /// The descriptor is checked before the one-time code is spent, so a wrong
  /// machine or an incompatible version leaves the code usable.
  ///
  /// The descriptor is unauthenticated, so the new token is bound to the
  /// address that issued it and never replaces or reaches another route's.
  public func pair(target: PairingTarget, clientLabel: String, expectedEnvironmentId: String? = nil) async throws -> PairingResult {
    let descriptor = try await http.descriptor(at: target.httpBase, expectedEnvironmentId: expectedEnvironmentId)
    let grant = try await http.exchangePairingCode(target.code, at: target.httpBase, clientLabel: clientLabel)
    let credential = MachineCredential(grant: grant)
    let route = target.route
    try credentials.save(credential, for: descriptor.environmentId, issuer: route.address)
    var label = descriptor.label
    if expectedEnvironmentId == nil, let existing = await registry.machine(descriptor.environmentId),
       !existing.routes.contains(where: { !$0.learned && $0.address == route.address }) {
      // A new address claiming a known machine does not rename it.
      label = existing.label
    }
    let record = try await registry.recordPairing(environmentId: descriptor.environmentId, label: label, route: route)
    return PairingResult(record: record, descriptor: descriptor, credential: credential)
  }
}
