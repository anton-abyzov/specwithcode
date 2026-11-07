import Foundation
import Synchronization
import SWCWire

/// "1 needs you", "2 need you": the one way a count of attention is said.
public func needsYouLabel(_ count: Int) -> String {
  "\(count) \(count == 1 ? "needs" : "need") you"
}

/// The desktop's rules for what a quiet thread is waiting on, from
/// `reportWaitReason` and `threadDependencyWait`, so both apps sort a thread
/// the same way.
enum ThreadAttention {
  // Compiled once: a regex literal inside a function is built again on every
  // call, and these run for every thread on every publish.
  nonisolated(unsafe) private static let fence = /```[\s\S]*?```/
  nonisolated(unsafe) private static let paragraphBreak = /\n\s*\n/
  nonisolated(unsafe) private static let asksThePerson = /(?i)\b(?:you|your|anton|approve|approval|permission|decision|sign[ -]?in|license|credential)\b/
  nonisolated(unsafe) private static let emphasis = /[*_`]/
  nonisolated(unsafe) private static let explicitWait = /(?i)(?:^|[.!]\s+)(?:(?:blockers?|blocked)\s*:\s*)?(?:now\s+)?(?:waiting (?:on|for)|wait for|blocked (?:on|by))\s+(.+)/
  nonisolated(unsafe) private static let ciDependency = /(?i)(?:the\s+)?(?:CI|checks?|builds?|tests?)(?:\b|$)/
  nonisolated(unsafe) private static let reviewDependency = /(?i)(?:a\s+|the\s+|fresh\s+)*(?:review|reviewer)(?:\b|$)/
  nonisolated(unsafe) private static let mergeDependency = /(?i)(?:(?:the|a)\s+)?(?:PRs?|pull requests?)(?:\b|$)|(?:the\s+)?merge\b|#[0-9]+.*\bmerg/
  nonisolated(unsafe) private static let subagentDependency = /(?i)(?:the\s+|my\s+)?(?:subagents?|agents?|workers?)(?:\b|$)/

  /// Counts `reportWaitReason` calls in the current task, for tests.
  @TaskLocal static var evaluations: EvaluationCounter?

  final class EvaluationCounter: Sendable {
    private let storage = Mutex(0)
    var count: Int { storage.withLock { $0 } }
    func increment() { storage.withLock { $0 += 1 } }
  }

  /// An explicit dependency wait in a blocker's final prose paragraph, which is
  /// never a request for the reader; nil when it asks the person anything.
  static func reportWaitReason(_ text: String) -> String? {
    evaluations?.increment()
    let unfenced = text.replacing(fence, with: "")
    let prose = (unfenced.split(separator: paragraphBreak, omittingEmptySubsequences: false).last.map(String.init) ?? "")
      .trimmingCharacters(in: .whitespacesAndNewlines)
    if prose.hasPrefix(">") || prose.contains("?") { return nil }
    if prose.firstMatch(of: asksThePerson) != nil { return nil }
    let plain = prose.replacing(emphasis, with: "")
    guard let wait = plain.firstMatch(of: explicitWait) else { return nil }
    let dependency = String(wait.1)
    if dependency.prefixMatch(of: ciDependency) != nil { return "Waiting for CI" }
    if dependency.prefixMatch(of: reviewDependency) != nil { return "Waiting for review" }
    if dependency.prefixMatch(of: mergeDependency) != nil { return "Waiting for PR merge" }
    if dependency.prefixMatch(of: subagentDependency) != nil { return "Waiting for subagents" }
    return nil
  }

  /// One thread's `reportWaitReason` answers by text, so the attention rules
  /// below read each distinct text once however often they ask.
  struct Reasons {
    private var known: [String: String?] = [:]

    mutating func callAsFunction(_ text: String) -> String? {
      if let reason = known[text] { return reason }
      let reason = reportWaitReason(text)
      known[text] = reason
      return reason
    }
  }

  /// What a thread's row says about attention: whether its last message asks
  /// the person, and what else it waits on.
  struct Attention: Equatable {
    var needsReply: Bool
    var dependencyWait: String?
  }

  /// `needsReply` and `dependencyWait` together, reading each text once.
  static func attention(_ thread: ThreadShell) -> Attention {
    var reasons = Reasons()
    let reply = needsReply(thread, &reasons)
    return Attention(needsReply: reply, dependencyWait: dependencyWait(thread, needsReply: reply, &reasons))
  }

  /// A child's report is read by an agent, not the person: a provider's
  /// subagent, or a delegated child of anything but a coordinator.
  static func reportsToParentAgent(_ thread: ThreadShell) -> Bool {
    guard thread.isSubagent else { return false }
    if thread.creationSource == .provider { return true }
    return thread.lineage.parentThreadId.map { !$0.hasPrefix("project-coordinator:") } ?? false
  }

  private static func isActive(_ thread: ThreadShell) -> Bool {
    thread.status.isWorking || thread.activityRunStatus?.isWorking == true
  }

  /// The ask lives only in the thread's last message; a resumed turn supersedes it.
  static func needsReply(_ thread: ThreadShell) -> Bool {
    var reasons = Reasons()
    return needsReply(thread, &reasons)
  }

  private static func needsReply(_ thread: ThreadShell, _ reasons: inout Reasons) -> Bool {
    guard !thread.isSettled, thread.pendingRuntimeRequest == nil, !isActive(thread),
          let blocker = thread.reportedBlocker?.trimmingCharacters(in: .whitespacesAndNewlines), !blocker.isEmpty
    else { return false }
    return !reportsToParentAgent(thread) && reasons(blocker) == nil
  }

  private static func backgroundWait(_ thread: ThreadShell, needsReply: Bool) -> String? {
    let tasks = thread.pendingBackgroundTasks
    if tasks.isEmpty || thread.status == .failed || (thread.heldQueuedCount ?? 0) > 0 || thread.hasActionableProposedPlan || needsReply {
      return nil
    }
    if isActive(thread) { return nil }
    if tasks.allSatisfy({ $0.kind == .command }) { return "Background command running" }
    return tasks.allSatisfy { $0.kind == .subagent } ? "Waiting for subagents" : "Waiting for background work"
  }

  /// What a thread is waiting on other than the person. Words for its row; the
  /// thread itself counts as working.
  static func dependencyWait(_ thread: ThreadShell) -> String? {
    var reasons = Reasons()
    return dependencyWait(thread, needsReply: nil, &reasons)
  }

  /// - Parameter needsReply: `needsReply(thread)` when the caller has it;
  ///   nil reads it here, only when the thread has background work.
  private static func dependencyWait(_ thread: ThreadShell, needsReply known: Bool?, _ reasons: inout Reasons) -> String? {
    // A failed run waits on nothing; here it needs the person, whatever its last report said.
    if thread.isSettled || thread.archivedAt != nil || thread.status == .failed { return nil }
    if !thread.pendingBackgroundTasks.isEmpty, let background = backgroundWait(thread, needsReply: known ?? needsReply(thread, &reasons)) { return background }
    if thread.isSubagent, [ThreadStatus.completed, .cancelled, .failed, .interrupted].contains(thread.status) { return nil }
    if thread.status == .waiting {
      if thread.activeWork?.waitThreadId != nil { return "Waiting for subagents" }
      return reasons(thread.activeWork?.label ?? "") ?? "Waiting for background work"
    }
    if isActive(thread) || reportsToParentAgent(thread) { return nil }
    if let blocker = thread.reportedBlocker, !blocker.isEmpty, reasons(blocker) == nil { return nil }
    return thread.reportedWait ?? reasons(thread.reportedBlocker ?? "")
  }
}
