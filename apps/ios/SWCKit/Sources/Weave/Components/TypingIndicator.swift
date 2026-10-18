import SwiftUI

/// Three dots that pulse while a reply is on its way. Still under Reduce Motion.
public struct TypingIndicator: View {
  let label: String

  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  public init(label: String = "Working") { self.label = label }

  public var body: some View {
    Group {
      if reduceMotion {
        dots(phase: nil)
      } else {
        TimelineView(.animation(minimumInterval: 1.0 / 30)) { context in
          dots(phase: context.date.timeIntervalSinceReferenceDate)
        }
      }
    }
    .frame(minHeight: 24)
    .accessibilityElement()
    .accessibilityLabel(label)
  }

  private func dots(phase: TimeInterval?) -> some View {
    HStack(spacing: 5) {
      ForEach(0..<3, id: \.self) { index in
        Circle()
          .fill(Color.weave.muted)
          .frame(width: 8, height: 8)
          .opacity(opacity(index: index, phase: phase))
      }
    }
  }

  private func opacity(index: Int, phase: TimeInterval?) -> Double {
    guard let phase else { return 0.7 }
    let t = (phase * 1.6 - Double(index) * 0.22).truncatingRemainder(dividingBy: 1.2)
    let wave = t < 0.6 ? sin(t / 0.6 * .pi) : 0
    return 0.35 + 0.65 * max(0, wave)
  }
}

#Preview("Light") {
  TypingIndicator().weavePreview(.light)
}

#Preview("Dark") {
  TypingIndicator().weavePreview(.dark)
}
