import SwiftUI

/// Frontmatter as a document viewer shows it: one row per key, the label
/// muted above its value, list values as chips. Identifiers (a thread id, a
/// commit) stay on one line, cut in the middle, so they never wrap into a wall.
public struct MarkdownPropertiesView: View {
  let properties: [MarkdownProperty]

  @Environment(\.dynamicTypeSize) private var dynamicTypeSize

  public init(properties: [MarkdownProperty]) {
    self.properties = properties
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      ForEach(properties.indices, id: \.self) { index in
        if index > 0 { WeaveDivider() }
        row(properties[index])
          .padding(.vertical, WeaveSpacing.s2)
      }
    }
    .padding(.horizontal, WeaveSpacing.s3)
    .padding(.vertical, WeaveSpacing.s1)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Color.weave.panel, in: RoundedRectangle(cornerRadius: WeaveRadius.md, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: WeaveRadius.md, style: .continuous).strokeBorder(Color.weave.line, lineWidth: WeaveSize.hairline))
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("markdown.properties")
  }

  @ViewBuilder private func row(_ property: MarkdownProperty) -> some View {
    ViewThatFits(in: .horizontal) {
      // Side by side when the value is short; stacked otherwise.
      HStack(alignment: .firstTextBaseline, spacing: WeaveSpacing.s3) {
        label(property.label).frame(width: 96, alignment: .leading)
        value(property.value, wraps: false)
        Spacer(minLength: 0)
      }
      VStack(alignment: .leading, spacing: 2) {
        label(property.label)
        value(property.value, wraps: true)
      }
    }
    .accessibilityElement(children: .combine)
  }

  private func label(_ text: String) -> some View {
    Text(text)
      .font(.weave(.caption))
      .foregroundStyle(Color.weave.muted)
      .lineLimit(1)
  }

  @ViewBuilder private func value(_ value: MarkdownProperty.Value, wraps: Bool) -> some View {
    switch value {
    case let .text(text) where Self.isIdentifier(text):
      Text(text)
        .font(.weave(.code))
        .foregroundStyle(Color.weave.ink)
        .lineLimit(1)
        .truncationMode(.middle)
        .fixedSize(horizontal: !wraps, vertical: false)
    case let .text(text):
      Text(MarkdownInline.render(text, dynamicTypeSize: dynamicTypeSize))
        .font(.weave(.callout))
        .foregroundStyle(Color.weave.ink)
        .fixedSize(horizontal: !wraps, vertical: true)
    case let .chips(chips):
      WrappingChips(chips: chips)
        .fixedSize(horizontal: !wraps, vertical: true)
    }
  }

  /// One long token with no spaces, such as `thread:delegated-task:…` or a SHA.
  static func isIdentifier(_ text: String) -> Bool {
    text.count >= 20 && !text.contains(" ")
  }

  static func plain(_ value: MarkdownProperty.Value) -> String {
    switch value {
    case let .text(text): text
    case let .chips(chips): chips.joined(separator: ", ")
    }
  }
}

/// Chips that wrap onto new lines on a narrow screen.
private struct WrappingChips: View {
  let chips: [String]

  var body: some View {
    ChipFlow(spacing: WeaveSpacing.s1) {
      ForEach(chips, id: \.self) { chip in
        Text(chip)
          .font(.weave(.caption))
          .foregroundStyle(Color.weave.ink)
          .lineLimit(1)
          .padding(.horizontal, 6)
          .padding(.vertical, 2)
          .background(Color.weave.ink.opacity(0.05), in: RoundedRectangle(cornerRadius: WeaveRadius.xs, style: .continuous))
          .overlay(RoundedRectangle(cornerRadius: WeaveRadius.xs, style: .continuous).strokeBorder(Color.weave.ink.opacity(0.1), lineWidth: WeaveSize.hairline))
      }
    }
  }
}

/// A left-aligned flow layout: items in a row until the width runs out.
private struct ChipFlow: Layout {
  var spacing: CGFloat

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let rows = arrange(width: proposal.width ?? .infinity, subviews: subviews)
    let width = rows.map(\.width).max() ?? 0
    let height = rows.reduce(0) { $0 + $1.height } + spacing * CGFloat(max(0, rows.count - 1))
    return CGSize(width: width, height: height)
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    var y = bounds.minY
    for row in arrange(width: bounds.width, subviews: subviews) {
      var x = bounds.minX
      for index in row.indices {
        let size = subviews[index].sizeThatFits(.unspecified)
        subviews[index].place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
        x += size.width + spacing
      }
      y += row.height + spacing
    }
  }

  private struct Row {
    var indices: [Int] = []
    var width: CGFloat = 0
    var height: CGFloat = 0
  }

  private func arrange(width: CGFloat, subviews: Subviews) -> [Row] {
    var rows: [Row] = []
    var current = Row()
    for index in subviews.indices {
      let size = subviews[index].sizeThatFits(.unspecified)
      let needed = current.indices.isEmpty ? size.width : current.width + spacing + size.width
      if needed > width, !current.indices.isEmpty {
        rows.append(current)
        current = Row()
      }
      current.width = current.indices.isEmpty ? size.width : current.width + spacing + size.width
      current.height = max(current.height, size.height)
      current.indices.append(index)
    }
    if !current.indices.isEmpty { rows.append(current) }
    return rows
  }
}

/// A Markdown file as a page: a large title, its properties, then the body.
public struct MarkdownDocumentView: View {
  let document: MarkdownDocument
  let onOpenLink: ((URL) -> Void)?

  public init(_ text: String, onOpenLink: ((URL) -> Void)? = nil) {
    self.document = MarkdownDocument.parse(text)
    self.onOpenLink = onOpenLink
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: WeaveSpacing.s4) {
      if let title = document.title {
        Text(title)
          .font(.system(.title, design: .serif, weight: .semibold))
          .foregroundStyle(Color.weave.ink)
          .fixedSize(horizontal: false, vertical: true)
          .textSelection(.enabled)
          .accessibilityAddTraits(.isHeader)
          .accessibilityIdentifier("markdown.document.title")
      }
      if !document.properties.isEmpty {
        MarkdownPropertiesView(properties: document.properties)
      }
      MarkdownText(document.body, onOpenLink: onOpenLink)
    }
    .frame(maxWidth: WeaveSize.readableColumn, alignment: .leading)
    .frame(maxWidth: .infinity, alignment: .center)
  }
}
