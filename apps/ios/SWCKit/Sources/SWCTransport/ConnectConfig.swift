import Foundation

/// Public settings for SpecWithCode Connect, read from the app's Info.plist,
/// which takes them from build settings. A build without them uses the hosted
/// service, so no build ever lands on pairing with no way to sign in.
public struct ConnectConfig: Sendable, Hashable {
  /// Info.plist keys, set from the `STUDIO_*` build settings in project.yml.
  public enum Key {
    public static let publishableKey = "SWCClerkPublishableKey"
    public static let jwtTemplate = "SWCClerkJWTTemplate"
    public static let relayURL = "SWCRelayURL"
    public static let oauthProviders = "SWCClerkOAuthProviders"
    public static let entitlements = "SWCCodeSignEntitlements"
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
  /// The build carries the Sign in with Apple entitlement; without it the button can only fail.
  public var offersApple: Bool

  public init(publishableKey: String, jwtTemplate: String = ConnectConfig.defaultJWTTemplate, relayURL: URL, oauthProviders: [String] = [], offersApple: Bool = true) {
    self.publishableKey = publishableKey
    self.jwtTemplate = jwtTemplate
    self.relayURL = relayURL
    self.oauthProviders = oauthProviders
    self.offersApple = offersApple
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
        .filter { !$0.isEmpty && $0 != "apple" },
      offersApple: value(Key.entitlements) != nil
    )
  }

  /// The hosted service. All of it is public by design.
  public static func hosted(offersApple: Bool) -> ConnectConfig {
    ConnectConfig(
      publishableKey: "pk_live_Y2xlcmsuc3BlYy13ZWF2ZS5jb20k",
      relayURL: URL(string: "https://relay.spec-weave.com")!,
      oauthProviders: ["google"],
      offersApple: offersApple
    )
  }

  /// The running app's configuration; a build without its own uses the hosted service.
  public static func main(bundle: Bundle = .main) -> ConnectConfig {
    let info = bundle.infoDictionary ?? [:]
    return ConnectConfig(info: info) ?? hosted(offersApple: isSet(info[Key.entitlements]))
  }

  private static func isSet(_ value: Any?) -> Bool {
    guard let text = (value as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) else { return false }
    return !text.isEmpty && !text.hasPrefix("$(")
  }
}
