import SwiftUI

/// One line standing for a turn's folded steps: "Worked · Ran 3 commands",
/// with a failure count when some failed and a spinner while the turn runs.
/// Tap to open or close the steps.
public struct TurnFoldRow: View {
  let label: String
  let summary: String?
  let failures: Int
  let expanded: Bool
  let running: Bool
  let onToggle: () -> Void

  public init(label: String, summary: String? = nil, failures: Int = 0, expanded: Bool, running: Bool = false, onToggle: @escaping () -> Void) {
    self.label = label
    self.summary = summary
    self.failures = failures
    self.expanded = expanded
    self.running = running
    self.onToggle = onToggle
  }

  public var body: some View {
    Button(action: { withAnimation(.snappy) { onToggle() } }) {
      HStack(alignment: .firstTextBaseline, spacing: WeaveSpacing.s2) {
        Image(systemName: expanded ? "chevron.down" : "chevron.right")
          .font(.system(size: 12, weight: .semibold))
          .foregroundStyle(Color.weave.muted)
          .frame(width: 20)
        Text(text)
          .font(.weave(.callout))
          .foregroundStyle(Color.weave.muted)
          .lineLimit(2)
        if failures > 0 {
          Text(failures == 1 ? "1 failed" : "\(failures) failed")
            .font(.weave(.caption, weight: .medium))
            .foregroundStyle(Color.weave.fail)
        }
        Spacer(minLength: 0)
        if running {
          ProgressView()
            .controlSize(.mini)
            .tint(Color.weave.iris)
        }
      }
      .padding(.vertical, WeaveSpacing.s2)
      .frame(minHeight: WeaveSize.minTap)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(accessibilityText)
    .accessibilityHint(expanded ? "Hides the steps" : "Shows the steps")
    .accessibilityAddTraits(.isButton)
  }

  private var text: String {
    summary.map { "\(label) · \($0)" } ?? label
  }

  private var accessibilityText: String {
    var parts = [text]
    if failures > 0 { parts.append(failures == 1 ? "1 failed" : "\(failures) failed") }
    if running { parts.append("Running") }
    return parts.joined(separator: ", ")
  }
}

#Preview("Light") {
  VStack(spacing: 0) {
    TurnFoldRow(label: "Worked", summary: "Ran 3 commands · Edited 1 file", expanded: false) {}
    TurnFoldRow(label: "Worked", summary: "Ran 2 commands", failures: 1, expanded: true) {}
    TurnFoldRow(label: "Working", summary: "Ran 1 command", expanded: false, running: true) {}
  }
  .weavePreview(.light)
}
