import SwiftUI

/// The agent's todo list: steps with status glyphs and an "n of m done" header.
public struct PlanCard: View {
  public struct Step: Identifiable, Hashable, Sendable {
    public let id: String
    public var text: String
    public var state: WeaveProgressState

    public init(id: String, text: String, state: WeaveProgressState) {
      self.id = id
      self.text = text
      self.state = state
    }
  }

  let title: String
  let steps: [Step]

  public init(title: String = "Plan", steps: [Step]) {
    self.title = title
    self.steps = steps
  }

  private var done: Int { steps.filter { $0.state == .completed }.count }

  public var body: some View {
    VStack(alignment: .leading, spacing: WeaveSpacing.s3) {
      HStack(spacing: WeaveSpacing.s2) {
        ProgressRing(progress: steps.isEmpty ? 0 : Double(done) / Double(steps.count), size: 16, lineWidth: 2)
        Text(title)
          .font(.weave(.callout, weight: .semibold))
          .foregroundStyle(Color.weave.ink)
        Spacer(minLength: 0)
        Text("\(done) of \(steps.count) done")
          .font(.weave(.caption))
          .monospacedDigit()
          .foregroundStyle(Color.weave.muted)
      }
      .accessibilityElement(children: .ignore)
      .accessibilityLabel("\(title), \(done) of \(steps.count) done")
      VStack(alignment: .leading, spacing: WeaveSpacing.s2) {
        ForEach(steps) { step in
          HStack(alignment: .firstTextBaseline, spacing: WeaveSpacing.s3) {
            WeaveProgressGlyph(state: step.state, size: 14)
              .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 5 }
            Text(step.text)
              .weaveFont(.callout, weight: step.state == .running ? .semibold : nil)
              .foregroundStyle(step.state == .completed ? Color.weave.muted : Color.weave.ink)
              .strikethrough(step.state == .completed, color: Color.weave.muted)
              .frame(maxWidth: .infinity, alignment: .leading)
          }
          .accessibilityElement(children: .combine)
        }
      }
    }
    .padding(WeaveSpacing.s4)
    .background(Color.weave.panel, in: RoundedRectangle(cornerRadius: WeaveRadius.card, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: WeaveRadius.card, style: .continuous)
        .strokeBorder(Color.weave.line, lineWidth: WeaveSize.hairline)
    )
  }
}

#Preview("Light") {
  PlanCard(steps: PlanCardSample.steps).weavePreview(.light)
}

#Preview("Dark") {
  PlanCard(steps: PlanCardSample.steps).weavePreview(.dark)
}

private enum PlanCardSample {
  static let steps: [PlanCard.Step] = [
    .init(id: "1", text: "Read the failing workflow log", state: .completed),
    .init(id: "2", text: "Rotate the npm token", state: .completed),
    .init(id: "3", text: "Re-run the release workflow", state: .running),
    .init(id: "4", text: "Verify the package on npm", state: .pending),
    .init(id: "5", text: "Close the increment", state: .pending),
  ]
}
