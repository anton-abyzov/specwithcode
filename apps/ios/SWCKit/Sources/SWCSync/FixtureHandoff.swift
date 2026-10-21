import Foundation

extension FixtureEngine {
  public func handoffOptions(for thread: ThreadRef) async throws -> HandoffOptions {
    guard scenario.isFleet else { return HandoffOptions(badge: nil, destinations: []) }
    return HandoffOptions(badge: "ready", destinations: [
      HandoffDestination(id: FixtureFleet.minis, name: "Minis", usesReplica: false)
    ])
  }

  public func checkHandoff(_ thread: ThreadRef, destination: HandoffDestination) async throws -> HandoffCheck {
    HandoffCheck(allowed: true, messages: ["Checks passed. The thread will resume on \(destination.name)."])
  }

  public func continueThread(_ thread: ThreadRef, destination: HandoffDestination) async throws -> ThreadRef {
    // Fixture only. The live engine uses the destination's returned thread id.
    ThreadRef(environmentId: destination.id, threadId: thread.threadId)
  }
}
