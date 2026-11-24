import Foundation

/// "SpecWithCode/0.1.9 (iOS; build 47)" on every request and WebSocket
/// handshake to a machine or the relay, so a machine's approval popup and
/// device list can say which app version asks (1447). The server reads the
/// version with `SpecWithCode/(\d+\.\d+\.\d+)`.
public enum PhoneUserAgent {
  public static let header = "User-Agent"

  /// The app's own version and build, read once.
  public static let current: String = make(
    version: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
    build: Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String
  )

  /// "SpecWithCode/<version> (iOS; build <build>)". A version that is not
  /// three numbers is left out rather than sent wrong.
  public static func make(version: String?, build: String?) -> String {
    let version = version?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let build = build?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let product = version.range(of: #"^\d+\.\d+\.\d+$"#, options: .regularExpression) != nil ? "SpecWithCode/\(version)" : "SpecWithCode"
    let isBuild = !build.isEmpty && build.allSatisfy { $0.isASCII && ($0.isNumber || $0 == ".") }
    return isBuild ? "\(product) (iOS; build \(build))" : "\(product) (iOS)"
  }
}

extension URLRequest {
  /// Sets the phone's User-Agent unless the request already names one.
  mutating func setPhoneUserAgent(_ value: String = PhoneUserAgent.current) {
    if self.value(forHTTPHeaderField: PhoneUserAgent.header) == nil {
      setValue(value, forHTTPHeaderField: PhoneUserAgent.header)
    }
  }
}
