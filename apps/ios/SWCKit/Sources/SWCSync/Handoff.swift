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

public struct HandoffUncertain: LocalizedError, Sendable {
  public let detail: String
  public var errorDescription: String? { detail }
}

/// Persist before dispatch, so dismissing the sheet or restarting the app cannot
/// turn an uncertain mutation into a fresh request. Only source proof clears it.
@MainActor final class HandoffJournal {
  private let defaults: UserDefaults?
  private var entries: [String: String]
  private static let storageKey = "pendingPhoneHandoffs"
  init(defaults: UserDefaults? = nil) {
    self.defaults = defaults
    entries = defaults?.dictionary(forKey: Self.storageKey) as? [String: String] ?? [:]
  }
  private func key(_ ref: ThreadRef) -> String {
    String(data: try! JSONEncoder().encode([ref.environmentId, ref.threadId]), encoding: .utf8)!
  }
  subscript(ref: ThreadRef) -> String? {
    get { entries[key(ref)] }
    set { entries[key(ref)] = newValue; defaults?.set(entries, forKey: Self.storageKey) }
  }
}

struct PhoneHandoffSnapshot: Decodable, Sendable {
  struct State: Decodable, Sendable {
    let threadId: String
    let badge: String?
    let continuedOn: PhoneHandoffResult?
    let lastError: String?
  }
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
    if thread?.movedTo?.isHandoff == true { return handedOffReason }
    if thread?.executionState == .fenced { return "This source is fenced. Handoff completion is not confirmed; no turn can start here." }
    return nil
  }

  /// Snapshot reads never checkpoint, move, or start a provider turn.
  public func handoffOptions(for thread: ThreadRef) async throws -> HandoffOptions {
    guard let source = machines[thread.environmentId] else { throw SyncError.unknownMachine }
    let shell = source.thread(thread.threadId)
    let project = model?.thread(thread)?.projectRef.flatMap { model?.project($0) }
    if project?.kind == .personal || (model?.aide?.ref.environmentId == thread.environmentId && shell != nil && shell?.projectId == model?.aide?.ref.projectId) {
      return HandoffOptions(badge: nil, destinations: [], notices: ["Aide stays private to its machine and cannot be handed off."])
    }
    var badge: String?
    var destinations: [HandoffDestination] = []
    var notices: [String] = []
    let sourceOnline = source.isOnline
    if sourceOnline {
      let snapshot = try await handoffSnapshot(thread.environmentId)
      let state = snapshot.threads.first { $0.threadId == thread.threadId }
      badge = state?.badge
      if state?.continuedOn != nil || shell?.movedTo?.isHandoff == true {
        handoffJournal[thread] = nil
        return HandoffOptions(badge: "continued", destinations: [], notices: [Self.handedOffReason])
      }
      if badge == "handing-off" || shell?.executionState == .fenced {
        return HandoffOptions(badge: "handing-off", destinations: [], notices:
          ["Handoff is in doubt. The source cannot start a turn. Refresh only checks status; it does not retry or recover the transfer."] + (state?.lastError.map { [$0] } ?? []))
      }
    }
    if let pending = handoffJournal[thread] {
      return HandoffOptions(badge: "handing-off", destinations: [], notices: ["Handoff completion is unconfirmed. No automatic retry is safe. Refresh only reads status.", pending])
    }
    // Only explicitly linked project members are offered for a live move.
    let members = Set(project?.members.filter(\.isLinked).map { $0.ref.environmentId } ?? [])
    if sourceOnline, let shell, shell.activeRunId == nil {
      notices.append("No turn is running on the source. A handoff can move this conversation; the server checks whether it should resume or wait for your next message.")
    }
    if sourceOnline && !source.canOperate { notices.append("This phone has read-only access to the source machine.") }
    if sourceOnline && members.subtracting([thread.environmentId]).isEmpty {
      notices.append("This project is not linked to another machine. Link it from the desktop app before handing off.")
    }
    for entry in machines.values.sorted(by: { $0.environmentId < $1.environmentId }) where entry.environmentId != thread.environmentId {
      guard entry.isOnline else {
        notices.append("\(displayName(entry)): offline or unreachable from this phone.")
        continue
      }
      guard entry.canOperate else {
        notices.append("\(displayName(entry)): this phone has read-only access.")
        continue
      }
      if sourceOnline {
        if source.canOperate && members.contains(entry.environmentId) {
          destinations.append(.init(id: entry.environmentId, name: displayName(entry), usesReplica: false))
        } else if !members.contains(entry.environmentId) {
          notices.append("\(displayName(entry)): this project is not linked here.")
        }
      } else {
        do {
          let snapshot = try await handoffSnapshot(entry.environmentId)
          if snapshot.incoming.contains(where: { $0.sourceEnvironmentId == thread.environmentId && $0.sourceThreadId == thread.threadId }) {
            destinations.append(.init(id: entry.environmentId, name: displayName(entry), usesReplica: true))
          } else {
            notices.append("\(displayName(entry)): no saved checkpoint of this thread.")
          }
        } catch {
          notices.append("\(displayName(entry)): \(SyncError.wrap(error).localizedDescription)")
        }
      }
    }
    return HandoffOptions(badge: badge, destinations: destinations, notices: notices)
  }

  public func checkHandoff(_ thread: ThreadRef, destination: HandoffDestination) async throws -> HandoffCheck {
    if let pending = handoffJournal[thread] { throw HandoffUncertain(detail: pending) }
    let project = model?.thread(thread)?.projectRef.flatMap { model?.project($0) }
    if project?.kind == .personal || (model?.aide?.ref.environmentId == thread.environmentId && machines[thread.environmentId]?.thread(thread.threadId)?.projectId != nil && machines[thread.environmentId]?.thread(thread.threadId)?.projectId == model?.aide?.ref.projectId) {
      return HandoffCheck(allowed: false, messages: ["Aide stays private to its machine and cannot be handed off."])
    }
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
    handoffJournal[thread] = "A handoff request was dispatched. Source confirmation is pending."
    do {
      let result = try await handoffCall(PhoneHandoffResult.self, socket: socket,
        tag: destination.usesReplica ? "handoffMode.continueHere" : "handoffMode.handOff", payload: payload)
      guard result.environmentId == destination.id else { throw SyncError.unreadableAnswer }
      let moved = machines[thread.environmentId]?.thread(thread.threadId)?.movedTo
      if moved?.isHandoff == true && moved?.environmentId == result.environmentId && moved?.threadId == result.threadId {
        handoffJournal[thread] = nil
        return ThreadRef(environmentId: result.environmentId, threadId: result.threadId)
      }
      guard machines[thread.environmentId]?.isOnline == true else {
        throw HandoffUncertain(detail: "The destination returned a continuation, but the source is unreachable. Completion is not confirmed by the source.")
      }
      let snapshot = try await handoffSnapshot(thread.environmentId)
      let confirmed = snapshot.threads.first { $0.threadId == thread.threadId }?.continuedOn
      guard confirmed?.environmentId == result.environmentId, confirmed?.threadId == result.threadId else {
        throw HandoffUncertain(detail: "The destination returned a continuation, but the source has not confirmed this transfer.")
      }
      handoffJournal[thread] = nil
      return ThreadRef(environmentId: result.environmentId, threadId: result.threadId)
    } catch {
      // An RPC failure after dispatch is not proof that the move was refused.
      // Preserve its exact message, never retry a mutating request automatically.
      handoffJournal[thread] = error.localizedDescription
      throw HandoffUncertain(detail: error.localizedDescription)
    }
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
