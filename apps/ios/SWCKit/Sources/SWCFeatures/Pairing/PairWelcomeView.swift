import SwiftUI
import SWCSync
import Weave

/// First run: what the app does and how to pair the first machine.
struct PairWelcomeView: View {
  @Environment(StackNavigator.self) private var nav
  @Environment(\.sampleData) private var sampleData
  @Environment(AppModel.self) private var model
  @Environment(\.verticalSizeClass) private var verticalSizeClass

  /// Landscape phones are too short for a pinned bar: it would cover the
  /// title, so the actions scroll with the content instead.
  private var isShort: Bool { verticalSizeClass == .compact }

  /// Connect is offered and nobody is signed in: sign-in is the next step.
  private var needsSignIn: Bool { model.connect != nil && model.connect?.user == nil }
  @State private var signInVisible = true
  /// A smaller hero leaves room for what comes next: sign-in, or the actions in landscape.
  private var compactHero: Bool { isShort || needsSignIn }

  static let steps = [
    "Open SpecWithCode on your computer.",
    "In Settings > Connections, choose Pair a phone. If it offers SpecWithCode Connect first, choose Use a private QR code instead: this build of the app pairs directly, over the same Wi-Fi or Tailscale.",
    "Scan the code with this phone, or paste the link here.",
  ]

  var body: some View {
    ScrollViewReader { proxy in
      content(proxy)
    }
    .screenBackground()
  }

  private func content(_ proxy: ScrollViewProxy) -> some View {
    ScrollView {
      VStack(spacing: WeaveSpacing.s6) {
        Image(systemName: "laptopcomputer.and.iphone")
          .font(.system(size: compactHero ? 28 : 34, weight: .regular))
          .foregroundStyle(Color.weave.iris)
          .frame(width: compactHero ? 64 : 84, height: compactHero ? 64 : 84)
          .background(Color.weave.irisTint, in: Circle())
          .accessibilityHidden(true)
          .padding(.top, compactHero ? WeaveSpacing.s4 : WeaveSpacing.s8 * 2)
        VStack(spacing: WeaveSpacing.s3) {
          Text("Control SpecWithCode from your phone")
            .weaveFont(.display)
            .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
            .foregroundStyle(Color.weave.ink)
            .multilineTextAlignment(.center)
            .accessibilityAddTraits(.isHeader)
          if !needsSignIn {
            Text("Talk to Aide, follow your projects and answer approvals while you're away from your desk.")
              .weaveFont(.callout)
              .foregroundStyle(Color.weave.muted)
              .multilineTextAlignment(.center)
          }
        }
        .padding(.horizontal, WeaveSpacing.s4)
        if let connect = model.connect {
          ConnectWelcomeContent(state: connect) { visible in
            withAnimation(.easeOut(duration: 0.2)) { signInVisible = visible }
          }
        } else {
          VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(Self.steps.enumerated()), id: \.offset) { index, step in
              if index > 0 { WeaveDivider(leadingInset: 60) }
              StepRow(number: index + 1, text: step)
            }
          }
          .weavePanel(in: RoundedRectangle(cornerRadius: WeaveRadius.card, style: .continuous))
        }
        if isShort { actions }
      }
      .padding(.horizontal, WeaveSpacing.gutter)
      .padding(.bottom, WeaveSpacing.s8)
      .frame(maxWidth: 560)
      .frame(maxWidth: .infinity)
    }
    .edgeBar(.bottom) {
      if !isShort {
        VStack(spacing: WeaveSpacing.s1) {
          // On short screens the sign-in buttons can sit below the fold;
          // say so and take the user there.
          if needsSignIn && !signInVisible {
            WeaveButton("Sign in to continue", systemImage: "chevron.down", fullWidth: true) {
              withAnimation(.easeOut(duration: 0.3)) { proxy.scrollTo(ConnectWelcomeContent.signInID, anchor: .center) }
            }
            .accessibilityHint("Scrolls to the sign-in buttons")
            .accessibilityIdentifier("welcome.sign-in")
          }
          actions
        }
        .padding(.horizontal, WeaveSpacing.gutter)
        .padding(.vertical, WeaveSpacing.s3)
      }
    }
  }

  private var actions: some View {
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
  }
}
