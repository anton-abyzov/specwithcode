import Foundation
import SWCSync
import UIKit

/// The name a computer shows for this phone in its list of paired devices
/// (`client_label` in the pairing token exchange).
enum DeviceLabel {
  /// A name the person chose for this phone. Screens store it with
  /// `@AppStorage("deviceLabel")`.
  static let defaultsKey = "deviceLabel"

  /// Used when neither a chosen name nor a system name is available.
  static let fallback = "iPhone"

  /// System names that say only what kind of device this is.
  static let genericNames: Set<String> = ["iPhone", "iPad", "iPod touch"]

  /// The chosen name when there is one, else the system device name, else the model.
  ///
  /// Without the `com.apple.developer.device-information.user-assigned-device-name`
  /// entitlement the system name is only the kind ("iPhone"), which every
  /// iPhone on the account shares. The model then stands in ("iPhone 16 Pro",
  /// or "iPhone (iPhone99,1)" for one newer than the table), so two phones of
  /// different models read differently on a computer. A chosen name still wins,
  /// and is the only way to tell two phones of one model apart by name.
  static func resolve(stored: String?, deviceName: String, model: String? = nil) -> String {
    let chosen = stored?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if !chosen.isEmpty { return chosen }
    let system = deviceName.trimmingCharacters(in: .whitespacesAndNewlines)
    let model = model?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    guard system.isEmpty || genericNames.contains(system) else { return system }
    let kind = system.isEmpty ? fallback : system
    guard !model.isEmpty, model != kind else { return kind }
    // A marketing name reads on its own; a bare identifier needs the kind beside it.
    return model.contains(" ") ? model : "\(kind) (\(model))"
  }

  /// The label for the next pairing.
  @MainActor
  static func current(defaults: UserDefaults = .standard) -> String {
    resolve(
      stored: defaults.string(forKey: defaultsKey),
      deviceName: UIDevice.current.name,
      model: ConnectDevice.modelName(ConnectDevice.hardwareIdentifier())
    )
  }
}
