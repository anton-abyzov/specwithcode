import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

/// Text roles. Every role follows Dynamic Type.
///
/// Prefer `.weaveFont(_:)` on views: it also sets line spacing and scales
/// exactly with the environment's Dynamic Type size. `Font.weave(_:)` gives the
/// font alone.
public nonisolated enum WeaveFont: String, Sendable, CaseIterable {
  /// 30 semibold. Empty states and large numbers.
  case display
  /// 22 semibold. Sheet and section titles.
  case title
  /// 17 semibold. Navigation titles, row titles that need weight.
  case headline
  /// 17 regular with generous line height. Messages and row titles.
  case body
  /// 15 regular. Secondary labels, row subtitles, section headers.
  case callout
  /// 13 regular. Metadata.
  case caption
  /// 12 regular. Fine print and small capsule subtitles.
  case footnote
  /// SF Mono 14. Commands, paths, ids, code blocks.
  case code

  public var size: CGFloat {
    switch self {
    case .display: 30
    case .title: 22
    case .headline, .body: 17
    case .callout: 15
    case .caption: 13
    case .footnote: 12
    case .code: 14
    }
  }

  public var weight: Font.Weight {
    switch self {
    case .display, .title, .headline: .semibold
    default: .regular
    }
  }

  /// The text style the role scales with.
  public var textStyle: Font.TextStyle {
    switch self {
    case .display: .title
    case .title: .title2
    case .headline: .headline
    case .body: .body
    case .callout: .subheadline
    case .caption: .footnote
    case .footnote: .caption
    case .code: .callout
    }
  }

  /// Line height as a multiple of the font size.
  public var lineHeightMultiple: CGFloat {
    switch self {
    case .display: 1.15
    case .title: 1.25
    case .headline: 1.3
    case .body: 1.55
    case .callout: 1.4
    case .caption: 1.35
    case .footnote: 1.3
    case .code: 1.45
    }
  }

  /// Extra space between lines for `lineSpacing`, at the base size.
  public var lineSpacing: CGFloat { max(0, size * (lineHeightMultiple - 1.2)) }

  /// The system text style whose default size equals this role's size, if any.
  private var exactSystemStyle: Font.TextStyle? {
    switch self {
    case .title: .title2
    case .headline: .headline
    case .body: .body
    case .callout: .subheadline
    case .caption: .footnote
    case .footnote: .caption
    case .display, .code: nil
    }
  }

  /// The font for this role. `dynamicTypeSize` makes the system fallback scale
  /// exactly for that size; without it the app's current setting is used.
  @MainActor
  public func font(weight: Font.Weight? = nil, dynamicTypeSize: DynamicTypeSize? = nil) -> Font {
    let w = weight ?? self.weight
    if self != .code, let custom = WeaveFonts.customName(for: w) {
      let font = Font.custom(custom.name, size: size, relativeTo: textStyle)
      return custom.applyWeight ? font.weight(w) : font
    }
    let design: Font.Design = self == .code ? .monospaced : .default
    #if canImport(UIKit)
    if let style = exactSystemStyle {
      return .system(style, design: design, weight: w)
    }
    #endif
    // macOS text styles use desktop sizes; there the role size is used as is.
    return .system(size: scaledSize(dynamicTypeSize), weight: w, design: design)
  }

  /// The size after Dynamic Type scaling.
  public func scaledSize(_ dynamicTypeSize: DynamicTypeSize? = nil) -> CGFloat {
    #if canImport(UIKit)
    let metrics = UIFontMetrics(forTextStyle: uiTextStyle)
    if let dynamicTypeSize {
      let traits = UITraitCollection(preferredContentSizeCategory: UIContentSizeCategory(dynamicTypeSize))
      return metrics.scaledValue(for: size, compatibleWith: traits)
    }
    return metrics.scaledValue(for: size)
    #else
    return size
    #endif
  }

  #if canImport(UIKit)
  private var uiTextStyle: UIFont.TextStyle {
    switch textStyle {
    case .largeTitle: .largeTitle
    case .title: .title1
    case .title2: .title2
    case .title3: .title3
    case .headline: .headline
    case .subheadline: .subheadline
    case .callout: .callout
    case .footnote: .footnote
    case .caption: .caption1
    case .caption2: .caption2
    default: .body
    }
  }
  #endif
}

extension Font {
  /// A Weave text role as a font. See `WeaveFont`.
  @MainActor
  public static func weave(_ role: WeaveFont, weight: Font.Weight? = nil) -> Font {
    role.font(weight: weight)
  }
}

extension View {
  /// Applies a Weave text role: font, weight and line spacing, scaled with Dynamic Type.
  public func weaveFont(_ role: WeaveFont, weight: Font.Weight? = nil) -> some View {
    modifier(WeaveFontModifier(role: role, weight: weight))
  }
}

private struct WeaveFontModifier: ViewModifier {
  let role: WeaveFont
  let weight: Font.Weight?
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize

  func body(content: Content) -> some View {
    let scale = role.scaledSize(dynamicTypeSize) / role.size
    content
      .font(role.font(weight: weight, dynamicTypeSize: dynamicTypeSize))
      .lineSpacing(role.lineSpacing * scale)
  }
}
