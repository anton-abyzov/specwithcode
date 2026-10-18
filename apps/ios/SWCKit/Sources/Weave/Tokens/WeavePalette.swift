import Foundation

// Weave color values as plain data, kept free of UI frameworks so the contrast
// math can run anywhere. Light and dark come from the Weave tokens; the
// increased-contrast column strengthens muted, line and control only.

/// An sRGB color with components in 0...1.
public nonisolated struct WeaveRGB: Hashable, Sendable {
  public var red: Double
  public var green: Double
  public var blue: Double

  public init(red: Double, green: Double, blue: Double) {
    self.red = red
    self.green = green
    self.blue = blue
  }

  /// Parses "#rrggbb", "rrggbb" or "#rgb". Returns nil for anything else.
  public init?(hex: String) {
    var s = hex.trimmingCharacters(in: .whitespaces)
    if s.hasPrefix("#") { s.removeFirst() }
    if s.count == 3 { s = s.map { "\($0)\($0)" }.joined() }
    guard s.count == 6, let value = UInt32(s, radix: 16) else { return nil }
    red = Double((value >> 16) & 0xff) / 255
    green = Double((value >> 8) & 0xff) / 255
    blue = Double(value & 0xff) / 255
  }

  public var hex: String {
    func byte(_ c: Double) -> Int { Int((min(max(c, 0), 1) * 255).rounded()) }
    return String(format: "#%02x%02x%02x", byte(red), byte(green), byte(blue))
  }

  /// WCAG 2.x relative luminance.
  public var relativeLuminance: Double {
    func linear(_ c: Double) -> Double { c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4) }
    return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue)
  }

  /// WCAG contrast ratio between two colors, 1...21.
  public func contrast(with other: WeaveRGB) -> Double {
    let a = relativeLuminance, b = other.relativeLuminance
    return (max(a, b) + 0.05) / (min(a, b) + 0.05)
  }
}

public nonisolated enum WeaveAppearance: String, Sendable, CaseIterable {
  case light, dark
}

/// Every Weave color role. `Color.weave` exposes the same set as SwiftUI colors.
public nonisolated enum WeaveColorToken: String, Sendable, CaseIterable {
  case canvas, panel, sunken
  case ink, muted, line, control
  case iris, irisStrong, irisTint, onIris
  case pass, passTint, warn, warnTint, fail, failTint
  /// Fill of the user's message bubble: iris tint in light, panel in dark.
  case bubble

  /// Hex values: light, dark, light with increased contrast, dark with increased contrast.
  private var values: (light: String, dark: String, lightHigh: String?, darkHigh: String?) {
    switch self {
    case .canvas: ("#f8f7f9", "#16131d", nil, nil)
    case .panel: ("#ffffff", "#201c29", nil, nil)
    case .sunken: ("#efedf2", "#110e17", nil, nil)
    case .ink: ("#241523", "#f3eff9", nil, nil)
    case .muted: ("#675d69", "#a69fb2", "#4d4450", "#c9c3d4")
    case .line: ("#dedae5", "#322c3e", "#b4acc0", "#544a66")
    case .control: ("#8c8399", "#776d8a", "#6a6078", "#9d93b2")
    case .iris: ("#6d4fb5", "#a88cf6", nil, nil)
    case .irisStrong: ("#4a3678", "#cbbcff", nil, nil)
    case .irisTint: ("#ece6f8", "#2b2340", nil, nil)
    case .onIris: ("#ffffff", "#1b1328", nil, nil)
    case .pass: ("#1d7348", "#5cc68d", nil, nil)
    case .passTint: ("#e3f2e9", "#15301f", nil, nil)
    case .warn: ("#8f5400", "#e8ab3e", nil, nil)
    case .warnTint: ("#f7ecd9", "#33270f", nil, nil)
    case .fail: ("#b4232c", "#ff8080", nil, nil)
    case .failTint: ("#f9e3e4", "#3a1a1d", nil, nil)
    case .bubble: ("#ece6f8", "#201c29", nil, nil)
    }
  }

  public func hex(_ appearance: WeaveAppearance, increasedContrast: Bool = false) -> String {
    let v = values
    switch (appearance, increasedContrast) {
    case (.light, false): return v.light
    case (.dark, false): return v.dark
    case (.light, true): return v.lightHigh ?? v.light
    case (.dark, true): return v.darkHigh ?? v.dark
    }
  }

  public func rgb(_ appearance: WeaveAppearance, increasedContrast: Bool = false) -> WeaveRGB {
    // Every value above is a valid literal.
    WeaveRGB(hex: hex(appearance, increasedContrast: increasedContrast)) ?? WeaveRGB(red: 0, green: 0, blue: 0)
  }
}

/// The project icon colors SpecWithCode offers (Tailwind 600 in light, 400 in dark,
/// matching the desktop and web apps).
public nonisolated enum WeaveTintName: String, Sendable, CaseIterable {
  case gray, red, orange, amber, yellow, lime, green, emerald, teal, cyan
  case sky, blue, indigo, violet, purple, fuchsia, pink, rose

  public var light: String {
    switch self {
    case .gray: "#4b5563"
    case .red: "#dc2626"
    case .orange: "#ea580c"
    case .amber: "#d97706"
    case .yellow: "#ca8a04"
    case .lime: "#65a30d"
    case .green: "#16a34a"
    case .emerald: "#059669"
    case .teal: "#0d9488"
    case .cyan: "#0891b2"
    case .sky: "#0284c7"
    case .blue: "#2563eb"
    case .indigo: "#4f46e5"
    case .violet: "#7c3aed"
    case .purple: "#9333ea"
    case .fuchsia: "#c026d3"
    case .pink: "#db2777"
    case .rose: "#e11d48"
    }
  }

  public var dark: String {
    switch self {
    case .gray: "#9ca3af"
    case .red: "#f87171"
    case .orange: "#fb923c"
    case .amber: "#fbbf24"
    case .yellow: "#facc15"
    case .lime: "#a3e635"
    case .green: "#4ade80"
    case .emerald: "#34d399"
    case .teal: "#2dd4bf"
    case .cyan: "#22d3ee"
    case .sky: "#38bdf8"
    case .blue: "#60a5fa"
    case .indigo: "#818cf8"
    case .violet: "#a78bfa"
    case .purple: "#c084fc"
    case .fuchsia: "#e879f9"
    case .pink: "#f472b6"
    case .rose: "#fb7185"
    }
  }
}

/// Contrast checks for the pairs the app relies on.
public nonisolated enum WeaveContrast {
  public struct Check: Sendable, Hashable {
    public let foreground: WeaveColorToken
    public let background: WeaveColorToken
    public let appearance: WeaveAppearance
    public let increasedContrast: Bool
    /// 4.5 for text, 3 for control borders and large glyphs.
    public let minimum: Double
    public let ratio: Double
    public var passes: Bool { ratio >= minimum }
  }

  public static func ratio(_ foreground: WeaveColorToken, on background: WeaveColorToken, _ appearance: WeaveAppearance, increasedContrast: Bool = false) -> Double {
    foreground.rgb(appearance, increasedContrast: increasedContrast)
      .contrast(with: background.rgb(appearance, increasedContrast: increasedContrast))
  }

  /// Text pairs need 4.5:1; control borders need 3:1.
  public static let requiredPairs: [(WeaveColorToken, WeaveColorToken, Double)] = [
    (.ink, .canvas, 4.5), (.ink, .panel, 4.5), (.ink, .sunken, 4.5), (.ink, .bubble, 4.5), (.ink, .irisTint, 4.5),
    (.muted, .canvas, 4.5), (.muted, .panel, 4.5), (.muted, .sunken, 4.5), (.muted, .bubble, 4.5),
    (.iris, .canvas, 4.5), (.iris, .panel, 4.5), (.irisStrong, .irisTint, 4.5),
    (.onIris, .iris, 4.5),
    (.pass, .passTint, 4.5), (.warn, .warnTint, 4.5), (.fail, .failTint, 4.5),
    (.pass, .panel, 4.5), (.warn, .panel, 4.5), (.fail, .panel, 4.5),
    (.control, .canvas, 3), (.control, .panel, 3),
  ]

  public static func allChecks() -> [Check] {
    var out: [Check] = []
    for high in [false, true] {
      for appearance in WeaveAppearance.allCases {
        for (fg, bg, minimum) in requiredPairs {
          out.append(Check(foreground: fg, background: bg, appearance: appearance, increasedContrast: high, minimum: minimum, ratio: ratio(fg, on: bg, appearance, increasedContrast: high)))
        }
      }
    }
    return out
  }
}
