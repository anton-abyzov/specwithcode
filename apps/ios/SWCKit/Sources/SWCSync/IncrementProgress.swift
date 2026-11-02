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

extension IncrementProgress {
  /// Tasks the ledger shows as done or skipped.
  public var settledCount: Int { tasks.filter { $0.status == "done" || $0.status == "skipped" }.count }
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
  /// The UI passes the shared Markdown route parser's decoded identities. A link
  /// naming a machine stays on it; a bare link may name another machine's worker.
  public func threadLink(threadId: String, environmentId: String?, threadIds: [String] = [], title: String? = nil, from origin: String) throws -> ThreadRef {
    try threadLinkResult(threadId: threadId, environmentId: environmentId, threadIds: threadIds, title: title, label: nil, from: origin, machines: threadLinkMachines()).get()
  }

  /// `threadLink`, then the machines' archived threads, which the live lists leave
  /// out. Only then the label: a valid ID outranks a live thread with the same title.
  public func openThreadLink(threadId: String, environmentId: String?, threadIds: [String] = [], title: String? = nil, label: String? = nil, from origin: String) async throws -> ThreadRef {
    let machines = threadLinkMachines()
    let live = threadLinkResult(threadId: threadId, environmentId: environmentId, threadIds: threadIds, title: title, label: nil, from: origin, machines: machines)
    switch live {
    case .failure(.missing), .failure(.stillLoading): break
    default: return try live.get()
    }
    let archived = await engine.archivedThreadLinkMachines()
    return try threadLinkResult(threadId: threadId, environmentId: environmentId, threadIds: threadIds, title: title, label: label, from: origin, machines: ThreadLinkResolver.merging(archived, into: machines)).get()
  }

  private func threadLinkMachines() -> [ThreadLinkResolver.Machine] {
    engine.threadLinkMachines() ?? machines.map { machine in
      ThreadLinkResolver.Machine(environmentId: machine.id, threads: (threadsByProject.values.flatMap { $0 } + recentThreads)
        .filter { $0.ref.environmentId == machine.id }
        .map { ThreadLinkResolver.Thread(id: $0.ref.threadId, title: $0.title, isDeleted: false) })
    }
  }

  private func threadLinkResult(threadId: String, environmentId: String?, threadIds: [String], title: String?, label: String?, from origin: String, machines: [ThreadLinkResolver.Machine]) -> Result<ThreadRef, ThreadLinkError> {
    let candidates = threadIds.isEmpty ? [threadId] : threadIds
    let titles = [title].compactMap { $0 } + candidates + [label].compactMap { $0 }
    switch ThreadLinkResolver.resolve(candidates: candidates, environmentId: environmentId, titles: titles, origin: origin, machines: machines) {
    case let .thread(ref): return .success(ref)
    case .deleted: return .failure(.deleted)
    case .unpairedMachine: return .failure(.unpairedMachine)
    case .stillLoading: return .failure(.stillLoading)
    case .missing: return .failure(.missing)
    }
  }
}

enum ThreadLinkError: LocalizedError, Equatable {
  case deleted, unpairedMachine, stillLoading, missing

  var errorDescription: String? {
    switch self {
    case .deleted: "This thread was deleted."
    case .unpairedMachine: "This thread belongs to a machine that is not paired with this phone."
    case .stillLoading: "This thread may be on a machine that has not loaded yet. Try again once that machine connects."
    // The server drops deleted threads from its lists, so a deleted one lands here too.
    case .missing: "This thread is not available on this machine. It may have been deleted. Otherwise open its project and refresh the connection, or open the link on its original machine."
    }
  }
}
