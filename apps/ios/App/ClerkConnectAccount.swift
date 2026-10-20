import ClerkKit
import Foundation
import SWCSync
import SWCTransport

/// The SpecWithCode account, kept by the Clerk SDK. Clerk stores its session
/// in the Keychain; this class never saves a token itself.
final class ClerkConnectAccount: ConnectAccount {
  let config: ConnectConfig

  init(config: ConnectConfig) {
    self.config = config
    Clerk.configure(publishableKey: config.publishableKey)
  }

  func load() async {
    // Clerk restores a saved session in the background after `configure`.
    for _ in 0..<100 where !Clerk.shared.isLoaded {
      try? await Task.sleep(for: .milliseconds(100))
    }
  }

  var currentUser: ConnectUser? {
    guard Clerk.shared.session != nil, let user = Clerk.shared.user else { return nil }
    let name = [user.firstName, user.lastName].compactMap { $0 }.joined(separator: " ")
    return ConnectUser(id: user.id, displayName: name.isEmpty ? nil : name, email: user.primaryEmailAddress?.emailAddress)
  }

  func signIn(with method: ConnectSignInMethod) async throws {
    switch method {
    case .apple: try await Clerk.shared.auth.signInWithApple()
    case .google: try await Clerk.shared.auth.signInWithOAuth(provider: .google)
    case .github: try await Clerk.shared.auth.signInWithOAuth(provider: .github)
    }
    if currentUser == nil { throw ClerkConnectError.incomplete }
  }

  func signOut() async throws {
    do {
      try await Clerk.shared.auth.signOut()
    } catch {
      // After the relay deleted the user, Clerk has already ended the
      // session; reloading the client drops it here as well.
      _ = try await Clerk.shared.refreshClient()
      if Clerk.shared.session != nil { throw error }
    }
  }

  func sessionToken(refresh: Bool) async throws -> String? {
    guard let session = Clerk.shared.session else { return nil }
    return try await session.getToken(.init(template: config.jwtTemplate, skipCache: refresh))
  }
}

enum ClerkConnectError: LocalizedError {
  case incomplete

  var errorDescription: String? {
    "Sign-in didn't finish. Try again, or sign in with another method."
  }
}
