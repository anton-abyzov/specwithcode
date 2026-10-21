import SwiftUI

/// The user's message: right aligned in a rounded bubble. Assistant replies are
/// not bubbled; render them with `MarkdownText`.
public struct MessageBubble: View {
  let text: String
  let footnote: String?
  let isPending: Bool
  let onOpenLink: ((URL) -> Void)?

  @Environment(\.colorScheme) private var colorScheme

  /// - Parameters:
  ///   - footnote: A short line under the bubble, for example "Queued".
  ///   - isPending: Dims the bubble while the message is not confirmed.
  public init(_ text: String, footnote: String? = nil, isPending: Bool = false, onOpenLink: ((URL) -> Void)? = nil) {
    self.text = text
    self.footnote = footnote
    self.isPending = isPending
    self.onOpenLink = onOpenLink
  }

  public var body: some View {
    VStack(alignment: .trailing, spacing: WeaveSpacing.s1) {
      MarkdownText(text, onOpenLink: onOpenLink)
        .weaveFont(.body)
        .foregroundStyle(Color.weave.ink)
        .tint(Color.weave.iris)
        .textSelection(.enabled)
        .padding(.horizontal, WeaveSpacing.s4)
        .padding(.vertical, WeaveSpacing.s3 - 1)
        .background(Color.weave.bubble, in: RoundedRectangle(cornerRadius: WeaveRadius.bubble, style: .continuous))
        .overlay {
          if colorScheme == .dark {
            RoundedRectangle(cornerRadius: WeaveRadius.bubble, style: .continuous)
              .strokeBorder(Color.weave.line, lineWidth: WeaveSize.hairline)
          }
        }
        .opacity(isPending ? 0.65 : 1)
        .contextMenu {
          Button("Copy", systemImage: "doc.on.doc") { WeaveClipboard.copyAnnounced(text) }
        }
      if let footnote {
        Text(footnote)
          .font(.weave(.caption))
          .foregroundStyle(Color.weave.muted)
          .padding(.trailing, WeaveSpacing.s2)
      }
    }
    .frame(maxWidth: .infinity, alignment: .trailing)
    .padding(.leading, 56)
    .accessibilityElement(children: .contain)
  }
}

#Preview("Light") {
  MessageBubblePreview().weavePreview(.light)
}

#Preview("Dark") {
  MessageBubblePreview().weavePreview(.dark)
}

private struct MessageBubblePreview: View {
  var body: some View {
    VStack(spacing: WeaveSpacing.s4) {
      MessageBubble("Can you check why the release workflow failed on main? Logs are at https://github.com/anton-abyzov/specweave/actions")
      MessageBubble("Then merge the docs PR.", footnote: "Queued", isPending: true)
    }
  }
}
