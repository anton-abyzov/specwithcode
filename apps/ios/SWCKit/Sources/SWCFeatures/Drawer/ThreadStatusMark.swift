import SwiftUI
import SWCSync
import Weave

/// A thread's state in a fixed column at the start of its row, in the
/// desktop's language: a speech bubble waits on you, a barred circle cannot
/// move, a check is finished. Rows never move for a status change.
struct ThreadStatusMark: View {
  let thread: ThreadSummary

  var body: some View {
    Group {
      switch Self.state(of: thread) {
      case .unknown: symbol("questionmark.circle", Color.weave.muted)
      case .offline: StatusDot(.offline)
      case .needsYou: symbol("bubble.left.fill", Color.weave.warn)
      case .failed: symbol("minus.circle", Color.weave.fail)
      case .working:
        ProgressView()
          .controlSize(.small)
          .tint(Color.weave.iris)
      case .done: symbol("checkmark", Color.weave.muted)
      case .idle: StatusDot(.idle)
      }
    }
    .frame(width: 20, height: 20)
    .accessibilityHidden(true)
  }

  private func symbol(_ name: String, _ color: Color) -> some View {
    Image(systemName: name)
      .font(.system(size: 14, weight: .semibold))
      .foregroundStyle(color)
  }

  enum State: Equatable {
    case unknown, offline, needsYou, failed, working, done, idle

    var label: String {
      switch self {
      case .unknown: "Unknown"
      case .offline: "Offline"
      case .needsYou: "Needs you"
      case .failed: "Failed"
      case .working: "Working"
      case .done: "Done"
      case .idle: "Idle"
      }
    }
  }

  static func state(of thread: ThreadSummary) -> State {
    // An offline machine's run state is out of date, so nothing else is claimed.
    if !thread.machineOnline { return .offline }
    if thread.isUnknown { return .unknown }
    switch thread.activity {
    case .needsYou: return .needsYou
    case .working: return .working
    case .failed: return .failed
    case .idle:
      if thread.waitsOnUser { return .needsYou }
      if thread.waitReason != nil { return .working }
      return thread.isDone ? .done : .idle
    }
  }
}
