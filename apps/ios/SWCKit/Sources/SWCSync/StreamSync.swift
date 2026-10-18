import Foundation
import os
import SWCWire

/// Decodes and reduces one machine's shell stream off the main actor. The
/// state outlives sockets so a reconnect resumes with `afterSequence`.
actor ShellSync {
  struct Update: Sendable {
    var snapshot: ShellSnapshot?
    var isSynchronized: Bool
  }

  private var state = ShellState()
  static let log = Logger(subsystem: "com.specwithcode.ios", category: "sync")

  var resumeSequence: Int? { state.resumeSequence }

  func beginSubscription() {
    state.beginSubscription()
  }

  /// Applies a chunk's values. Returns the new state when anything changed.
  func apply(_ values: [JSONValue]) -> Update? {
    var changed = false
    for value in values {
      do {
        changed = state.apply(try value.decode(ShellStreamItem.self)) || changed
      } catch {
        Self.log.error("Skipping unreadable shell item: \(String(describing: error), privacy: .public)")
      }
    }
    return changed ? Update(snapshot: state.snapshot, isSynchronized: state.isSynchronized) : nil
  }
}

/// Decodes and reduces one open thread's stream off the main actor.
actor ThreadSync {
  struct Update: Sendable {
    var projection: ThreadProjection?
    var isSynchronized: Bool
  }

  private(set) var threadId: String?
  private var state = ThreadState()

  /// Starts over when the session moves to another thread.
  func begin(threadId: String) -> Int? {
    if self.threadId != threadId {
      self.threadId = threadId
      state = ThreadState()
    }
    state.beginSubscription()
    return state.resumeSequence
  }

  func apply(_ values: [JSONValue]) -> Update? {
    var changed = false
    for value in values {
      do {
        changed = state.apply(try value.decode(ThreadStreamItem.self)) || changed
      } catch {
        ShellSync.log.error("Skipping unreadable thread item: \(String(describing: error), privacy: .public)")
      }
    }
    return changed ? Update(projection: state.projection, isSynchronized: state.isSynchronized) : nil
  }
}
