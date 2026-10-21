import Foundation
import SWCWire

/// SpecWeave's read-only ledger projection, separate from provider Todo/plan output.
public struct IncrementProgress: Decodable, Sendable, Equatable {
  public struct TaskRow: Decodable, Sendable, Equatable, Identifiable {
    public let id: String
    public let title: String
    public let status: String
    public let criteria: [String]
    public let note: String?
    public let line: String?
    public let link: String?
    public let commit: String?
  }
  public struct Criterion: Decodable, Sendable, Equatable, Identifiable {
    public let id: String
    public let text: String
    public let met: Bool
  }
  public struct Verification: Decodable, Sendable, Equatable {
    public let ok: Bool
    public let ranAt: String
  }
  public let threadId: String
  public let incrementId: String
  public let binding: String
  public let boundTaskId: String?
  public let title: String?
  public let status: String
  public let incrementPath: String
  public let specPath: String?
  public let readable: Bool
  public let tasks: [TaskRow]
  public let criteria: [Criterion]
  public let verify: Verification?
}

public enum IncrementRead: Sendable, Equatable {
  case bound(IncrementProgress)
  case unbound
  case unavailable(String)
}

private struct IncrementSnapshot: Decodable, Sendable {
  let projectId: String
  let threads: [IncrementProgress]
}

extension LiveEngine {
  public func incrementProgress(for target: ChatTarget) async throws -> IncrementRead {
    guard let entry = machines[target.environmentId] else { throw SyncError.unknownMachine }
    guard entry.isOnline else { return .unavailable("Connect to this machine to read its SpecWeave increment.") }
    // Never start a coordinator just to discover its plan.
    guard let id = threadId(for: target, entry: entry) else {
      return .unavailable("The coordinator thread has not loaded yet. Try again after its messages load.")
    }
    let projectId: String?
    switch target {
    case let .project(ref), let .aide(ref): projectId = ref.projectId
    case .thread: projectId = entry.thread(id)?.projectId ?? controllers[target]?.projection?.thread.projectId
    }
    guard let projectId else { return .unavailable("This thread has no project. A SpecWeave increment requires a project workspace.") }
    do {
      let socket = try await awaitSocket(target.environmentId)
      let result = try await Self.decode(IncrementSnapshot.self, from: socket.call(
        tag: "projects.threadIncrementProgressRead",
        payload: .object(["projectId": .string(projectId), "threadIds": .array([.string(id)])])))
      guard result.projectId == projectId else { throw SyncError.unreadableAnswer }
      return result.threads.first(where: { $0.threadId == id }).map(IncrementRead.bound) ?? .unbound
    } catch { throw SyncError.wrap(error) }
  }
}

extension AppModel {
  /// The UI passes the shared Markdown route parser's decoded identities. Legacy
  /// links without a machine stay local; canonical links name a paired machine.
  public func threadLink(threadId: String, environmentId: String?, from origin: String) throws -> ThreadRef {
    let environmentId = environmentId ?? origin
    guard machine(environmentId) != nil else {
      throw SyncError.sendBlocked("This thread belongs to a machine that is not paired with this phone.")
    }
    let ref = ThreadRef(environmentId: environmentId, threadId: threadId)
    guard thread(ref) != nil else {
      throw SyncError.sendBlocked("This thread is not available on this machine. Open its project and refresh the connection, or open the link on its original machine.")
    }
    return ref
  }
}
