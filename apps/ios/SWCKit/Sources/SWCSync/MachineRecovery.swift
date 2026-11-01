import Foundation

extension MachineSummary {
  public var canRetryConnection: Bool {
    !isDisconnected && status != .needsRepair && status != .unsupported
  }

  public var recoveryTitle: String {
    if isDisconnected { return "Disconnected on this phone" }
    if needsSignIn { return "Sign in again" }
    if isRefusingSignIns { return "\(displayName) is refusing sign-ins for now" }
    if status == .unsupported { return "Update needed" }
    if status == .needsRepair {
      return "Connection needs attention"
    }
    return "\(displayName) is unavailable"
  }

  public var recoveryMessage: String {
    if isDisconnected {
      return "Automatic retries are paused. Reconnect when you're ready. Your pairing, saved conversations and drafts stay on this phone."
    }
    if needsSignIn {
      return "Open SpecWithCode Connect below and sign in with the same account as your computer. A network outage does not require a new pairing."
    }
    if status == .unsupported {
      return "Update SpecWithCode on this phone and on \(displayName), then reconnect."
    }
    if isRefusingSignIns {
      return "\(displayName) is up, but it stopped accepting sign-ins from your network for a few minutes after too many failed attempts, usually from another device on the same Wi-Fi with an old pairing. You are still signed in. The app tries again on its own; updating SpecWithCode on \(displayName) stops one device from locking out the others."
    }
    if status == .needsRepair {
      if viaConnect {
        return "Check your account in SpecWithCode Connect, and on the computer check that Settings > Connections > Use SpecWithCode on your phone says it is ready for your iPhone. As a fallback, you can pair with a fresh link or QR code from that computer."
      }
      return "Use SpecWithCode Connect to restore access. The fallback pairing is expired or no longer accepted. To refresh that fallback, open Settings > Connections on the computer, choose Pair a phone, then Use a private QR code instead, and use its new link or QR code here."
    }
    if viaConnect {
      return "SpecWithCode Connect is the primary connection. Check that the computer is awake, SpecWithCode is running, and its Settings > Connections > Use SpecWithCode on your phone says it is ready for your iPhone. A saved Wi-Fi or Tailscale pairing is used only as a fallback."
    }
    return "Use SpecWithCode Connect to reach this computer. On the computer, open Settings > Connections > Use SpecWithCode on your phone, sign in and turn it on. Then sign in with the same account on this phone. Keep the computer awake with SpecWithCode running. Wi-Fi or Tailscale pairing is only a fallback."
  }
}
