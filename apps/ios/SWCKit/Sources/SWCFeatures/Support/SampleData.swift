import SwiftUI
import SWCSync
import Weave

/// Sample data someone can explore before pairing a machine, for example App
/// Review. It runs on its own model, so nothing in it reaches real machines.
struct SampleDataMode: Sendable {
  /// The screens show sample data right now.
  var isActive = false
  var enter: @MainActor @Sendable () -> Void = {}
  var exit: @MainActor @Sendable () -> Void = {}
}

private nonisolated struct SampleDataModeKey: EnvironmentKey {
  static let defaultValue = SampleDataMode()
}

extension EnvironmentValues {
  nonisolated var sampleData: SampleDataMode {
    get { self[SampleDataModeKey.self] }
    set { self[SampleDataModeKey.self] = newValue }
  }
}

/// Stays above every screen while sample data is showing.
struct SampleDataBar: View {
  let onExit: () -> Void

  var body: some View {
    HStack(spacing: WeaveSpacing.s2) {
      Image(systemName: "sparkles")
        .font(.system(size: 13, weight: .semibold))
        .accessibilityHidden(true)
      Text("Sample data")
        .font(.weave(.callout, weight: .semibold))
        .lineLimit(1)
      Spacer(minLength: WeaveSpacing.s2)
      Button(action: onExit) {
        Text("Exit")
          .font(.weave(.callout, weight: .semibold))
          .lineLimit(1)
          .padding(.horizontal, WeaveSpacing.s3)
          .frame(minWidth: WeaveSize.minTap, minHeight: WeaveSize.minTap)
          .contentShape(Rectangle())
      }
      .buttonStyle(PressableStyle())
      .accessibilityLabel("Exit sample data")
      .accessibilityHint("Goes back to pairing a machine")
    }
    .foregroundStyle(Color.weave.irisStrong)
    .padding(.leading, WeaveSpacing.gutter)
    .padding(.trailing, WeaveSpacing.s2)
    .frame(minHeight: WeaveSize.minTap)
    .background(Color.weave.irisTint.ignoresSafeArea(edges: .top))
    .dynamicTypeSize(...DynamicTypeSize.accessibility1)
  }
}
