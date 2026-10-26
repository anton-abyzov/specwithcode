import Foundation
import SWCTransport

/// This phone as the relay's notification registration describes it.
public struct ConnectDevice: Sendable, Hashable {
  public var label: String
  public var iosMajorVersion: Int
  public var appVersion: String?
  public var bundleId: String?
  /// `sandbox` or `production`; nil when the build cannot receive pushes.
  public var apsEnvironment: String?

  public init(label: String, iosMajorVersion: Int, appVersion: String?, bundleId: String?, apsEnvironment: String?) {
    self.label = label
    self.iosMajorVersion = iosMajorVersion
    self.appVersion = appVersion
    self.bundleId = bundleId
    self.apsEnvironment = apsEnvironment
  }

  /// Read from the running app. Push is on only when the build was signed
  /// with Config/Connect.entitlements (the `SWCCodeSignEntitlements` key).
  public static func current(bundle: Bundle = .main, label: String = "iPhone") -> ConnectDevice {
    let info = { (key: String) -> String? in
      guard let value = bundle.object(forInfoDictionaryKey: key) as? String else { return nil }
      let trimmed = value.trimmingCharacters(in: .whitespaces)
      return trimmed.isEmpty || trimmed.hasPrefix("$(") ? nil : trimmed
    }
    let pushEnabled = info("SWCCodeSignEntitlements") != nil
    return ConnectDevice(
      label: label,
      iosMajorVersion: ProcessInfo.processInfo.operatingSystemVersion.majorVersion,
      appVersion: info("CFBundleShortVersionString"),
      bundleId: bundle.bundleIdentifier,
      apsEnvironment: pushEnabled ? apsEnvironment(info("SWCApsEnvironment")) : nil
    )
  }

  /// The entitlement says `development`; the relay calls it `sandbox`.
  public static func apsEnvironment(_ entitlement: String?) -> String? {
    switch entitlement {
    case "development": "sandbox"
    case "production": "production"
    default: nil
    }
  }

  public var canReceivePushes: Bool { apsEnvironment != nil }
}

extension LiveEngine {
  public func connectSetPushToken(_ token: Data) {
    guard let connect else { return }
    connect.pushToken = token.map { String(format: "%02x", $0) }.joined()
    Task { await connectAfterSignIn() }
  }

  /// Registers this phone for notifications once both a session and an APNs
  /// token exist; whichever arrives second sends it.
  func connectAfterSignIn() async {
    guard let connect, let user = connect.account.currentUser, let token = connect.pushToken, connect.device.canReceivePushes else { return }
    let key = "\(user.id)|\(token)"
    guard connect.registeredPush != key else { return }
    let device = connect.device
    let registration = ConnectDeviceRegistration(
      deviceId: connect.deviceId,
      label: device.label,
      iosMajorVersion: device.iosMajorVersion,
      appVersion: device.appVersion,
      bundleId: device.bundleId,
      apsEnvironment: device.apsEnvironment,
      pushToken: token,
      preferences: .init(notificationsEnabled: true)
    )
    // Claimed before the request, so a second call while it is in flight doesn't send it again.
    connect.registeredPush = key
    do {
      try await connect.relay.registerDevice(registration)
    } catch {
      if connect.registeredPush == key { connect.registeredPush = nil }
      Self.log.error("Notification registration failed: \(String(describing: error), privacy: .public)")
    }
  }

  /// Stops notifications to this phone before the session goes away.
  func connectBeforeSignOut() async {
    guard let connect, connect.registeredPush != nil else { return }
    do {
      try await connect.relay.unregisterDevice(connect.deviceId)
    } catch {
      Self.log.error("Notification unregistration failed: \(String(describing: error), privacy: .public)")
    }
    connect.registeredPush = nil
  }
}
