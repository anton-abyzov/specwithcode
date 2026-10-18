import SwiftUI

/// Maps scene phases onto `AppEngine.setActive`.
enum EngineActivity {
  /// `true` when the app comes to the foreground and `false` when it goes to the
  /// background. `nil` means leave the engine as it is: `.inactive` is transient
  /// (Control Center, the notification shade, the app switcher, call banners,
  /// Face ID and permission alerts), and closing every machine socket for it
  /// would drop subscriptions and fail commands that are in flight.
  static func isActive(in phase: ScenePhase) -> Bool? {
    switch phase {
    case .active: true
    case .background: false
    case .inactive: nil
    @unknown default: nil
    }
  }
}
