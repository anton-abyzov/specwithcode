#import <Foundation/Foundation.h>

// Swift can't declare an Objective-C option set, and the optional requirements of
// UNUserNotificationCenterDelegate need one, so the stub comes from a header as in the SDK.
typedef NS_OPTIONS(NSUInteger, UNNotificationPresentationOptions) {
  UNNotificationPresentationOptionBadge = (1 << 0),
  UNNotificationPresentationOptionSound = (1 << 1),
  UNNotificationPresentationOptionList = (1 << 3),
  UNNotificationPresentationOptionBanner = (1 << 4),
};
