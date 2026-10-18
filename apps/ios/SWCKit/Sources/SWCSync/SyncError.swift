import Foundation
import SWCTransport
import SWCWire

/// Failures the engine reports. Each has a sentence the UI can show as is.
public enum SyncError: Error, Sendable, Hashable {
  case unknownMachine
  case machineOffline(label: String)
  case noMachineConnected
  /// A paired machine is offline or has not listed its projects yet.
  case machinesNotLoaded
  case projectNotFound
  case nothingRunning
  case emptyMessage
  case emptyTitle
  case requestGone
  case sendBlocked(String)
  /// The project changed since it was read. `latest` is the fresh copy, when it loaded.
  case projectConflict(latest: ProjectSettingsDraft?)
  /// A typed failure from the machine.
  case server(ServerError)
  case unreadableAnswer
  case storage(String)

  /// Makes any error readable: server and decoding failures are wrapped,
  /// errors that already explain themselves pass through.
  public static func wrap(_ error: Error) -> Error {
    switch error {
    case let error as SyncError: error
    case let error as ServerError: SyncError.server(error)
    case is TransportError, is PairingLinkError, is CancellationError: error
    case is DecodingError, is EncodingError: SyncError.unreadableAnswer
    case let error as KeychainError: SyncError.storage(error.description)
    default: error
    }
  }

  /// The machine's typed error, when there is one.
  public var serverError: ServerError? {
    if case let .server(error) = self { return error }
    return nil
  }
}

extension SyncError: LocalizedError {
  public var errorDescription: String? {
    switch self {
    case .unknownMachine:
      "That computer is no longer paired."
    case let .machineOffline(label):
      "\(label.isEmpty ? "That computer" : label) is offline. Try again when it reconnects."
    case .noMachineConnected:
      "No computer is connected. Open SpecWithCode on one of your computers and try again."
    case .machinesNotLoaded:
      "Aide may already be on a computer that hasn't connected yet. Reconnect your computers, then try again."
    case .projectNotFound:
      "This project no longer exists on that computer."
    case .nothingRunning:
      "Nothing is running."
    case .emptyMessage:
      "Type a message first."
    case .emptyTitle:
      "A name can't be empty."
    case .requestGone:
      "That request is no longer waiting for an answer."
    case let .sendBlocked(reason):
      reason
    case .projectConflict:
      "Someone else changed this project. The latest settings are loaded; make your change again."
    case let .server(error):
      error.message
    case .unreadableAnswer:
      "The computer sent an answer the app could not read."
    case let .storage(detail):
      "The app could not save the computer's sign-in (\(detail))."
    }
  }
}
