import SwiftUI

/// A circular button with an SF Symbol. Header controls use the glass style at
/// 44 pt; composer controls use `.sunken` or `.filled` at 36 pt. The hit area
/// is never smaller than 44 pt.
public struct WeaveIconButton: View {
  public enum Style: Sendable {
    /// Liquid Glass with a hairline. Header controls.
    case glass
    /// Solid gray fill. Composer attach, mic and stop.
    case sunken
    /// Iris fill. Send and save.
    case filled
    /// No background.
    case plain
  }

  let systemName: String
  let label: String
  let style: Style
  let size: CGFloat
  let glyphScale: CGFloat
  let badge: Bool
  let action: () -> Void

  @Environment(\.isEnabled) private var isEnabled

  /// - Parameter glyphScale: Glyph point size as a fraction of `size`. Small
  ///   filled glyphs such as stop read better a little larger.
  public init(_ systemName: String, label: String, style: Style = .glass, size: CGFloat = WeaveSize.control, glyphScale: CGFloat = 0.4, badge: Bool = false, action: @escaping () -> Void) {
    self.systemName = systemName
    self.label = label
    self.style = style
    self.size = size
    self.glyphScale = glyphScale
    self.badge = badge
    self.action = action
  }

  public var body: some View {
    Button(action: action) {
      glyph
        .frame(width: size, height: size)
        .background { background }
        .overlay(alignment: .topTrailing) {
          if badge {
            Circle()
              .fill(Color.weave.iris)
              .frame(width: 9, height: 9)
              .overlay(Circle().strokeBorder(Color.weave.canvas, lineWidth: 1.5))
              .offset(x: -size * 0.06, y: size * 0.06)
              .accessibilityHidden(true)
          }
        }
        .frame(minWidth: WeaveSize.minTap, minHeight: WeaveSize.minTap)
        .contentShape(Rectangle())
    }
    .buttonStyle(WeavePressStyle(scale: 0.92))
    .accessibilityLabel(label)
    .accessibilityValue(badge ? Text("Has updates") : Text(""))
    .accessibilityShowsLargeContentViewer {
      Label(label, systemImage: systemName)
    }
  }

  private var glyph: some View {
    Image(systemName: systemName)
      .font(.system(size: size * glyphScale, weight: .medium))
      .foregroundStyle(foreground)
      .symbolRenderingMode(.monochrome)
  }

  private var foreground: Color {
    switch style {
    case .filled: isEnabled ? .weave.onIris : .weave.muted
    case .glass, .sunken, .plain: isEnabled ? .weave.ink : .weave.muted
    }
  }

  @ViewBuilder private var background: some View {
    switch style {
    case .glass:
      Color.clear.weaveGlass(in: Circle(), interactive: true)
    case .sunken:
      Circle().fill(Color.weave.sunken)
    case .filled:
      Circle().fill(isEnabled ? Color.weave.iris : Color.weave.line)
    case .plain:
      Color.clear
    }
  }
}

#Preview("Light") {
  WeaveIconButtonPreview().weavePreview(.light)
}

#Preview("Dark") {
  WeaveIconButtonPreview().weavePreview(.dark)
}

private struct WeaveIconButtonPreview: View {
  var body: some View {
    VStack(spacing: WeaveSpacing.s4) {
      HStack {
        WeaveIconButton("line.3.horizontal", label: "Menu") {}
        Spacer()
        WeaveIconButton("checklist", label: "Overview", badge: true) {}
      }
      HStack(spacing: WeaveSpacing.s3) {
        WeaveIconButton("plus", label: "Attach", style: .sunken, size: WeaveSize.innerControl) {}
        WeaveIconButton("arrow.up", label: "Send", style: .filled, size: WeaveSize.innerControl) {}
        WeaveIconButton("arrow.up", label: "Send", style: .filled, size: WeaveSize.innerControl) {}.disabled(true)
        WeaveIconButton("stop.fill", label: "Stop", style: .sunken, size: WeaveSize.innerControl, glyphScale: ComposerBar.stopGlyphScale) {}
        WeaveIconButton("ellipsis", label: "More", style: .plain) {}
      }
    }
  }
}
