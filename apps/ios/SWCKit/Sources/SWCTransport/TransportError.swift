import Foundation

/// Failures from HTTP calls, the socket and the connection supervisor.
/// Typed server failures of an RPC arrive as `ServerError` instead.
public enum TransportError: Error, Sendable, Hashable {
  /// The address could not be turned into a request.
  case invalidAddress(String)
  /// The machine could not be reached (DNS, refused, no route, TLS).
  case unreachable(String)
  case timedOut
  /// The socket closed before the request finished.
  case closed
  /// The stored token is missing, expired or revoked. Pair again.
  case needsRepair
  /// The one-time pairing code expired, was already used, or is wrong.
  case pairingCodeRejected
  /// The server speaks a newer protocol than this app.
  case appTooOld(EnvironmentDescriptorLite)
  /// The server speaks an older protocol than this app.
  case serverTooOld(EnvironmentDescriptorLite)
  /// The address answered as a different machine.
  case environmentMismatch(expected: String, actual: String)
  /// The WebSocket upgrade did not return 101.
  case upgradeFailed(status: Int?)
  /// Any other non-2xx answer. `code` is the server's error code when it sent one.
  case http(status: Int, code: String?)
  /// A 2xx answer the app could not read.
  case invalidResponse(String)
  /// SpecWithCode Connect could not hand out access to the machine.
  case connect(ConnectError)

  /// The failure will not go away by retrying.
  public var isPermanent: Bool {
    switch self {
    case .needsRepair, .appTooOld, .serverTooOld, .pairingCodeRejected: true
    case let .connect(error): error.isPermanent
    default: false
    }
  }
}

extension TransportError: LocalizedError {
  public var errorDescription: String? {
    switch self {
    case .invalidAddress:
      "That computer address is not valid."
    case .unreachable:
      "The computer could not be reached. Check that it is awake and on the same network or tailnet."
    case .timedOut:
      "The computer took too long to answer."
    case .closed:
      "The connection to the computer closed."
    case .needsRepair:
      "This computer no longer accepts the app's sign-in. Pair it again."
    case .pairingCodeRejected:
      "That pairing code expired or was already used. Create a new one on your computer."
    case let .appTooOld(descriptor):
      "\(descriptor.label) runs a newer SpecWithCode. Update the app to connect."
    case let .serverTooOld(descriptor):
      "Update SpecWithCode on \(descriptor.label) to connect."
    case .environmentMismatch:
      "That address belongs to a different computer."
    case .upgradeFailed:
      "The computer refused the live connection."
    case let .http(status, _):
      "The computer answered with an error (\(status))."
    case .invalidResponse:
      "The computer sent an answer the app could not read."
    case let .connect(error):
      error.errorDescription
    }
  }
}

extension Error {
  /// Domain, code and message only. A system error's `userInfo` can carry the
  /// failing URL, and a socket URL holds the WebSocket ticket. Errors built in
  /// this module are described as they are.
  var redactedDescription: String {
    if let transport = self as? TransportError { return String(describing: transport) }
    if let keychain = self as? KeychainError { return keychain.description }
    let ns = self as NSError
    return "\(ns.domain) \(ns.code): \(ns.localizedDescription)"
  }
}
