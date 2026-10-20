import Foundation
import SWCTransport

/// A way to sign in to SpecWithCode Connect. Sign in with Apple is always
/// offered when any other is (App Store guideline 4.8).
public enum ConnectSignInMethod: String, Sendable, Hashable, CaseIterable, Identifiable {
  case apple, google, github

  public var id: String { rawValue }

  public var title: String {
    switch self {
    case .apple: "Sign in with Apple"
    case .google: "Continue with Google"
    case .github: "Continue with GitHub"
    }
  }

  /// The methods a configuration offers, Apple first.
  public static func offered(by config: ConnectConfig) -> [ConnectSignInMethod] {
    [.apple] + config.oauthProviders.compactMap(ConnectSignInMethod.init(rawValue:)).filter { $0 != .apple }
  }
}

/// The signed-in person, as the account provider describes them.
public struct ConnectUser: Sendable, Hashable {
  public var id: String
  public var displayName: String?
  public var email: String?

  public init(id: String, displayName: String? = nil, email: String? = nil) {
    self.id = id
    self.displayName = displayName
    self.email = email
  }
}

/// The account behind SpecWithCode Connect. The app implements it with the
/// Clerk SDK; tests use a fake.
@MainActor
public protocol ConnectAccount: AnyObject, Sendable {
  var config: ConnectConfig { get }
  /// Waits until a saved session, if any, is restored.
  func load() async
  /// The signed-in person, nil when signed out.
  var currentUser: ConnectUser? { get }
  func signIn(with method: ConnectSignInMethod) async throws
  func signOut() async throws
  /// A session JWT from the relay's JWT template, nil when signed out.
  func sessionToken(refresh: Bool) async throws -> String?
}

/// What the app shows about SpecWithCode Connect. Nil on `AppModel` when the
/// build has no Connect configuration.
public struct ConnectState: Sendable, Hashable {
  public var methods: [ConnectSignInMethod]
  /// Nil when signed out.
  public var user: ConnectUser?
  /// The account's computers, in the relay's order.
  public var macs: [ConnectMac]
  /// Signing in, signing out or listing computers.
  public var isBusy: Bool
  public var lastError: String?

  public init(methods: [ConnectSignInMethod], user: ConnectUser? = nil, macs: [ConnectMac] = [], isBusy: Bool = false, lastError: String? = nil) {
    self.methods = methods
    self.user = user
    self.macs = macs
    self.isBusy = isBusy
    self.lastError = lastError
  }

  public var isSignedIn: Bool { user != nil }
}

/// A computer linked to the signed-in account.
public struct ConnectMac: Sendable, Hashable, Identifiable {
  /// The machine's environment id, also its `MachineSummary` id.
  public var id: String
  public var label: String
  /// Nil until the relay answered.
  public var isOnline: Bool?
  /// When the relay last checked the computer.
  public var checkedAt: Date?

  public init(id: String, label: String, isOnline: Bool? = nil, checkedAt: Date? = nil) {
    self.id = id
    self.label = label
    self.isOnline = isOnline
    self.checkedAt = checkedAt
  }
}

/// Hands the Clerk session to the relay client, which runs off the main actor.
struct ConnectSessionBridge: ConnectSessionTokenProvider {
  let fetch: @Sendable @MainActor (Bool) async throws -> String?

  func sessionToken(refresh: Bool) async throws -> String? {
    try await fetch(refresh)
  }
}
