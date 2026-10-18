import SwiftUI

/// The header title: a 44 pt glass capsule with an optional icon tile, a title
/// and an optional subtitle. With an action it is a button.
public struct TitleCapsule<Icon: View>: View {
  let title: String
  let subtitle: String?
  let action: (() -> Void)?
  let icon: Icon

  public init(title: String, subtitle: String? = nil, action: (() -> Void)? = nil, @ViewBuilder icon: () -> Icon) {
    self.title = title
    self.subtitle = subtitle
    self.action = action
    self.icon = icon()
  }

  public var body: some View {
    Group {
      if let action {
        Button(action: action) { capsule }
          .buttonStyle(WeavePressStyle())
      } else {
        capsule
      }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(subtitle.map { "\(title), \($0)" } ?? title)
    .accessibilityAddTraits(action == nil ? .isHeader : [.isHeader, .isButton])
    .accessibilityShowsLargeContentViewer { Text(title) }
  }

  private var capsule: some View {
    HStack(spacing: WeaveSpacing.s2) {
      icon
      VStack(alignment: .leading, spacing: 0) {
        Text(title)
          .font(.weave(subtitle == nil ? .headline : .callout, weight: .semibold))
          .foregroundStyle(Color.weave.ink)
        if let subtitle {
          Text(subtitle)
            .font(.weave(.footnote))
            .foregroundStyle(Color.weave.muted)
        }
      }
      .lineLimit(1)
      .truncationMode(.tail)
    }
    .padding(.leading, Icon.self == EmptyView.self ? 14 : WeaveSpacing.s2)
    .padding(.trailing, 14)
    .frame(minHeight: WeaveSize.control)
    .weaveGlass(in: Capsule(), interactive: action != nil)
    .contentShape(Capsule())
  }
}

extension TitleCapsule where Icon == EmptyView {
  public init(title: String, subtitle: String? = nil, action: (() -> Void)? = nil) {
    self.init(title: title, subtitle: subtitle, action: action) { EmptyView() }
  }
}

#Preview("Light") {
  TitleCapsulePreview().weavePreview(.light)
}

#Preview("Dark") {
  TitleCapsulePreview().weavePreview(.dark)
}

private struct TitleCapsulePreview: View {
  var body: some View {
    VStack(spacing: WeaveSpacing.s4) {
      TitleCapsule(title: "specweave", action: {}) {
        ProjectAvatar(icon: .lucide(name: "dna", tint: "amber"), title: "specweave", size: WeaveSize.titleTile)
      }
      TitleCapsule(title: "Guided macOS permissions for computer use", subtitle: "Thread · 1 artifact", action: {})
        .frame(maxWidth: 220)
      TitleCapsule(title: "Overview")
    }
  }
}
