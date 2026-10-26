import SWCFeatures
import SWCSync
import UIKit
import UserNotifications

/// Asks for notification permission after sign-in and hands the APNs token to
/// the engine, which registers it with the relay. Builds signed without
/// Config/Connect.entitlements skip all of it.
@MainActor
enum PushRegistration {
  static var engine: (any AppEngine)?

  static func enable(engine: any AppEngine) async {
    guard ConnectDevice.current().canReceivePushes else { return }
    self.engine = engine
    let center = UNUserNotificationCenter.current()
    let settings = await center.notificationSettings()
    switch settings.authorizationStatus {
    case .notDetermined:
      guard (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) == true else { return }
    case .denied:
      return
    default:
      break
    }
    UIApplication.shared.registerForRemoteNotifications()
  }
}

final class AppDelegate: NSObject, UIApplicationDelegate {
  func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
    MainActor.assumeIsolated { PushRegistration.engine?.connectSetPushToken(deviceToken) }
  }

  func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: any Error) {}
}
