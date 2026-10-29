import Foundation

extension MachineSummary {
  public var canRetryConnection: Bool {
    !isDisconnected && status != .needsRepair && status != .unsupported
  }

  public var recoveryTitle: String {
    if isDisconnected { return "Disconnected on this phone" }
    if needsSignIn { return "Sign in again" }
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
    if status == .needsRepair {
      if viaConnect {
        return "Check your account in SpecWithCode Connect and make sure Connect is enabled in the computer's Settings > Connections. You can also pair with a fresh link from that computer."
      }
      return "Use SpecWithCode Connect to restore access. The fallback pairing is expired or no longer accepted. To refresh that fallback, open Settings > Connections > Pair a phone on the computer, then use its new link or QR code here."
    }
    if viaConnect {
      return "SpecWithCode Connect is the primary connection. Check that the computer is awake, SpecWithCode is running, and Connect is enabled in its Settings > Connections. A saved local or Tailscale pairing is used only as a fallback."
    }
    return "Use SpecWithCode Connect to reach this computer. Enable Connect in the computer's Settings > Connections and sign in with the same account on this phone. Keep the computer awake with SpecWithCode running. Local Wi-Fi or Tailscale pairing is a fallback."
  }
}
