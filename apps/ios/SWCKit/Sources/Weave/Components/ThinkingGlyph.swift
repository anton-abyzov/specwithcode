import SwiftUI

/// The mark beside a reasoning row: three dots fading left to right, drawn on
/// the same 16-point grid as the web and Expo glyphs. Takes the foreground
/// style, so it follows light and dark. Pulses gently while the thought
/// streams; still under Reduce Motion.
public struct ThinkingGlyph: View {
  let size: CGFloat
  let pulsing: Bool

  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  public init(size: CGFloat = 14, pulsing: Bool = false) {
    self.size = size
    self.pulsing = pulsing
  }

  /// Dot centers on a 16-point grid, and each dot's opacity.
  static let dots: [(x: CGFloat, opacity: Double)] = [(3, 1), (8, 0.6), (13, 0.3)]
  static let radius: CGFloat = 1.75

  public var body: some View {
    Group {
      if pulsing && !reduceMotion {
        dotsView.weaveBreathing()
      } else {
        dotsView
      }
    }
    .frame(width: size, height: size)
    .accessibilityHidden(true)
  }

  /// The breath's ends, which `weaveBreathing()` eases between.
  public static let breathRange: ClosedRange<Double> = 0.45...1

  private var dotsView: some View {
    Canvas { context, canvas in
      let scale = canvas.width / 16
      let r = Self.radius * scale
      for dot in Self.dots {
        let rect = CGRect(x: dot.x * scale - r, y: 8 * scale - r, width: r * 2, height: r * 2)
        context.opacity = dot.opacity
        context.fill(Path(ellipseIn: rect), with: .foreground)
      }
    }
  }
}

#Preview("Light") {
  HStack(spacing: 12) {
    ThinkingGlyph(size: 12)
    ThinkingGlyph()
    ThinkingGlyph(size: 16)
  }
  .foregroundStyle(Color.weave.muted)
  .weavePreview(.light)
}

#Preview("Dark") {
  HStack(spacing: 12) {
    ThinkingGlyph(size: 12)
    ThinkingGlyph()
    ThinkingGlyph(size: 16)
  }
  .foregroundStyle(Color.weave.muted)
  .weavePreview(.dark)
}

extension View {
  /// Fades between 1 and 0.45 on a 1.6 second breath. The render server runs
  /// the fade, so the view's body is not re-evaluated every frame the way a
  /// TimelineView would; that per-frame work kept the main thread and the
  /// phone busy for as long as a reply streamed.
  public func weaveBreathing() -> some View {
    phaseAnimator([true, false]) { content, high in
      content.opacity(high ? ThinkingGlyph.breathRange.upperBound : ThinkingGlyph.breathRange.lowerBound)
    } animation: { _ in
      .easeInOut(duration: 0.8)
    }
  }
}
