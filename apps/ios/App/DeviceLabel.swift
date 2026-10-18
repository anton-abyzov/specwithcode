import Foundation
import UIKit

/// The name a computer shows for this phone in its list of paired devices
/// (`client_label` in the pairing token exchange).
enum DeviceLabel {
  /// A name the person chose for this phone. Screens store it with
  /// `@AppStorage("deviceLabel")`.
  static let defaultsKey = "deviceLabel"

  /// Used when neither a chosen name nor a system name is available.
  static let fallback = "iPhone"

  /// The chosen name when there is one, else the system device name.
  ///
  /// Without the `com.apple.developer.device-information.user-assigned-device-name`
  /// entitlement the system name is only the model ("iPhone"), so a chosen name
  /// is the only way to tell several paired phones apart.
  static func resolve(stored: String?, deviceName: String) -> String {
    let chosen = stored?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if !chosen.isEmpty { return chosen }
    let system = deviceName.trimmingCharacters(in: .whitespacesAndNewlines)
    return system.isEmpty ? fallback : system
  }

  /// The label for the next pairing.
  @MainActor
  static func current(defaults: UserDefaults = .standard) -> String {
    resolve(stored: defaults.string(forKey: defaultsKey), deviceName: UIDevice.current.name)
  }
}
