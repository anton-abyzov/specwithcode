import Foundation

/// The four characters a computer shows beside this phone in its approval
/// pop-up and its device list, so two phones that both read "iPhone" can be
/// told apart. A hint only: the code typed on the computer is what approves.
///
/// The same rule as `packages/shared/src/deviceShortId.ts`; both test suites
/// assert the same vectors, so the phone and the computer always agree.
public enum DeviceShortID {
  /// The characters approval codes are made of: no 0, 1, I, L or O to misread.
  static let alphabet = Array("23456789ABCDEFGHJKMNPQRSTUVWXYZ")
  static let base64url = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
  public static let length = 4

  /// "7K3Q" for a DPoP key thumbprint (base64url of a SHA-256): each of its
  /// first four bytes picks one character. Nil when the text is not a thumbprint.
  public static func make(thumbprint: String) -> String? {
    let text = Array(thumbprint.trimmingCharacters(in: .whitespacesAndNewlines))
    // Six base64url characters hold the first four bytes.
    let needed = (length * 8 + 5) / 6
    guard text.count >= needed else { return nil }
    var bytes: [Int] = []
    var held = 0
    var bits = 0
    for character in text.prefix(needed) {
      guard let value = base64url.firstIndex(of: character) else { return nil }
      held = ((held << 6) | value) & 0xffff
      bits += 6
      if bits >= 8 {
        bits -= 8
        bytes.append((held >> bits) & 0xff)
      }
    }
    return String(bytes.prefix(length).map { alphabet[$0 % alphabet.count] })
  }
}
