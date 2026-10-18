import Foundation
import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// Copies text to the system clipboard.
public enum WeaveClipboard {
  public static func copy(_ text: String) {
    #if canImport(UIKit)
    UIPasteboard.general.string = text
    #elseif canImport(AppKit)
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
    #endif
  }

  /// Copies `text` and tells VoiceOver the copy worked. Callers that already
  /// show a toast (which announces itself) use `copy(_:)` instead.
  public static func copyAnnounced(_ text: String, message: String = "Copied") {
    copy(text)
    var announcement = AttributedString(message)
    announcement.accessibilitySpeechAnnouncementPriority = .high
    AccessibilityNotification.Announcement(announcement).post()
  }

  /// Whether the clipboard holds text. Reading this never shows the paste
  /// permission prompt; only reading the text itself does.
  public static var hasText: Bool {
    #if canImport(UIKit)
    UIPasteboard.general.hasStrings
    #elseif canImport(AppKit)
    NSPasteboard.general.availableType(from: [.string]) != nil
    #else
    false
    #endif
  }

  /// Posted when the clipboard may have changed: an in-app change, or the app
  /// coming back to the foreground after a copy elsewhere.
  public static var changeNotifications: [Notification.Name] {
    #if canImport(UIKit)
    [UIPasteboard.changedNotification, UIApplication.didBecomeActiveNotification]
    #elseif canImport(AppKit)
    [NSApplication.didBecomeActiveNotification]
    #else
    []
    #endif
  }
}
