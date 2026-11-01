import SwiftUI

/// A request for approval in a transcript. The provider's own options become the
/// buttons, in a fixed order (approve, session, always, deny) with Cancel as a
/// quiet text action; without options it falls back to Approve, For session and
/// Deny. Once answered it shows the outcome instead of the buttons.
public struct ApprovalCard: View {
  public enum Decision: String, Sendable, CaseIterable {
    case approve, approveForSession, approveAlways, deny, cancel
  }

  /// What is being approved; names the card like web and mobile do.
  public enum Kind: String, Sendable, CaseIterable {
    case command
    case fileRead = "file-read"
    case fileChange = "file-change"
    case mcpElicitation = "mcp-elicitation"
    case permission

    public var title: String {
      switch self {
      case .command: "Command approval"
      case .fileRead: "File read approval"
      case .fileChange: "File change approval"
      case .mcpElicitation: "App access approval"
      case .permission: "App permission approval"
      }
    }
  }

  /// One choice the provider offers, with its own label and optional caution.
  public struct Option: Hashable, Sendable {
    public var decision: Decision
    public var label: String
    public var warning: String?

    public init(_ decision: Decision, label: String, warning: String? = nil) {
      self.decision = decision
      self.label = label
      self.warning = warning
    }
  }

  let title: String
  let kind: Kind?
  let prompt: String
  let isResolved: Bool
  let resolvedText: String
  let options: [Option]
  let isBusy: Bool
  let onDecision: (Decision) -> Void

  /// About eight lines of the code font; a longer prompt scrolls inside the well.
  @ScaledMetric(relativeTo: .callout) private var promptMaxHeight: CGFloat = 8 * WeaveFont.code.size * WeaveFont.code.lineHeightMultiple

  /// - Parameters:
  ///   - title: Overrides the kind-based title.
  ///   - kind: Names the card ("Command approval") and picks the prompt font.
  ///   - prompt: What the agent wants to do, for example a command. Shown in mono.
  ///   - resolvedText: Shown once resolved, for example "Approved".
  ///   - options: The provider's choices. Only these show when given.
  ///   - allowsSession: Shows "For session" when no options are given.
  ///   - isBusy: Disables the buttons while a decision is being sent.
  public init(title: String? = nil, kind: Kind? = nil, prompt: String, isResolved: Bool, resolvedText: String = "Answered", options: [Option]? = nil, allowsSession: Bool = true, isBusy: Bool = false, onDecision: @escaping (Decision) -> Void) {
    self.title = title ?? kind?.title ?? "Approval needed"
    self.kind = kind
    self.prompt = prompt
    self.isResolved = isResolved
    self.resolvedText = resolvedText
    self.options = Self.resolvedOptions(options, allowsSession: allowsSession)
    self.isBusy = isBusy
    self.onDecision = onDecision
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: WeaveSpacing.s3) {
      HStack(spacing: WeaveSpacing.s2) {
        Image(systemName: isResolved ? "checkmark.shield" : "hand.raised")
          .font(.system(size: 15, weight: .medium))
          .foregroundStyle(isResolved ? Color.weave.muted : Color.weave.warn)
          .accessibilityHidden(true)
        Text(title)
          .font(.weave(.callout, weight: .semibold))
          .foregroundStyle(isResolved ? Color.weave.muted : Color.weave.ink)
        Spacer(minLength: 0)
        if isResolved {
          StatusChip(resolvedText, kind: .neutral)
        }
      }
      promptWell
      if !isResolved {
        ViewThatFits(in: .horizontal) {
          HStack(spacing: WeaveSpacing.s2) {
            buttons(fullWidth: false)
            Spacer(minLength: 0)
            cancelButton
          }
          VStack(spacing: WeaveSpacing.s2) {
            buttons(fullWidth: true)
            cancelButton
          }
        }
        .disabled(isBusy)
        warnings
      }
    }
    .padding(WeaveSpacing.s4)
    .background(Color.weave.panel, in: RoundedRectangle(cornerRadius: WeaveRadius.card, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: WeaveRadius.card, style: .continuous)
        .strokeBorder(isResolved ? Color.weave.line : Color.weave.warn.opacity(0.5), lineWidth: isResolved ? WeaveSize.hairline : 1)
    )
    .accessibilityElement(children: .contain)
  }

  // The prompt shows in full up to about eight lines, then scrolls inside the
  // well, so a heredoc stays readable without pushing the buttons off screen.
  // Once answered it shrinks to a two-line summary.
  private var promptWell: some View {
    BoundedHeight(maxHeight: isResolved ? .infinity : promptMaxHeight) {
      ViewThatFits(in: .vertical) {
        promptText
        ScrollView(.vertical) { promptText }
          .scrollIndicators(.visible)
      }
    }
    .background(Color.weave.sunken, in: RoundedRectangle(cornerRadius: WeaveRadius.md, style: .continuous))
    .clipShape(RoundedRectangle(cornerRadius: WeaveRadius.md, style: .continuous))
  }

  private var promptText: some View {
    // An app access request is prose; everything else is a command or path.
    Text(prompt)
      .weaveFont(kind == .mcpElicitation ? .callout : .code)
      .foregroundStyle(isResolved ? Color.weave.muted : Color.weave.ink)
      .textSelection(.enabled)
      .lineLimit(isResolved ? 2 : nil)
      .fixedSize(horizontal: false, vertical: true)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(WeaveSpacing.s3)
  }

  private var primaryOptions: [Option] { options.filter { $0.decision != .cancel } }
  private var cancelOption: Option? { options.first { $0.decision == .cancel } }

  @ViewBuilder private func buttons(fullWidth: Bool) -> some View {
    ForEach(primaryOptions, id: \.decision) { option in
      WeaveButton(
        option.label,
        systemImage: option.warning == nil ? nil : "exclamationmark.triangle",
        kind: Self.buttonKind(option.decision),
        fullWidth: fullWidth,
        isLoading: isBusy && option.decision == .approve
      ) { onDecision(option.decision) }
        .fixedSize(horizontal: !fullWidth, vertical: false)
    }
  }

  @ViewBuilder private var cancelButton: some View {
    if let cancelOption {
      Button { onDecision(.cancel) } label: {
        Text(cancelOption.label)
          .weaveFont(.callout)
          .foregroundStyle(Color.weave.muted)
          .padding(.horizontal, WeaveSpacing.s2)
          .frame(minHeight: WeaveSize.minTap)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .fixedSize()
    }
  }

  @ViewBuilder private var warnings: some View {
    let cautioned = options.filter { $0.warning != nil }
    if !cautioned.isEmpty {
      VStack(alignment: .leading, spacing: WeaveSpacing.s1) {
        ForEach(cautioned, id: \.decision) { option in
          Label {
            Text("\(option.label): \(option.warning ?? "")")
          } icon: {
            Image(systemName: "exclamationmark.triangle")
          }
          .weaveFont(.caption)
          .foregroundStyle(Color.weave.warn)
        }
      }
    }
  }

  private static func buttonKind(_ decision: Decision) -> WeaveButton.Kind {
    switch decision {
    case .approve: .primary
    case .approveForSession, .approveAlways: .secondary
    case .deny: .destructive
    case .cancel: .ghost
    }
  }

  /// Provider options in a stable order, one per decision; the defaults when
  /// the provider sends none.
  private static func resolvedOptions(_ options: [Option]?, allowsSession: Bool) -> [Option] {
    if let options, !options.isEmpty {
      var seen = Set<Decision>()
      let unique = options.filter { seen.insert($0.decision).inserted }
      return Decision.allCases.compactMap { decision in unique.first { $0.decision == decision } }
    }
    var defaults = [Option(.approve, label: "Approve")]
    if allowsSession { defaults.append(Option(.approveForSession, label: "For session")) }
    defaults.append(Option(.deny, label: "Deny"))
    return defaults
  }
}

/// Proposes at most `maxHeight` to its content, also when the parent proposes
/// no height (a transcript scroll view), so a `ViewThatFits` inside can choose
/// between the plain prompt and a scrolling one.
private struct BoundedHeight: Layout {
  let maxHeight: CGFloat

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    guard let content = subviews.first else { return .zero }
    return content.sizeThatFits(bounded(proposal))
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    subviews.first?.place(at: bounds.origin, proposal: ProposedViewSize(width: bounds.width, height: bounds.height))
  }

  private func bounded(_ proposal: ProposedViewSize) -> ProposedViewSize {
    guard maxHeight.isFinite else { return proposal }
    return ProposedViewSize(width: proposal.width, height: min(proposal.height ?? maxHeight, maxHeight))
  }
}

#Preview("Light") {
  ApprovalCardPreview().weavePreview(.light)
}

#Preview("Dark") {
  ApprovalCardPreview().weavePreview(.dark)
}

private struct ApprovalCardPreview: View {
  static let heredoc = """
  cat > scripts/release/notes.sh <<'SCRIPT'
  #!/usr/bin/env bash
  set -euo pipefail
  version="$(node -p "require('./package.json').version")"
  previous="$(git describe --tags --abbrev=0 HEAD^)"
  echo "## ${version}"
  git log --pretty='- %s' "${previous}..HEAD" -- src docs
  echo
  echo "Full diff: https://github.com/anton-abyzov/specweave/compare/${previous}...v${version}"
  gh release create "v${version}" --notes-file - --verify-tag
  npm publish --tag next --provenance
  git push origin "v${version}"
  curl -fsS https://spec-weave.com/api/revalidate -X POST
  SCRIPT
  chmod +x scripts/release/notes.sh && scripts/release/notes.sh
  """

  static let providerOptions: [ApprovalCard.Option] = [
    .init(.cancel, label: "Cancel"),
    .init(.deny, label: "Decline"),
    .init(.approveAlways, label: "Always allow Safari", warning: "Safari can act without asking again."),
    .init(.approve, label: "Approve"),
  ]

  var body: some View {
    ScrollView {
      VStack(spacing: WeaveSpacing.s4) {
        ApprovalCard(kind: .command, prompt: "git push origin inc/0931-weave", isResolved: false) { _ in }
        ApprovalCard(kind: .command, prompt: Self.heredoc, isResolved: false, allowsSession: false) { _ in }
        ApprovalCard(kind: .mcpElicitation, prompt: "Safari wants to open spec-weave.com and read the page.", isResolved: false, options: Self.providerOptions) { _ in }
        ApprovalCard(kind: .command, prompt: "rm -rf node_modules", isResolved: true, resolvedText: "Approved") { _ in }
      }
    }
  }
}
