import SwiftUI

/// A floating capsule with a progress ring and "4/7 tasks", for a linked
/// SpecWeave increment. Tapping opens its tasks. The ring fills with a spring
/// as tasks settle; under Reduce Motion it changes without animating.
public struct TaskProgressPill: View {
  let settled: Int
  let total: Int
  let action: () -> Void

  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  public init(settled: Int, total: Int, action: @escaping () -> Void) {
    self.settled = settled
    self.total = total
    self.action = action
  }

  private var fraction: CGFloat { total > 0 ? CGFloat(min(settled, total)) / CGFloat(total) : 0 }
  private var complete: Bool { total > 0 && settled >= total }

  public var body: some View {
    Button(action: action) {
      HStack(spacing: WeaveSpacing.s2) {
        ZStack {
          Circle().stroke(Color.weave.line, lineWidth: 2)
          Circle()
            .trim(from: 0, to: fraction)
            .stroke(complete ? Color.weave.pass : Color.weave.iris, style: StrokeStyle(lineWidth: 2, lineCap: .round))
            .rotationEffect(.degrees(-90))
          if complete {
            Image(systemName: "checkmark")
              .font(.system(size: 8, weight: .bold))
              .foregroundStyle(Color.weave.pass)
          }
        }
        .frame(width: 16, height: 16)
        .animation(reduceMotion ? nil : .spring(response: 0.5, dampingFraction: 0.8), value: fraction)
        Text(total > 0 ? "\(settled)/\(total) tasks" : "Increment")
          .font(.weave(.callout, weight: .semibold))
          .foregroundStyle(Color.weave.ink)
          .monospacedDigit()
          .lineLimit(1)
          .fixedSize()
      }
      .padding(.horizontal, WeaveSpacing.s4)
      .frame(minHeight: WeaveSize.minTap)
      .background(Color.weave.panel, in: Capsule())
      .overlay(Capsule().strokeBorder(Color.weave.line, lineWidth: WeaveSize.hairline))
      .shadow(color: .black.opacity(0.06), radius: 8, y: 2)
      .contentShape(Capsule())
    }
    .buttonStyle(PillPressStyle())
    .dynamicTypeSize(...DynamicTypeSize.xxLarge)
    .accessibilityLabel(total > 0 ? "SpecWeave increment, \(settled) of \(total) tasks settled" : "SpecWeave increment")
    .accessibilityHint("Shows the increment's tasks")
  }
}

private struct PillPressStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .scaleEffect(configuration.isPressed ? 0.96 : 1)
      .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
  }
}

#Preview {
  VStack(spacing: 16) {
    TaskProgressPill(settled: 4, total: 7) {}
    TaskProgressPill(settled: 7, total: 7) {}
  }
  .padding()
  .background(Color.weave.canvas)
}
