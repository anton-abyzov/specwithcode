import Foundation
import SWCTransport

/// A device waiting for this machine's approval. It carries no code: the
/// person reads that off the waiting device and types it here.
public struct WaitingDevice: Identifiable, Sendable, Hashable {
  public var id: String
  public var label: String
  public var shortId: String?
  public var expiresAt: Date?

  public init(id: String, label: String, shortId: String? = nil, expiresAt: Date? = nil) {
    self.id = id
    self.label = label
    self.shortId = shortId
    self.expiresAt = expiresAt
  }

  public func isExpired(at now: Date) -> Bool {
    expiresAt.map { $0 <= now } ?? false
  }
}

public enum AllowDeviceListing: Sendable, Hashable {
  /// This phone may not approve here, or the machine has no such list: show nothing.
  case unavailable
  /// The machine did not answer: keep what is on screen.
  case unreachable
  /// This phone's own Connect key waits here: show nothing and stop asking,
  /// since on an older machine each request keeps that wait alive.
  case waitingHere
  case ready([WaitingDevice])

  /// What a failed request means for the card. It never touches the connection.
  static func after(_ error: Error) -> AllowDeviceListing {
    guard let error = error as? TransportError else { return .unreachable }
    switch error {
    case .unreachable, .timedOut, .closed: return .unreachable
    case let .http(status, _) where status >= 500 || status == 429: return .unreachable
    case .awaitingApproval: return .waitingHere
    case let .connect(failure) where failure.isOutage: return .unreachable
    default: return .unavailable
    }
  }
}

private extension ConnectError {
  /// The relay or the way to it failed; it did not say this phone lost a right.
  var isOutage: Bool {
    switch self {
    case .unreachable, .invalidResponse: true
    case let .relay(status, _, _): status >= 500 || status == 429
    case .signedOut: false
    }
  }
}

public enum AllowDeviceOutcome: Sendable, Hashable {
  /// What a failed approval means: only a network failure leaves the card up.
  static func after(_ error: Error) -> AllowDeviceOutcome {
    AllowDeviceListing.after(error) == .unreachable ? .unreachable : .noLongerAllowed
  }

  case allowed(name: String, shortId: String?)
  case wrongCode
  case expired
  case ownCode
  case paused
  case unreachable
  /// This phone lost the right to approve: the card goes away.
  case noLongerAllowed

  /// The server answers `not-found` alike for a wrong and an expired code, so
  /// the list read right after tells them apart. Unknown list: say wrong code.
  static func from(_ approval: ConnectDeviceApproval, waitingAfter: [WaitingDevice]?, now: Date) -> AllowDeviceOutcome {
    switch approval.status {
    case .approved:
      .allowed(name: approval.deviceLabel ?? "the device", shortId: approval.deviceShortId)
    case .own: .ownCode
    case .paused: .paused
    case .notFound:
      if let waitingAfter, !waitingAfter.contains(where: { !$0.isExpired(at: now) }) {
        .expired
      } else {
        .wrongCode
      }
    }
  }

  public func message(machine: String) -> String {
    switch self {
    case let .allowed(name, shortId):
      "Allowed \([name, shortId].compactMap { $0 }.joined(separator: " · "))"
    case .wrongCode: "That code doesn't match a waiting device. Check it and try again."
    case .expired: "That request expired. Ask the device for a new code."
    case .ownCode: "That is this phone's own code."
    case .paused: "Too many wrong codes. Try again in 10 minutes."
    case .unreachable: "Couldn't reach \(machine)"
    case .noLongerAllowed: "This phone can no longer allow devices on \(machine)."
    }
  }

  public var isSuccess: Bool {
    if case .allowed = self { true } else { false }
  }
}

/// The one code box: uppercase, no spaces or dashes, six characters at most.
public enum AllowDeviceCode {
  public static let length = 6

  public static func normalized(_ typed: String) -> String {
    String(typed.uppercased().filter { $0.isASCII && ($0.isLetter || $0.isNumber) }.prefix(length))
  }
}
