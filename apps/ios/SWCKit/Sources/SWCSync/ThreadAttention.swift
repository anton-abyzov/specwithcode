import Foundation
import SWCWire

/// "1 needs you", "2 need you": the one way a count of attention is said.
public func needsYouLabel(_ count: Int) -> String {
  "\(count) \(count == 1 ? "needs" : "need") you"
}

/// The desktop's rules for what a quiet thread is waiting on, from
/// `reportWaitReason` and `threadDependencyWait`, so both apps sort a thread
/// the same way.
enum ThreadAttention {
  /// An explicit dependency wait in a blocker's final prose paragraph, which is
  /// never a request for the reader; nil when it asks the person anything.
  static func reportWaitReason(_ text: String) -> String? {
    let unfenced = text.replacing(/```[\s\S]*?```/, with: "")
    let prose = (unfenced.split(separator: /\n\s*\n/, omittingEmptySubsequences: false).last.map(String.init) ?? "")
      .trimmingCharacters(in: .whitespacesAndNewlines)
    if prose.hasPrefix(">") || prose.contains("?") { return nil }
    if prose.firstMatch(of: /(?i)\b(?:you|your|anton|approve|approval|permission|decision|sign[ -]?in|license|credential)\b/) != nil { return nil }
    let plain = prose.replacing(/[*_`]/, with: "")
    guard let wait = plain.firstMatch(of: /(?i)(?:^|[.!]\s+)(?:(?:blockers?|blocked)\s*:\s*)?(?:now\s+)?(?:waiting (?:on|for)|wait for|blocked (?:on|by))\s+(.+)/) else { return nil }
    let dependency = String(wait.1)
    if dependency.prefixMatch(of: /(?i)(?:the\s+)?(?:CI|checks?|builds?|tests?)(?:\b|$)/) != nil { return "Waiting for CI" }
    if dependency.prefixMatch(of: /(?i)(?:a\s+|the\s+|fresh\s+)*(?:review|reviewer)(?:\b|$)/) != nil { return "Waiting for review" }
    if dependency.prefixMatch(of: /(?i)(?:(?:the|a)\s+)?(?:PRs?|pull requests?)(?:\b|$)|(?:the\s+)?merge\b|#[0-9]+.*\bmerg/) != nil { return "Waiting for PR merge" }
    if dependency.prefixMatch(of: /(?i)(?:the\s+|my\s+)?(?:subagents?|agents?|workers?)(?:\b|$)/) != nil { return "Waiting for subagents" }
    return nil
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
    guard !thread.isSettled, thread.pendingRuntimeRequest == nil, !isActive(thread),
          let blocker = thread.reportedBlocker?.trimmingCharacters(in: .whitespacesAndNewlines), !blocker.isEmpty
    else { return false }
    return !reportsToParentAgent(thread) && reportWaitReason(blocker) == nil
  }

  private static func backgroundWait(_ thread: ThreadShell) -> String? {
    let tasks = thread.pendingBackgroundTasks
    if tasks.isEmpty || thread.status == .failed || (thread.heldQueuedCount ?? 0) > 0 || thread.hasActionableProposedPlan || needsReply(thread) {
      return nil
    }
    if isActive(thread) { return nil }
    if tasks.allSatisfy({ $0.kind == .command }) { return "Background command running" }
    return tasks.allSatisfy { $0.kind == .subagent } ? "Waiting for subagents" : "Waiting for background work"
  }

  /// What a thread is waiting on other than the person. Words for its row; the
  /// thread itself counts as working.
  static func dependencyWait(_ thread: ThreadShell) -> String? {
    // A failed run waits on nothing; here it needs the person, whatever its last report said.
    if thread.isSettled || thread.archivedAt != nil || thread.status == .failed { return nil }
    if let background = backgroundWait(thread) { return background }
    if thread.isSubagent, [ThreadStatus.completed, .cancelled, .failed, .interrupted].contains(thread.status) { return nil }
    if thread.status == .waiting {
      if thread.activeWork?.waitThreadId != nil { return "Waiting for subagents" }
      return reportWaitReason(thread.activeWork?.label ?? "") ?? "Waiting for background work"
    }
    if isActive(thread) || reportsToParentAgent(thread) { return nil }
    if let blocker = thread.reportedBlocker, !blocker.isEmpty, reportWaitReason(blocker) == nil { return nil }
    return thread.reportedWait ?? reportWaitReason(thread.reportedBlocker ?? "")
  }
}
