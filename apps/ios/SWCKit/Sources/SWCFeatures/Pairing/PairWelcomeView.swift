import SwiftUI
import SWCSync
import Weave

/// First run: what the app does and how to pair the first machine.
struct PairWelcomeView: View {
  @Environment(StackNavigator.self) private var nav
  @Environment(\.sampleData) private var sampleData

  static let steps = [
    "Open SpecWithCode on your computer.",
    "In Settings > Connections, turn on Network access, then choose Create link under Authorized clients.",
    "Scan the code with this phone, or paste the link here.",
  ]

  var body: some View {
    ScrollView {
      VStack(spacing: WeaveSpacing.s6) {
        Image(systemName: "laptopcomputer.and.iphone")
          .font(.system(size: 34, weight: .regular))
          .foregroundStyle(Color.weave.iris)
          .frame(width: 84, height: 84)
          .background(Color.weave.irisTint, in: Circle())
          .accessibilityHidden(true)
          .padding(.top, WeaveSpacing.s8 * 2)
        VStack(spacing: WeaveSpacing.s3) {
          Text("Control SpecWithCode from your phone")
            .weaveFont(.display)
            .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
            .foregroundStyle(Color.weave.ink)
            .multilineTextAlignment(.center)
            .accessibilityAddTraits(.isHeader)
          Text("Talk to Aide, follow your projects and answer approvals while you're away from your desk.")
            .weaveFont(.callout)
            .foregroundStyle(Color.weave.muted)
            .multilineTextAlignment(.center)
        }
        .padding(.horizontal, WeaveSpacing.s4)
        VStack(alignment: .leading, spacing: 0) {
          ForEach(Array(Self.steps.enumerated()), id: \.offset) { index, step in
            if index > 0 { WeaveDivider(leadingInset: 60) }
            StepRow(number: index + 1, text: step)
          }
        }
        .weavePanel(in: RoundedRectangle(cornerRadius: WeaveRadius.card, style: .continuous))
      }
      .padding(.horizontal, WeaveSpacing.gutter)
      .padding(.bottom, WeaveSpacing.s8)
      .frame(maxWidth: 560)
      .frame(maxWidth: .infinity)
    }
    .safeAreaInset(edge: .bottom, spacing: 0) {
      VStack(spacing: WeaveSpacing.s1) {
        WeaveButton("Pair a machine", systemImage: "qrcode.viewfinder", fullWidth: true) { nav.push(.pair) }
        if !sampleData.isActive {
          WeaveButton("Explore with sample data", kind: .ghost, fullWidth: true) { sampleData.enter() }
            .accessibilityHint("Shows the app with made-up machines and projects")
        }
      }
      .padding(.horizontal, WeaveSpacing.gutter)
      .padding(.vertical, WeaveSpacing.s3)
      .background(Color.weave.canvas.ignoresSafeArea(edges: .bottom))
    }
    .screenBackground()
  }
}

private struct StepRow: View {
  let number: Int
  let text: String

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: WeaveSpacing.s4) {
      Text("\(number)")
        .font(.weave(.callout, weight: .semibold))
        .foregroundStyle(Color.weave.irisStrong)
        .frame(width: 28, height: 28)
        .background(Color.weave.irisTint, in: Circle())
        .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 5 }
      Text(text)
        .weaveFont(.body)
        .foregroundStyle(Color.weave.ink)
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    .padding(.horizontal, WeaveSpacing.s4)
    .padding(.vertical, WeaveSpacing.s3 + 2)
    .frame(minHeight: 56)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Step \(number): \(text)")
  }
}
