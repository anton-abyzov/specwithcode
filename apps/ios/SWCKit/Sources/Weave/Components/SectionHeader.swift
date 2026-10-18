import SwiftUI

/// A group header: "Working (4)" in secondary text followed by a hairline that
/// fills the rest of the line.
public struct SectionHeader: View {
  let title: String
  let count: Int?

  public init(_ title: String, count: Int? = nil) {
    self.title = title
    self.count = count
  }

  public var body: some View {
    HStack(spacing: WeaveSpacing.s2) {
      Text(count.map { "\(title) (\($0))" } ?? title)
        .font(.weave(.callout))
        .foregroundStyle(Color.weave.muted)
        .lineLimit(1)
        .layoutPriority(1)
      WeaveDivider()
    }
    .padding(.vertical, WeaveSpacing.s2)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(count.map { "\(title), \($0)" } ?? title)
    .accessibilityAddTraits(.isHeader)
  }
}

/// A label above a field or card, in sentence case, indented to line up with
/// the text inside the card.
public struct FieldLabel: View {
  let text: String

  public init(_ text: String) { self.text = text }

  public var body: some View {
    Text(text)
      .font(.weave(.callout))
      .foregroundStyle(Color.weave.muted)
      .padding(.horizontal, WeaveSpacing.s4)
      .accessibilityAddTraits(.isHeader)
  }
}

#Preview("Light") {
  SectionHeaderPreview().weavePreview(.light)
}

#Preview("Dark") {
  SectionHeaderPreview().weavePreview(.dark)
}

private struct SectionHeaderPreview: View {
  var body: some View {
    VStack(alignment: .leading, spacing: WeaveSpacing.s4) {
      SectionHeader("Working", count: 4)
      SectionHeader("Idle", count: 14)
      SectionHeader("Pinned")
      FieldLabel("Goal")
    }
  }
}
