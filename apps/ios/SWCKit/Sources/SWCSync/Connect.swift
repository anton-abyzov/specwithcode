import Foundation
import SWCTransport

/// A way to sign in to SpecWithCode Connect. A store build always offers Sign in
/// with Apple beside any other (App Store guideline 4.8): it carries the entitlement.
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

  /// The methods a configuration offers, Apple first when the build can use it.
  public static func offered(by config: ConnectConfig) -> [ConnectSignInMethod] {
    let methods = (config.offersApple ? [.apple] : []) + config.oauthProviders.compactMap(ConnectSignInMethod.init(rawValue:)).filter { $0 != .apple }
    // The sign-in screen must never come up with nothing to tap.
    return methods.isEmpty ? [.google] : methods
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
  /// The person removed this phone from their account elsewhere. Kept across
  /// launches until the next sign-in on this phone succeeds.
  public var wasRemoved: Bool

  public init(methods: [ConnectSignInMethod], user: ConnectUser? = nil, macs: [ConnectMac] = [], isBusy: Bool = false, lastError: String? = nil, wasRemoved: Bool = false) {
    self.methods = methods
    self.user = user
    self.macs = macs
    self.isBusy = isBusy
    self.lastError = lastError
    self.wasRemoved = wasRemoved
  }

  public var isSignedIn: Bool { user != nil }

  /// The Connect row on a machine's screen. Someone signed in is not told to sign in.
  public var machineRowSubtitle: String {
    guard let user else { return "Primary connection · sign in to reach your computers" }
    guard let name = user.email ?? user.displayName else { return "Primary connection · signed in" }
    return "Primary connection · signed in as \(name)"
  }

  /// Shown while signed out after this phone was removed from the account.
  public static let removedMessage = ConnectError.deviceRemovedMessage
}

/// A phone on the signed-in account, for "Your phones".
public struct ConnectPhone: Sendable, Hashable, Identifiable {
  /// The phone's device id.
  public var id: String
  public var label: String
  public var model: String?
  public var appVersion: String?
  public var iosMajorVersion: Int?
  public var isDevBuild: Bool
  /// Nil when the relay sent a time the app could not read.
  public var lastSeen: Date?
  /// The phone running this app.
  public var isThisPhone: Bool

  public init(id: String, label: String, model: String? = nil, appVersion: String? = nil, iosMajorVersion: Int? = nil, isDevBuild: Bool = false, lastSeen: Date? = nil, isThisPhone: Bool = false) {
    self.id = id
    self.label = label
    self.model = model
    self.appVersion = appVersion
    self.iosMajorVersion = iosMajorVersion
    self.isDevBuild = isDevBuild
    self.lastSeen = lastSeen
    self.isThisPhone = isThisPhone
  }

  /// This phone first, then the most recently seen.
  public static func ordered(_ phones: [ConnectPhone]) -> [ConnectPhone] {
    phones.enumerated().sorted { a, b in
      if a.element.isThisPhone != b.element.isThisPhone { return a.element.isThisPhone }
      switch (a.element.lastSeen, b.element.lastSeen) {
      case let (x?, y?) where x != y: return x > y
      case (_?, nil): return true
      case (nil, _?): return false
      default: return a.offset < b.offset
      }
    }.map(\.element)
  }
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
