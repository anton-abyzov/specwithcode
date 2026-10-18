import SwiftUI

/// A hairline separator. `leadingInset` aligns it with row text.
public struct WeaveDivider: View {
  let leadingInset: CGFloat

  public init(leadingInset: CGFloat = 0) { self.leadingInset = leadingInset }

  public var body: some View {
    Rectangle()
      .fill(Color.weave.line)
      .frame(height: WeaveSize.hairline)
      .padding(.leading, leadingInset)
      .accessibilityHidden(true)
  }
}

/// A rounded panel card that stacks its children with inset hairlines between
/// them, like a grouped settings section. An optional label sits above and an
/// optional footer below, both aligned with the text inside.
public struct GroupedCard<Content: View>: View {
  let label: String?
  let footer: String?
  let separatorInset: CGFloat
  let content: Content

  /// - Parameter separatorInset: Leading inset of the separators. The default
  ///   lines up with the title of a `WeaveRow` that has a leading symbol; use 16
  ///   for rows without one.
  public init(label: String? = nil, footer: String? = nil, separatorInset: CGFloat = 56, @ViewBuilder content: () -> Content) {
    self.label = label
    self.footer = footer
    self.separatorInset = separatorInset
    self.content = content()
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: WeaveSpacing.s2) {
      if let label { FieldLabel(label) }
      VStack(spacing: 0) {
        Group(subviews: content) { subviews in
          ForEach(subviews.indices, id: \.self) { index in
            if index > 0 { WeaveDivider(leadingInset: separatorInset) }
            subviews[index]
          }
        }
      }
      .background(Color.weave.panel)
      .clipShape(RoundedRectangle(cornerRadius: WeaveRadius.card, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: WeaveRadius.card, style: .continuous)
          .strokeBorder(Color.weave.line.opacity(0.7), lineWidth: WeaveSize.hairline)
      )
      if let footer {
        Text(footer)
          .font(.weave(.caption))
          .foregroundStyle(Color.weave.muted)
          .padding(.horizontal, WeaveSpacing.s4)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
  }
}

#Preview("Light") {
  GroupedCardPreview().weavePreview(.light)
}

#Preview("Dark") {
  GroupedCardPreview().weavePreview(.dark)
}

private struct GroupedCardPreview: View {
  var body: some View {
    VStack(spacing: WeaveSpacing.s6) {
      GroupedCard(label: "App", footer: "Notifications need a relay and are not in this version.") {
        WeaveRow("Appearance", symbol: "circle.lefthalf.filled", trailingText: "System", showsChevron: true) {}
        WeaveRow("Machines", symbol: "laptopcomputer", trailingText: "3", showsChevron: true) {}
        WeaveRow("About", symbol: "info.circle", showsChevron: true) {}
      }
      GroupedCard(separatorInset: 16) {
        WeaveRow("Log out", isDestructive: true) {}
      }
    }
  }
}
