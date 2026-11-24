import Foundation
import SWCTransport

extension LiveEngine {
  public func allowDeviceListing(machineId: String) async -> AllowDeviceListing {
    guard let entry = machines[machineId], entry.approvalCode == nil else { return .unavailable }
    guard entry.isOnline else { return .unreachable }
    let http = self.http
    do {
      let list = try await entry.connection.withDeviceApprovalCredential({ credential, base in
        try await http.connectDevicesList(credential: credential, at: base)
      }, directAnswerCounts: { $0.canApprove })
      guard list.canApprove else { return .unavailable }
      return .ready(list.pending.map {
        WaitingDevice(id: $0.id, label: $0.label, shortId: $0.shortId, expiresAt: $0.expiresAt)
      })
    } catch {
      return AllowDeviceListing.after(error)
    }
  }

  public func allowDevice(code: String, machineId: String) async -> AllowDeviceOutcome {
    guard let entry = machines[machineId], entry.approvalCode == nil, entry.isOnline else { return .unreachable }
    let http = self.http
    do {
      let approval = try await entry.connection.withDeviceApprovalCredential { credential, base in
        try await http.approveConnectDevice(code: code, credential: credential, at: base)
      }
      guard approval.status == .notFound else {
        return AllowDeviceOutcome.from(approval, waitingAfter: nil, now: Date())
      }
      var waiting: [WaitingDevice]?
      if case let .ready(devices) = await allowDeviceListing(machineId: machineId) { waiting = devices }
      return AllowDeviceOutcome.from(approval, waitingAfter: waiting, now: Date())
    } catch {
      return AllowDeviceOutcome.after(error)
    }
  }
}
