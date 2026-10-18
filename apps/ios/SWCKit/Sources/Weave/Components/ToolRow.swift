import SwiftUI

/// Progress state shared by tool rows and plan steps.
public nonisolated enum WeaveProgressState: String, Sendable, CaseIterable {
  case pending, running, completed, failed
}

/// One tool call in a transcript: a symbol, a title such as "Ran npm test", an
/// optional detail line and a status glyph. Tap to show the full detail.
public struct ToolRow: View {
  let title: String
  let detail: String?
  let systemName: String
  let state: WeaveProgressState

  @State private var expanded = false

  public init(title: String, detail: String? = nil, systemName: String = "terminal", state: WeaveProgressState) {
    self.title = title
    self.detail = detail
    self.systemName = systemName
    self.state = state
  }

  public var body: some View {
    Button {
      if detail != nil { withAnimation(.snappy) { expanded.toggle() } }
    } label: {
      HStack(alignment: .firstTextBaseline, spacing: WeaveSpacing.s3) {
        Image(systemName: systemName)
          .font(.system(size: 14, weight: .regular))
          .foregroundStyle(Color.weave.muted)
          .frame(width: 20)
        VStack(alignment: .leading, spacing: 2) {
          Text(title)
            .font(.weave(.callout, weight: .medium))
            .foregroundStyle(Color.weave.ink)
            .lineLimit(expanded ? nil : 1)
          if let detail {
            Text(detail)
              .weaveFont(.code)
              .foregroundStyle(Color.weave.muted)
              .lineLimit(expanded ? nil : 1)
              .truncationMode(.middle)
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        WeaveProgressGlyph(state: state)
      }
      .padding(.vertical, WeaveSpacing.s2)
      .frame(minHeight: WeaveSize.minTap)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel([title, detail, WeaveProgressGlyph.label(state)].compactMap(\.self).joined(separator: ", "))
    .accessibilityHint(detail == nil ? "" : (expanded ? "Collapses the detail" : "Shows the full detail"))
  }
}

/// Spinner, check, cross or empty circle for a progress state.
public struct WeaveProgressGlyph: View {
  let state: WeaveProgressState
  let size: CGFloat

  public init(state: WeaveProgressState, size: CGFloat = 15) {
    self.state = state
    self.size = size
  }

  public var body: some View {
    Group {
      switch state {
      case .pending:
        Image(systemName: "circle")
          .font(.system(size: size, weight: .regular))
          .foregroundStyle(Color.weave.control)
      case .running:
        ProgressView()
          .controlSize(.mini)
          .tint(Color.weave.iris)
      case .completed:
        Image(systemName: "checkmark.circle.fill")
          .font(.system(size: size, weight: .regular))
          .foregroundStyle(Color.weave.pass)
      case .failed:
        Image(systemName: "xmark.circle.fill")
          .font(.system(size: size, weight: .regular))
          .foregroundStyle(Color.weave.fail)
      }
    }
    .frame(width: size + 3, height: size + 3)
    .accessibilityLabel(Self.label(state))
  }

  static func label(_ state: WeaveProgressState) -> String {
    switch state {
    case .pending: "Not started"
    case .running: "Running"
    case .completed: "Done"
    case .failed: "Failed"
    }
  }
}

#Preview("Light") {
  ToolRowPreview().weavePreview(.light)
}

#Preview("Dark") {
  ToolRowPreview().weavePreview(.dark)
}

private struct ToolRowPreview: View {
  var body: some View {
    VStack(spacing: 0) {
      ToolRow(title: "Ran tests", detail: "npm --prefix repositories/anton-abyzov/specweave run test:unit:fast", state: .completed)
      ToolRow(title: "Editing ReleasePanel.tsx", detail: "apps/web/src/components/ReleasePanel.tsx", systemName: "pencil", state: .running)
      ToolRow(title: "Searched the web", detail: "npm token rotation oidc", systemName: "magnifyingglass", state: .failed)
      ToolRow(title: "Read 4 files", systemName: "doc.text", state: .pending)
    }
  }
}
