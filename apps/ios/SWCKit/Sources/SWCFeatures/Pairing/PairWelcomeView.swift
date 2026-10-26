import SwiftUI
import SWCSync
import Weave

/// First run: what the app does and how to pair the first machine.
struct PairWelcomeView: View {
  @Environment(StackNavigator.self) private var nav
  @Environment(\.sampleData) private var sampleData
  @Environment(AppModel.self) private var model

  static let steps = [
    "Open SpecWithCode on your computer.",
    "In Settings > Connections, choose Pair a phone. Your phone reaches it on the same Wi-Fi, or over Tailscale if you use it.",
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
        if let connect = model.connect {
          ConnectWelcomeContent(state: connect)
        } else {
          VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(Self.steps.enumerated()), id: \.offset) { index, step in
              if index > 0 { WeaveDivider(leadingInset: 60) }
              StepRow(number: index + 1, text: step)
            }
          }
          .weavePanel(in: RoundedRectangle(cornerRadius: WeaveRadius.card, style: .continuous))
        }
      }
      .padding(.horizontal, WeaveSpacing.gutter)
      .padding(.bottom, WeaveSpacing.s8)
      .frame(maxWidth: 560)
      .frame(maxWidth: .infinity)
    }
    .safeAreaInset(edge: .bottom, spacing: 0) {
      VStack(spacing: WeaveSpacing.s1) {
        if model.connect == nil {
          WeaveButton("Pair a machine", systemImage: "qrcode.viewfinder", fullWidth: true) { nav.push(.pair) }
        } else {
          WeaveButton("Pair with a link or QR code", systemImage: "qrcode.viewfinder", kind: .ghost, fullWidth: true) { nav.push(.pair) }
            .accessibilityHint("For a Mac on your network, without signing in")
        }
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
