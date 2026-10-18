import SwiftUI

extension View {
  /// Root styling: canvas background, iris tint and the color scheme for an
  /// appearance preference ("system", "light" or "dark"; anything else is system).
  public func weaveTheme(appearance: String? = nil) -> some View {
    modifier(WeaveTheme(appearance: appearance))
  }

  /// A Liquid Glass surface where available, otherwise a regular material.
  /// Both get a hairline edge so the shape reads on any background.
  public func weaveGlass<S: InsettableShape>(in shape: S, interactive: Bool = false, hairline: Bool = true) -> some View {
    modifier(WeaveGlassModifier(shape: shape, interactive: interactive, hairline: hairline))
  }

  /// A solid panel surface with a hairline edge.
  public func weavePanel<S: InsettableShape>(in shape: S, fill: Color = .weave.panel) -> some View {
    background(fill, in: shape)
      .overlay(shape.strokeBorder(Color.weave.line, lineWidth: WeaveSize.hairline))
  }
}

/// Maps an appearance preference string to a color scheme. nil means follow the system.
public nonisolated func weaveColorScheme(for appearance: String?) -> ColorScheme? {
  switch appearance?.lowercased() {
  case "light": .light
  case "dark": .dark
  default: nil
  }
}

/// Root styling for the app. Apply once, around the root view.
public struct WeaveTheme: ViewModifier {
  let appearance: String?

  /// - Parameter appearance: "system", "light" or "dark"; anything else is system.
  public init(appearance: String?) { self.appearance = appearance }

  public func body(content: Content) -> some View {
    content
      .tint(Color.weave.iris)
      .foregroundStyle(Color.weave.ink)
      .background(Color.weave.canvas.ignoresSafeArea())
      .preferredColorScheme(weaveColorScheme(for: appearance))
  }
}

private struct WeaveGlassModifier<S: InsettableShape>: ViewModifier {
  let shape: S
  let interactive: Bool
  let hairline: Bool

  // The glass sits behind the content rather than on it, so the content keeps
  // its own colors and always draws (also in snapshots).
  func body(content: Content) -> some View {
    content
      .background {
        if #available(iOS 26.0, macOS 26.0, *) {
          Color.clear.glassEffect(interactive ? .regular.interactive() : .regular, in: shape)
        } else {
          shape.fill(.regularMaterial).shadow(color: .black.opacity(0.06), radius: 6, y: 2)
        }
      }
      .overlay {
        shape.strokeBorder(Color.weave.line.opacity(hairline ? 0.9 : 0), lineWidth: WeaveSize.hairline)
          .allowsHitTesting(false)
      }
  }
}
