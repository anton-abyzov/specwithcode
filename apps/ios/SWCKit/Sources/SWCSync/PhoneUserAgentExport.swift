import SWCTransport

/// The phone's User-Agent product token, for requests the feature layer makes
/// to a machine itself (the file viewer), 1447.
public enum PhoneAgent {
  public static var userAgent: String { PhoneUserAgent.current }
  /// "SpecWithCode/0.1.9" for WebKit's `applicationNameForUserAgent`, so a web
  /// view keeps its own identity and still names the app version.
  public static var productToken: String { String(PhoneUserAgent.current.prefix { $0 != " " }) }
}
