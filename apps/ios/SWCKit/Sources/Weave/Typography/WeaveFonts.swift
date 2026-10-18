import CoreText
import Foundation
import SwiftUI

// Schibsted Grotesk registration. The font files are optional: drop the .ttf or
// .otf files into Resources/Fonts and they are registered at first use. Until
// then every role falls back to the system font at the same size and weight.

@MainActor
public enum WeaveFonts {
  /// The family the Weave tokens name.
  public nonisolated static let familyName = "Schibsted Grotesk"

  /// Registers every font file in the Weave bundle. Safe to call more than once;
  /// later calls do nothing. `Font.weave` calls it on first use.
  public static func register() {
    _ = state
  }

  /// True when Schibsted Grotesk is registered or installed and resolvable.
  public static var isSchibstedAvailable: Bool { state.regular != nil }

  /// Font names usable with `Font.custom` for a weight, or nil when the system
  /// font should be used. `applyWeight` is true when only a variable font or a
  /// family name is available and the weight must be applied with `.weight(_:)`.
  static func customName(for weight: Font.Weight) -> (name: String, applyWeight: Bool)? {
    let s = state
    guard let regular = s.regular else { return nil }
    if let exact = s.byWeight[weight] { return (exact, false) }
    if weight == .regular { return (regular, false) }
    return (s.familyForWeights ?? regular, true)
  }

  // MARK: - State

  private struct Resolved: Sendable {
    var regular: String?
    var byWeight: [Font.Weight: String] = [:]
    var familyForWeights: String?
  }

  private static var resolved: Resolved?

  private static var state: Resolved {
    if let resolved { return resolved }
    let r = resolve()
    resolved = r
    return r
  }

  private static func resolve() -> Resolved {
    let urls = fontURLs()
    if !urls.isEmpty {
      CTFontManagerRegisterFontURLs(urls as CFArray, .process, true) { _, _ in true }
    }

    var out = Resolved()
    var hasVariable = false
    for url in urls {
      let descriptors = (CTFontManagerCreateFontDescriptorsFromURL(url as CFURL) as? [CTFontDescriptor] ?? []).compactMap(schibstedUpright)
      if descriptors.count == 1, let d = descriptors.first {
        out.familyForWeights = d.family
        if let weight = weight(styleName: d.style), resolves(d.postScript) { out.byWeight[weight] = d.postScript }
      } else if let d = descriptors.first {
        // Several named instances in one file: a variable font. Use the family
        // name and apply weights explicitly.
        out.familyForWeights = d.family
        hasVariable = true
      }
    }
    // Static files the app registered itself, for example through UIAppFonts.
    for (weight, suffix) in [(Font.Weight.regular, "Regular"), (.medium, "Medium"), (.semibold, "SemiBold"), (.bold, "Bold")] {
      let name = "SchibstedGrotesk-\(suffix)"
      if out.byWeight[weight] == nil, resolves(name) {
        out.byWeight[weight] = name
        if out.familyForWeights == nil { out.familyForWeights = familyName }
      }
    }
    out.regular = out.byWeight[.regular] ?? (hasVariable ? out.familyForWeights : nil)
    return out
  }

  private static func schibstedUpright(_ d: CTFontDescriptor) -> (postScript: String, family: String, style: String)? {
    guard let family = CTFontDescriptorCopyAttribute(d, kCTFontFamilyNameAttribute) as? String,
          family.localizedCaseInsensitiveContains("Schibsted"),
          let postScript = CTFontDescriptorCopyAttribute(d, kCTFontNameAttribute) as? String
    else { return nil }
    let style = (CTFontDescriptorCopyAttribute(d, kCTFontStyleNameAttribute) as? String) ?? ""
    return style.localizedCaseInsensitiveContains("italic") ? nil : (postScript, family, style)
  }

  private static func fontURLs() -> [URL] {
    var urls: [URL] = []
    for ext in ["ttf", "otf"] {
      urls += Bundle.module.urls(forResourcesWithExtension: ext, subdirectory: nil) ?? []
      urls += Bundle.module.urls(forResourcesWithExtension: ext, subdirectory: "Fonts") ?? []
    }
    var seen = Set<String>()
    return urls.filter { seen.insert($0.standardizedFileURL.path).inserted }
  }

  private static func weight(styleName: String) -> Font.Weight? {
    switch styleName.lowercased().replacingOccurrences(of: " ", with: "") {
    case "regular", "": .regular
    case "medium": .medium
    case "semibold": .semibold
    case "bold": .bold
    case "extrabold": .heavy
    case "black": .black
    default: nil
    }
  }

  /// CoreText substitutes another font for unknown names; compare the result.
  private static func resolves(_ name: String) -> Bool {
    let font = CTFontCreateWithName(name as CFString, 12, nil)
    return (CTFontCopyPostScriptName(font) as String) == name
  }
}
