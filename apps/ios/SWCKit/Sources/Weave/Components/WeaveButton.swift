import SwiftUI

/// A text button. Primary is the iris fill; use one per screen.
///
/// Disabled buttons keep readable text: the label turns muted and a primary
/// button drops to the sunken fill with a hairline, instead of fading out.
public struct WeaveButton: View {
  public enum Kind: Sendable {
    /// Iris fill with on-iris text.
    case primary
    /// Panel fill with a control border.
    case secondary
    /// Fail text on the fail tint.
    case destructive
    /// Iris text, no background.
    case ghost
  }

  let title: String
  let systemImage: String?
  let kind: Kind
  let fullWidth: Bool
  let isLoading: Bool
  let action: () -> Void

  @Environment(\.isEnabled) private var isEnabled
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize

  public init(_ title: String, systemImage: String? = nil, kind: Kind = .primary, fullWidth: Bool = false, isLoading: Bool = false, action: @escaping () -> Void) {
    self.title = title
    self.systemImage = systemImage
    self.kind = kind
    self.fullWidth = fullWidth
    self.isLoading = isLoading
    self.action = action
  }

  public var body: some View {
    Button(action: action) {
      HStack(spacing: WeaveSpacing.s2) {
        if isLoading {
          ProgressView()
            .controlSize(.small)
            .tint(foreground)
        } else if let systemImage {
          Image(systemName: systemImage)
            .imageScale(.medium)
        }
        // Wraps to a second line at accessibility sizes instead of truncating.
        Text(title)
          .lineLimit(dynamicTypeSize.isAccessibilitySize ? 2 : 1)
          .multilineTextAlignment(.center)
      }
      .font(.weave(fullWidth ? .headline : .callout, weight: .semibold))
      .foregroundStyle(foreground)
      .padding(.horizontal, kind == .ghost ? WeaveSpacing.s2 : WeaveSpacing.s4 + 2)
      .padding(.vertical, WeaveSpacing.s2)
      .frame(maxWidth: fullWidth ? .infinity : nil, minHeight: fullWidth ? 50 : WeaveSize.minTap)
      .background { background }
      .contentShape(Capsule())
    }
    .buttonStyle(WeavePressStyle())
    .disabled(isLoading)
    .accessibilityLabel(title)
    .accessibilityValue(isLoading ? Text("In progress") : Text(""))
  }

  private var foreground: Color {
    guard isEnabled else { return .weave.muted }
    return switch kind {
    case .primary: .weave.onIris
    case .secondary: .weave.ink
    case .destructive: .weave.fail
    case .ghost: .weave.iris
    }
  }

  @ViewBuilder private var background: some View {
    switch kind {
    case .primary where !isEnabled:
      Capsule().fill(Color.weave.sunken)
        .overlay(Capsule().strokeBorder(Color.weave.line, lineWidth: 1))
    case .primary:
      Capsule().fill(Color.weave.iris)
    case .secondary:
      Capsule().fill(Color.weave.panel)
        .overlay(Capsule().strokeBorder(isEnabled ? Color.weave.control : Color.weave.line, lineWidth: 1))
    case .destructive:
      Capsule().fill(Color.weave.failTint)
    case .ghost:
      Color.clear
    }
  }
}

#Preview("Light") {
  WeaveButtonPreview().weavePreview(.light)
}

#Preview("Dark") {
  WeaveButtonPreview().weavePreview(.dark)
}

private struct WeaveButtonPreview: View {
  var body: some View {
    VStack(spacing: WeaveSpacing.s3) {
      WeaveButton("Pair a machine", systemImage: "qrcode.viewfinder", fullWidth: true) {}
      WeaveButton("Saving", fullWidth: true, isLoading: true) {}
      HStack {
        WeaveButton("Approve") {}
        WeaveButton("For session", kind: .secondary) {}
        WeaveButton("Deny", kind: .destructive) {}
      }
      WeaveButton("Show more", kind: .ghost) {}
      WeaveButton("Disabled", kind: .primary) {}.disabled(true)
    }
  }
}
