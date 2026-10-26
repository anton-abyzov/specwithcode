import Foundation
import SWCTransport
import SWCWire

extension LiveEngine {
  /// Follows `subscribeDeviceState` on this socket. It only reads state, so it
  /// never starts helpers or installs tools on the machine. An authorization
  /// failure is final for the socket; other failures subscribe again with backoff.
  func watchDevices(_ entry: MachineEntry, _ socket: RpcSocket) async {
    var failures = 0
    while !Task.isCancelled {
      let stream = await socket.stream(tag: RpcMethod.subscribeDeviceState.rawValue, payload: .object([:]))
      do {
        for try await chunk in stream {
          failures = 0
          for value in chunk.values {
            if let state = try? await Self.decode(DeviceServiceState.self, from: value) {
              devicesChanged(entry, socket, MachineDevices(environmentId: entry.environmentId, state: state))
            }
          }
          chunk.ack()
        }
        // The server never ends this stream; one that does has nothing to follow.
        return
      } catch is CancellationError {
        return
      } catch let error as ServerError {
        if case .authorization = error.kind {
          devicesChanged(entry, socket, MachineDevices(support: .unavailable(MachineDevices.notAllowedMessage)))
          return
        }
        Self.log.error("Device subscription failed on \(entry.environmentId, privacy: .public): \(error.message, privacy: .public)")
        // A server without the method fails every time; say so until a value arrives.
        if entry.devices == nil || entry.devices?.support == .loading {
          devicesChanged(entry, socket, MachineDevices(support: .unavailable(MachineDevices.unsupportedMessage)))
        }
      } catch {
        return
      }
      guard !Task.isCancelled, machines[entry.environmentId] === entry, entry.socket === socket, !(await socket.isClosed) else { return }
      try? await Task.sleep(for: resubscribeDelay(afterFailures: failures))
      failures += 1
    }
  }

  func devicesChanged(_ entry: MachineEntry, _ socket: RpcSocket, _ devices: MachineDevices) {
    guard machines[entry.environmentId] === entry, entry.socket === socket, entry.devices != devices else { return }
    entry.devices = devices
    schedulePublish()
  }

  public func deviceHubAccess(machineId: String, hostId: String) async throws -> DeviceHubAccess {
    guard let entry = machines[machineId] else { throw SyncError.unknownMachine }
    guard entry.isOnline else { throw SyncError.machineOffline(label: displayName(entry)) }
    if let message = entry.devices?.support.message { throw SyncError.sendBlocked(message) }
    let hubPath = entry.devices?.hubPath ?? MachineDevices.loading.hubPath
    let (origin, ticket) = try await entry.connection.deviceHubTicket()
    guard let access = DeviceHubAccess(origin: origin, hubPath: hubPath, ticket: ticket, hostId: hostId) else {
      throw TransportError.invalidAddress(origin.absoluteString)
    }
    return access
  }
}
