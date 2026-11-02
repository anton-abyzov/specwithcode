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
  /// The hardware model, e.g. "iPhone 16 Pro", shown in "Your phones".
  public var model: String?

  public init(label: String, iosMajorVersion: Int, appVersion: String?, bundleId: String?, apsEnvironment: String?, model: String? = nil) {
    self.label = label
    self.iosMajorVersion = iosMajorVersion
    self.appVersion = appVersion
    self.bundleId = bundleId
    self.apsEnvironment = apsEnvironment
    self.model = model
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
      apsEnvironment: pushEnabled ? apsEnvironment(info("SWCApsEnvironment")) : nil,
      model: modelName(hardwareIdentifier())
    )
  }

  /// The hardware identifier, e.g. "iPhone17,1". A simulator reports the
  /// device it simulates.
  static func hardwareIdentifier(environment: [String: String] = ProcessInfo.processInfo.environment) -> String? {
    if let simulated = environment["SIMULATOR_MODEL_IDENTIFIER"], !simulated.isEmpty { return simulated }
    var info = utsname()
    guard uname(&info) == 0 else { return nil }
    let machine = withUnsafeBytes(of: &info.machine) { raw in
      String(decoding: raw.prefix { $0 != 0 }, as: UTF8.self)
    }
    return machine.isEmpty ? nil : machine
  }

  /// The marketing name for an iPhone identifier. A phone newer than this table
  /// sends its identifier, which still tells it apart from any other model.
  public static func modelName(_ identifier: String?) -> String? {
    guard let identifier, !identifier.isEmpty else { return nil }
    guard identifier.hasPrefix("iPhone") else { return identifier.hasPrefix("iPad") ? "iPad" : nil }
    return iPhoneNames[identifier] ?? identifier
  }

  static let iPhoneNames: [String: String] = [
    "iPhone12,1": "iPhone 11", "iPhone12,3": "iPhone 11 Pro", "iPhone12,5": "iPhone 11 Pro Max", "iPhone12,8": "iPhone SE (2nd generation)",
    "iPhone13,1": "iPhone 12 mini", "iPhone13,2": "iPhone 12", "iPhone13,3": "iPhone 12 Pro", "iPhone13,4": "iPhone 12 Pro Max",
    "iPhone14,4": "iPhone 13 mini", "iPhone14,5": "iPhone 13", "iPhone14,2": "iPhone 13 Pro", "iPhone14,3": "iPhone 13 Pro Max",
    "iPhone14,6": "iPhone SE (3rd generation)", "iPhone14,7": "iPhone 14", "iPhone14,8": "iPhone 14 Plus",
    "iPhone15,2": "iPhone 14 Pro", "iPhone15,3": "iPhone 14 Pro Max",
    "iPhone15,4": "iPhone 15", "iPhone15,5": "iPhone 15 Plus", "iPhone16,1": "iPhone 15 Pro", "iPhone16,2": "iPhone 15 Pro Max",
    "iPhone17,3": "iPhone 16", "iPhone17,4": "iPhone 16 Plus", "iPhone17,1": "iPhone 16 Pro", "iPhone17,2": "iPhone 16 Pro Max",
    "iPhone17,5": "iPhone 16e",
    "iPhone18,3": "iPhone 17", "iPhone18,1": "iPhone 17 Pro", "iPhone18,2": "iPhone 17 Pro Max", "iPhone18,4": "iPhone Air",
    "iPhone18,5": "iPhone 17e", "iPhone19,2": "iPhone 18 Pro", "iPhone19,3": "iPhone 18 Pro Max", "iPhone19,4": "iPhone Duo",
  ]

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

  /// Registers this phone with the relay whenever it is signed in, so it is
  /// listed in "Your phones" and can be removed even without notifications.
  /// The APNs token is added once the system hands one over; a build that
  /// cannot receive pushes, or a person who declined them, registers without.
  /// Calls run one at a time, so a registration without a token never lands
  /// after the one that carries it.
  func connectAfterSignIn() async {
    guard let connect else { return }
    guard !connect.registering else {
      connect.registrationPending = true
      return
    }
    connect.registering = true
    defer { connect.registering = false }
    repeat {
      connect.registrationPending = false
      await registerThisPhone(connect)
    } while connect.registrationPending
  }

  private func registerThisPhone(_ connect: ConnectRuntime) async {
    guard let user = connect.account.currentUser else { return }
    let device = connect.device
    let token = device.canReceivePushes ? connect.pushToken : nil
    let key = Self.registrationKey(userId: user.id, pushToken: token)
    guard connect.registeredPush != key else { return }
    let registration = ConnectDeviceRegistration(
      deviceId: connect.deviceId,
      label: device.label,
      iosMajorVersion: device.iosMajorVersion,
      appVersion: device.appVersion,
      bundleId: device.bundleId,
      apsEnvironment: token == nil ? nil : device.apsEnvironment,
      pushToken: token,
      model: device.model,
      preferences: .init(notificationsEnabled: token != nil)
    )
    // Claimed before the request, so a second call while it is in flight doesn't send it again.
    connect.registeredPush = key
    do {
      try await connect.relay.registerDevice(registration)
    } catch {
      if connect.registeredPush == key { connect.registeredPush = nil }
      Self.log.error("Device registration failed: \(String(describing: error), privacy: .public)")
      await connectHandleRemoval(error)
    }
  }

  /// The account and push token state of a registration; a new token, or the
  /// first one, registers again.
  static func registrationKey(userId: String, pushToken: String?) -> String {
    "\(userId)|\(pushToken.map { "push:" + $0 } ?? "none")"
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
