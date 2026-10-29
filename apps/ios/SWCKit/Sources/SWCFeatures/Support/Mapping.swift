import SwiftUI
import SWCSync
import Weave

// Maps the UI contract's types onto the Weave components that draw them.

extension ThreadActivity {
  var weaveStatus: WeaveStatus {
    switch self {
    case .needsYou: .needsYou
    case .working: .working
    case .failed: .failed
    case .idle: .idle
    }
  }

  var label: String {
    switch self {
    case .needsYou: "Needs you"
    case .working: "Working"
    case .failed: "Failed"
    case .idle: "Idle"
    }
  }
}

extension MachineStatus {
  var weaveStatus: WeaveStatus {
    switch self {
    case .connected: .online
    case .connecting, .reconnecting: .connecting
    case .offline: .offline
    case .needsRepair, .unsupported: .failed
    }
  }

  /// The connection dropped and is waiting to try again. A live connection, a
  /// first attempt in flight, and pairings that need the person do not count.
  var canWake: Bool { self == .offline || self == .reconnecting }

  /// Trying to reach the machine right now.
  var isConnecting: Bool { self == .connecting || self == .reconnecting }
}

extension MachineSummary {
  /// Online but catching up after a failed stream, so its lists may be a
  /// little out of date: shown like a connection in progress.
  var displayStatus: WeaveStatus { isStale ? .connecting : status.weaveStatus }

  var statusLabel: String { isDisconnected ? "Disconnected on this phone" : connectStatusLabel ?? (isStale ? "Catching up" : status.label) }
}

extension UserMessageState {
  /// The line under a message bubble that is not part of the conversation yet.
  var footnote: String? {
    switch self {
    case .sent: nil
    case .sending: "Sending"
    case .queued: "Queued"
    case .held: "Queued, on hold"
    }
  }
}

extension ToolStatus {
  var progressState: WeaveProgressState {
    switch self {
    case .running: .running
    case .completed: .completed
    case .failed: .failed
    }
  }
}

extension TodoStep.Status {
  var progressState: WeaveProgressState {
    switch self {
    case .pending: .pending
    case .running: .running
    case .completed: .completed
    }
  }
}

extension ProjectIcon {
  var avatarIcon: ProjectAvatar.Icon {
    switch self {
    case let .symbol(name, color): .lucide(name: name, tint: color)
    case let .emoji(emoji): .emoji(emoji)
    case let .monogram(text, color): .monogram(text, tint: color)
    case .none: .none
    }
  }
}

extension ApprovalCard.Decision {
  var engineDecision: ApprovalDecision { ApprovalDecision(rawValue: rawValue) ?? .deny }
}

extension ChatTarget {
  var projectRef: ProjectRef? {
    switch self {
    case let .aide(p), let .project(p): p
    case .thread: nil
    }
  }

  var threadRef: ThreadRef? {
    if case let .thread(t) = self { return t }
    return nil
  }
}

extension ThreadSummary {
  /// Needs an answer or a look: waiting for approval, or the last run failed.
  var needsAttention: Bool { !isResolved && (activity == .needsYou || activity == .failed) }
}

extension AppModel {
  /// Every paired machine is online and has answered, so a missing Aide really
  /// is missing. An offline machine may hold Aide; until it is back, offering
  /// to set Aide up could create a second one.
  var allMachinesLoaded: Bool {
    !isLoading && allShellsLoaded && !machines.isEmpty && machines.allSatisfy { $0.status.isOnline }
  }

  /// Machines whose lists are catching up right now.
  var staleMachines: [MachineSummary] { machines.filter(\.isStale) }

  /// Asks a dropped machine connection to come back now, skipping the rest
  /// of its backoff. Leaves a live connection alone, where a reconnect would
  /// close a healthy socket and replay every subscription.
  func wakeMachine(_ machineId: String) {
    guard machine(machineId)?.status.canWake == true else { return }
    engine.wake(machineId: machineId)
  }

  /// Every known thread once, newest first.
  var allThreads: [ThreadSummary] {
    var seen = Set<ThreadRef>()
    var result: [ThreadSummary] = []
    for thread in threadsByProject.values.flatMap({ $0 }) + recentThreads where seen.insert(thread.ref).inserted {
      result.append(thread)
    }
    return result.sorted { $0.updatedAt > $1.updatedAt }
  }
}
