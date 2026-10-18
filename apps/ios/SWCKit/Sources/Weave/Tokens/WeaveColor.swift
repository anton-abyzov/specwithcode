import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

// Weave colors as dynamic SwiftUI colors. They follow the color scheme and the
// Increase Contrast setting, including `preferredColorScheme` and preview
// environments. Use them as `Color.weave.ink` or `.foregroundStyle(.weave.ink)`.

public nonisolated struct WeaveColors: Sendable {
  public init() {}

  public var canvas: Color { WeaveColorCache.color(.canvas) }
  public var panel: Color { WeaveColorCache.color(.panel) }
  public var sunken: Color { WeaveColorCache.color(.sunken) }
  public var ink: Color { WeaveColorCache.color(.ink) }
  public var muted: Color { WeaveColorCache.color(.muted) }
  public var line: Color { WeaveColorCache.color(.line) }
  public var control: Color { WeaveColorCache.color(.control) }
  public var iris: Color { WeaveColorCache.color(.iris) }
  public var irisStrong: Color { WeaveColorCache.color(.irisStrong) }
  public var irisTint: Color { WeaveColorCache.color(.irisTint) }
  public var onIris: Color { WeaveColorCache.color(.onIris) }
  public var pass: Color { WeaveColorCache.color(.pass) }
  public var passTint: Color { WeaveColorCache.color(.passTint) }
  public var warn: Color { WeaveColorCache.color(.warn) }
  public var warnTint: Color { WeaveColorCache.color(.warnTint) }
  public var fail: Color { WeaveColorCache.color(.fail) }
  public var failTint: Color { WeaveColorCache.color(.failTint) }
  /// Fill of the user's message bubble.
  public var bubble: Color { WeaveColorCache.color(.bubble) }

  public func color(_ token: WeaveColorToken) -> Color { WeaveColorCache.color(token) }

  /// A project tint by name ("violet") or hex ("#7c3aed"). Unknown or nil gives iris.
  public func tint(_ nameOrHex: String?) -> Color { WeaveTint.color(nameOrHex) }
}

extension Color {
  public nonisolated static let weave = WeaveColors()
}

extension ShapeStyle where Self == Color {
  public nonisolated static var weave: WeaveColors { WeaveColors() }
}

/// Resolves project tints. Named tints adapt to light and dark; hex tints are fixed.
public nonisolated enum WeaveTint {
  public static func color(_ nameOrHex: String?) -> Color {
    guard let raw = nameOrHex?.trimmingCharacters(in: .whitespaces).lowercased(), !raw.isEmpty else {
      return WeaveColorCache.color(.iris)
    }
    if let name = WeaveTintName(rawValue: raw) { return WeaveColorCache.tint(name) }
    if let rgb = WeaveRGB(hex: raw) { return Color(.sRGB, red: rgb.red, green: rgb.green, blue: rgb.blue) }
    return WeaveColorCache.color(.iris)
  }
}

#if canImport(UIKit)
extension UIColor {
  /// The dynamic UIKit color for a Weave token, for UIKit appearance APIs.
  public nonisolated static func weave(_ token: WeaveColorToken) -> UIColor { WeaveColorCache.platform(token) }
}
#elseif canImport(AppKit)
extension NSColor {
  public nonisolated static func weave(_ token: WeaveColorToken) -> NSColor { WeaveColorCache.platform(token) }
}
#endif

nonisolated enum WeaveColorCache {
  #if canImport(UIKit)
  typealias PlatformColor = UIColor
  #else
  typealias PlatformColor = NSColor
  #endif

  private static let tokens: [WeaveColorToken: Color] = Dictionary(
    uniqueKeysWithValues: WeaveColorToken.allCases.map { ($0, Color(platformColor: makePlatform($0))) }
  )
  private static let platformTokens: [WeaveColorToken: PlatformColor] = Dictionary(
    uniqueKeysWithValues: WeaveColorToken.allCases.map { ($0, makePlatform($0)) }
  )
  private static let tints: [WeaveTintName: Color] = Dictionary(
    uniqueKeysWithValues: WeaveTintName.allCases.map { name in
      (name, Color(platformColor: dynamic { appearance, _ in
        WeaveRGB(hex: appearance == .dark ? name.dark : name.light) ?? WeaveRGB(red: 0, green: 0, blue: 0)
      }))
    }
  )

  static func color(_ token: WeaveColorToken) -> Color { tokens[token] ?? .primary }
  static func platform(_ token: WeaveColorToken) -> PlatformColor { platformTokens[token] ?? makePlatform(token) }
  static func tint(_ name: WeaveTintName) -> Color { tints[name] ?? .accentColor }

  private static func makePlatform(_ token: WeaveColorToken) -> PlatformColor {
    dynamic { appearance, high in token.rgb(appearance, increasedContrast: high) }
  }

  private static func dynamic(_ resolve: @escaping @Sendable (WeaveAppearance, Bool) -> WeaveRGB) -> PlatformColor {
    #if canImport(UIKit)
    return UIColor { traits in
      let appearance: WeaveAppearance = traits.userInterfaceStyle == .dark ? .dark : .light
      let rgb = resolve(appearance, traits.accessibilityContrast == .high)
      return UIColor(red: rgb.red, green: rgb.green, blue: rgb.blue, alpha: 1)
    }
    #else
    return NSColor(name: nil) { nsAppearance in
      let match = nsAppearance.bestMatch(from: [.aqua, .darkAqua, .accessibilityHighContrastAqua, .accessibilityHighContrastDarkAqua])
      let dark = match == .darkAqua || match == .accessibilityHighContrastDarkAqua
      let high = match == .accessibilityHighContrastAqua || match == .accessibilityHighContrastDarkAqua
      let rgb = resolve(dark ? .dark : .light, high)
      return NSColor(srgbRed: rgb.red, green: rgb.green, blue: rgb.blue, alpha: 1)
    }
    #endif
  }
}

extension Color {
  fileprivate nonisolated init(platformColor: WeaveColorCache.PlatformColor) {
    #if canImport(UIKit)
    self.init(uiColor: platformColor)
    #else
    self.init(nsColor: platformColor)
    #endif
  }
}
