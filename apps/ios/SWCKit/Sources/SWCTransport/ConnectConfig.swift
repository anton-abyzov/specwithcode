import Foundation

/// Public settings for SpecWithCode Connect, read from the app's Info.plist,
/// which takes them from build settings. Nil when the build has none: the app
/// then only pairs directly and shows no sign-in.
public struct ConnectConfig: Sendable, Hashable {
  /// Info.plist keys, set from the `STUDIO_*` build settings in project.yml.
  public enum Key {
    public static let publishableKey = "SWCClerkPublishableKey"
    public static let jwtTemplate = "SWCClerkJWTTemplate"
    public static let relayURL = "SWCRelayURL"
    public static let oauthProviders = "SWCClerkOAuthProviders"
  }

  public static let defaultJWTTemplate = "studio-relay"

  /// Clerk publishable key (`pk_live_…` or `pk_test_…`). Public by design.
  public var publishableKey: String
  /// Clerk JWT template whose audience is the relay.
  public var jwtTemplate: String
  /// The relay origin, e.g. `https://relay.spec-weave.com`. It is also the
  /// token-exchange `resource`, so it must match the relay's issuer exactly.
  public var relayURL: URL
  /// Extra sign-in providers after Sign in with Apple, e.g. `google`, `github`.
  public var oauthProviders: [String]

  public init(publishableKey: String, jwtTemplate: String = ConnectConfig.defaultJWTTemplate, relayURL: URL, oauthProviders: [String] = []) {
    self.publishableKey = publishableKey
    self.jwtTemplate = jwtTemplate
    self.relayURL = relayURL
    self.oauthProviders = oauthProviders
  }

  /// Reads an Info.plist dictionary. Unset build settings arrive as empty
  /// strings or as the literal `$(NAME)`; both count as absent.
  public init?(info: [String: Any]) {
    func value(_ key: String) -> String? {
      guard let raw = info[key] as? String else { return nil }
      let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !trimmed.isEmpty, !trimmed.hasPrefix("$(") else { return nil }
      return trimmed
    }
    guard let key = value(Key.publishableKey), key.hasPrefix("pk_"),
          let relay = value(Key.relayURL), let url = URL(string: relay),
          url.scheme == "https" || url.host() == "localhost" || url.host() == "127.0.0.1",
          url.host() != nil else { return nil }
    var relayURL = url.absoluteString
    while relayURL.hasSuffix("/") { relayURL.removeLast() }
    self.init(
      publishableKey: key,
      jwtTemplate: value(Key.jwtTemplate) ?? Self.defaultJWTTemplate,
      relayURL: URL(string: relayURL) ?? url,
      oauthProviders: (value(Key.oauthProviders) ?? "")
        .split(whereSeparator: { $0 == "," || $0 == " " })
        .map { $0.lowercased() }
        .filter { !$0.isEmpty && $0 != "apple" }
    )
  }

  /// The running app's configuration.
  public static func main(bundle: Bundle = .main) -> ConnectConfig? {
    ConnectConfig(info: bundle.infoDictionary ?? [:])
  }
}
