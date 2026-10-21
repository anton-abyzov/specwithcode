import Foundation

extension FixtureEngine {
  public func handoffOptions(for thread: ThreadRef) async throws -> HandoffOptions {
    fixtureHandoffOptions(for: thread)
  }

  public func checkHandoff(_ thread: ThreadRef, destination: HandoffDestination) async throws -> HandoffCheck {
    HandoffCheck(allowed: fixtureHandoffOptions(for: thread).destinations.contains(destination), messages: ["Sample checks passed. A sample continuation will open on \(destination.name). No real provider runs in this preview."])
  }

  public func continueThread(_ thread: ThreadRef, destination: HandoffDestination) async throws -> ThreadRef {
    if ProcessInfo.processInfo.arguments.contains("-SWCHandoffUncertain") {
      throw HandoffUncertain(detail: "Sample: Minis did not answer…")
    }
    return try await simulateHandoff(thread, to: destination)
  }
}
