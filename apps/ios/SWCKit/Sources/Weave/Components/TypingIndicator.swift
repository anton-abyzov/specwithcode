import SwiftUI

/// Three dots that pulse while a reply is on its way. Still under Reduce Motion.
public struct TypingIndicator: View {
  let label: String

  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  public init(label: String = "Working") { self.label = label }

  public var body: some View {
    Group {
      if reduceMotion {
        dots(lit: nil)
      } else {
        // The render server runs the fades between phases; a TimelineView
        // would re-evaluate this body every frame while a reply is on its way.
        PhaseAnimator(0..<3) { lit in
          dots(lit: lit)
        } animation: { _ in
          .easeInOut(duration: 0.25)
        }
      }
    }
    .frame(minHeight: 24)
    .accessibilityElement()
    .accessibilityLabel(label)
  }

  /// The dot at `lit` is full, the others faint; all at rest when nil.
  private func dots(lit: Int?) -> some View {
    HStack(spacing: 5) {
      ForEach(0..<3, id: \.self) { index in
        Circle()
          .fill(Color.weave.muted)
          .frame(width: 8, height: 8)
          .opacity(lit.map { $0 == index ? 1 : 0.35 } ?? 0.7)
      }
    }
  }
}

#Preview("Light") {
  TypingIndicator().weavePreview(.light)
}

#Preview("Dark") {
  TypingIndicator().weavePreview(.dark)
}
