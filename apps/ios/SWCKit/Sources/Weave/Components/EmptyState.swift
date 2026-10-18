import SwiftUI

/// Centered placeholder for an empty list or screen.
public struct EmptyState: View {
  let systemName: String
  let title: String
  let message: String?
  let actionTitle: String?
  let action: (() -> Void)?

  public init(systemName: String, title: String, message: String? = nil, actionTitle: String? = nil, action: (() -> Void)? = nil) {
    self.systemName = systemName
    self.title = title
    self.message = message
    self.actionTitle = actionTitle
    self.action = action
  }

  public var body: some View {
    VStack(spacing: WeaveSpacing.s4) {
      Image(systemName: systemName)
        .font(.system(size: 30, weight: .regular))
        .foregroundStyle(Color.weave.muted)
        .frame(width: 72, height: 72)
        .background(Color.weave.sunken, in: Circle())
        .accessibilityHidden(true)
      VStack(spacing: WeaveSpacing.s2) {
        Text(title)
          .weaveFont(.title)
          .foregroundStyle(Color.weave.ink)
          .multilineTextAlignment(.center)
          .accessibilityAddTraits(.isHeader)
        if let message {
          Text(message)
            .weaveFont(.callout)
            .foregroundStyle(Color.weave.muted)
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      if let actionTitle, let action {
        WeaveButton(actionTitle, action: action)
          .padding(.top, WeaveSpacing.s2)
      }
    }
    .padding(.horizontal, WeaveSpacing.s8)
    .frame(maxWidth: 420)
  }
}

#Preview("Light") {
  EmptyStatePreview().weavePreview(.light)
}

#Preview("Dark") {
  EmptyStatePreview().weavePreview(.dark)
}

private struct EmptyStatePreview: View {
  var body: some View {
    EmptyState(systemName: "laptopcomputer", title: "No machines yet", message: "Open SpecWithCode on your computer and scan its pairing code.", actionTitle: "Pair a machine", action: {})
      .padding(.top, WeaveSpacing.s8)
  }
}
