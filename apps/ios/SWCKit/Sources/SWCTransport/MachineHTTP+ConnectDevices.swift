import Foundation
import SWCWire

/// How this phone signs a request about the machine's devices.
public enum ConnectDevicesCredential: Sendable {
  case bearer(String)
  case dpop(token: String, key: any DpopKey)
}

/// `POST /api/auth/connect-devices/list`, reduced to what the phone shows. The
/// server never puts a waiting device's code in this list.
public struct ConnectDevicesList: Sendable, Hashable {
  public struct Pending: Sendable, Hashable, Identifiable {
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
  }

  /// This phone may approve here, and the machine's device list is healthy.
  public var canApprove: Bool
  public var pending: [Pending]

  public init(canApprove: Bool, pending: [Pending]) {
    self.canApprove = canApprove
    self.pending = pending
  }
}

/// `POST /api/auth/connect-devices/approve`.
public struct ConnectDeviceApproval: Sendable, Hashable {
  public enum Status: String, Sendable, Hashable {
    case approved
    case notFound = "not-found"
    case own = "self"
    case paused
  }

  public var status: Status
  public var deviceLabel: String?
  public var deviceShortId: String?

  public init(status: Status, deviceLabel: String? = nil, deviceShortId: String? = nil) {
    self.status = status
    self.deviceLabel = deviceLabel
    self.deviceShortId = deviceShortId
  }
}

extension MachineHTTP {
  public func connectDevicesList(credential: ConnectDevicesCredential, at httpBase: URL) async throws -> ConnectDevicesList {
    let data = try await connectDevicesPost("/api/auth/connect-devices/list", body: Data("{}".utf8), credential: credential, at: httpBase)
    let body = try decode(ListResponse.self, from: data)
    return ConnectDevicesList(
      canApprove: body.canApprove && body.health == "ok",
      pending: body.pending.map {
        .init(id: $0.id, label: $0.label, shortId: $0.shortId, expiresAt: $0.expiresAt.flatMap(WireCoding.parseDate))
      }
    )
  }

  /// The code goes only in this request's body. It is never logged or kept.
  public func approveConnectDevice(code: String, credential: ConnectDevicesCredential, at httpBase: URL) async throws -> ConnectDeviceApproval {
    let payload = try JSONEncoder().encode(["code": code])
    let data = try await connectDevicesPost("/api/auth/connect-devices/approve", body: payload, credential: credential, at: httpBase)
    let body = try decode(ApproveResponse.self, from: data)
    guard let status = ConnectDeviceApproval.Status(rawValue: body.status) else {
      throw TransportError.invalidResponse("Unknown approval status")
    }
    return ConnectDeviceApproval(status: status, deviceLabel: body.device?.label, deviceShortId: body.device?.shortId)
  }

  private func connectDevicesPost(_ path: String, body: Data, credential: ConnectDevicesCredential, at httpBase: URL) async throws -> Data {
    var request = try makeRequest(httpBase, path, timeout: requestTimeout)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = body
    switch credential {
    case let .bearer(token):
      request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    case let .dpop(token, key):
      request.setValue("DPoP \(token)", forHTTPHeaderField: "Authorization")
      request.setValue(try DpopProof.make(key: key, method: "POST", url: request.url!, accessToken: token, now: now()), forHTTPHeaderField: "DPoP")
    }
    return try await perform(request, timeout: requestTimeout, authenticated: true)
  }

  private struct ListResponse: Decodable {
    struct Request: Decodable {
      let id: String
      let label: String
      let shortId: String?
      let expiresAt: String?
    }

    let health: String
    let canApprove: Bool
    let pending: [Request]
  }

  private struct ApproveResponse: Decodable {
    struct Device: Decodable {
      let label: String
      let shortId: String?
    }

    let status: String
    let device: Device?
  }
}

extension TransportError {
  var isAwaitingApproval: Bool {
    if case .awaitingApproval = self { true } else { false }
  }

  /// The network failed mid-request, so the machine may have acted on it.
  var mayHaveLanded: Bool {
    switch self {
    case .unreachable, .timedOut, .closed: true
    default: false
    }
  }
}
