import Foundation
import SWCWire
import SWCTransport

public struct HandoffDestination: Identifiable, Hashable, Sendable {
  public let id: String
  public let name: String
  /// A saved checkpoint on the destination can continue without the source.
  public let usesReplica: Bool
  public init(id: String, name: String, usesReplica: Bool) {
    self.id = id; self.name = name; self.usesReplica = usesReplica
  }
}

public struct HandoffOptions: Sendable {
  public let badge: String?
  public let destinations: [HandoffDestination]
  public let notices: [String]
  public init(badge: String?, destinations: [HandoffDestination], notices: [String] = []) {
    self.badge = badge; self.destinations = destinations; self.notices = notices
  }
}

public struct HandoffCheck: Sendable {
  public let allowed: Bool
  public let messages: [String]
  public init(allowed: Bool, messages: [String]) { self.allowed = allowed; self.messages = messages }
}

struct PhoneHandoffSnapshot: Decodable, Sendable {
  struct State: Decodable, Sendable { let threadId: String; let badge: String? }
  struct Incoming: Decodable, Sendable {
    let sourceEnvironmentId: String
    let sourceThreadId: String
    let continuedThreadId: String?
  }
  let threads: [State]
  let incoming: [Incoming]
}
struct PhoneHandoffPreflight: Decodable, Sendable {
  struct Failure: Decodable, Sendable { let message: String }
  let threadId: String
  let ok: Bool
  let failures: [Failure]
  let resume: Bool
}
struct PhoneHandoffResult: Decodable, Sendable {
  let environmentId: String
  let threadId: String
}

extension LiveEngine {
  static let handedOffReason = "This copy was handed off. Open the continued thread on its machine to send messages."

  static func handoffBlock(_ thread: ThreadShell?) -> String? {
    guard thread?.executionState == .fenced || thread?.movedTo?.isHandoff == true else { return nil }
    return handedOffReason
  }

  /// Snapshot reads never checkpoint, move, or start a provider turn.
  public func handoffOptions(for thread: ThreadRef) async throws -> HandoffOptions {
    guard let source = machines[thread.environmentId] else { throw SyncError.unknownMachine }
    var badge: String?
    var destinations: [HandoffDestination] = []
    var notices: [String] = []
    let sourceOnline = source.isOnline
    if sourceOnline {
      let snapshot = try await handoffSnapshot(thread.environmentId)
      badge = snapshot.threads.first { $0.threadId == thread.threadId }?.badge
      if Self.handoffBlock(source.thread(thread.threadId)) != nil {
        return HandoffOptions(badge: "continued", destinations: [], notices: [Self.handoffBlock(source.thread(thread.threadId))!])
      }
    }
    // Only explicitly linked project members are offered for a live move.
    let project = model?.thread(thread)?.projectRef.flatMap { model?.project($0) }
    let members = Set(project?.members.map { $0.ref.environmentId } ?? [])
    for entry in machines.values.sorted(by: { $0.environmentId < $1.environmentId }) where entry.environmentId != thread.environmentId && entry.isOnline && entry.canOperate {
      if sourceOnline {
        if source.canOperate && members.contains(entry.environmentId) {
          destinations.append(.init(id: entry.environmentId, name: displayName(entry), usesReplica: false))
        }
      } else {
        do {
          let snapshot = try await handoffSnapshot(entry.environmentId)
          if snapshot.incoming.contains(where: { $0.sourceEnvironmentId == thread.environmentId && $0.sourceThreadId == thread.threadId }) {
            destinations.append(.init(id: entry.environmentId, name: displayName(entry), usesReplica: true))
          }
        } catch {
          notices.append("\(displayName(entry)): \(SyncError.wrap(error).localizedDescription)")
        }
      }
    }
    return HandoffOptions(badge: badge, destinations: destinations, notices: notices)
  }

  public func checkHandoff(_ thread: ThreadRef, destination: HandoffDestination) async throws -> HandoffCheck {
    guard let entry = machines[destination.id], entry.isOnline, entry.canOperate else { throw SyncError.unknownMachine }
    if destination.usesReplica {
      let snapshot = try await handoffSnapshot(destination.id)
      guard snapshot.incoming.contains(where: { $0.sourceEnvironmentId == thread.environmentId && $0.sourceThreadId == thread.threadId }) else {
        return HandoffCheck(allowed: false, messages: ["This machine has no saved checkpoint of this thread."])
      }
      return HandoffCheck(allowed: true, messages: ["Continue from the saved checkpoint. This machine checks the source lease, project access, files and provider before continuing; it refuses if the source may still be running."])
    }
    guard let source = machines[thread.environmentId], source.isOnline, source.canOperate else { throw SyncError.unknownMachine }
    if let reason = Self.handoffBlock(source.thread(thread.threadId)) { throw SyncError.sendBlocked(reason) }
    let socket = try await awaitSocket(thread.environmentId)
    // Preflight may prepare a checkpoint. Never retry a mutating call blindly.
    let results = try await handoffCall([PhoneHandoffPreflight].self, socket: socket, tag: "handoffMode.preflight", payload: .object([
      "threadIds": .array([.string(thread.threadId)]), "destinationEnvironmentId": .string(destination.id)
    ]))
    guard let result = results.first(where: { $0.threadId == thread.threadId }) else { throw SyncError.unreadableAnswer }
    return HandoffCheck(allowed: result.ok && result.failures.isEmpty, messages: result.failures.isEmpty
      ? [result.resume ? "Checks passed. The thread will resume on \(destination.name)." : "Checks passed. The thread will move to \(destination.name) without starting a new turn."]
      : result.failures.map(\.message))
  }

  public func continueThread(_ thread: ThreadRef, destination: HandoffDestination) async throws -> ThreadRef {
    // Recheck after the confirmation; the server also checks at execution.
    let check = try await checkHandoff(thread, destination: destination)
    guard check.allowed else { throw SyncError.sendBlocked(check.messages.joined(separator: "\n")) }
    let socket = try await awaitSocket(destination.usesReplica ? destination.id : thread.environmentId)
    let payload: JSONValue = destination.usesReplica
      ? .object(["sourceEnvironmentId": .string(thread.environmentId), "sourceThreadId": .string(thread.threadId)])
      : .object(["threadId": .string(thread.threadId), "destinationEnvironmentId": .string(destination.id)])
    let result = try await handoffCall(PhoneHandoffResult.self, socket: socket,
      tag: destination.usesReplica ? "handoffMode.continueHere" : "handoffMode.handOff", payload: payload)
    guard result.environmentId == destination.id else { throw SyncError.unreadableAnswer }
    return ThreadRef(environmentId: result.environmentId, threadId: result.threadId)
  }

  private func handoffCall<T: Decodable & Sendable>(_ type: T.Type, socket: RpcSocket, tag: String, payload: JSONValue) async throws -> T {
    do { return try await Self.decode(type, from: socket.call(tag: tag, payload: payload)) }
    catch { throw SyncError.wrap(error) }
  }

  private func handoffSnapshot(_ environment: String) async throws -> PhoneHandoffSnapshot {
    let socket = try await awaitSocket(environment)
    return try await handoffCall(PhoneHandoffSnapshot.self, socket: socket, tag: "handoffMode.snapshot", payload: .object([:]))
  }
}
