import SwiftUI

/// A request for approval in a transcript, with Approve, For session and Deny.
/// Once answered it shows the outcome instead of the buttons.
public struct ApprovalCard: View {
  public enum Decision: String, Sendable, CaseIterable {
    case approve, approveForSession, deny
  }

  let title: String
  let prompt: String
  let isResolved: Bool
  let resolvedText: String
  let allowsSession: Bool
  let isBusy: Bool
  let onDecision: (Decision) -> Void

  /// - Parameters:
  ///   - prompt: What the agent wants to do, for example a command. Shown in mono.
  ///   - resolvedText: Shown once resolved, for example "Approved".
  ///   - allowsSession: Shows "For session".
  ///   - isBusy: Disables the buttons while a decision is being sent.
  public init(title: String = "Approval needed", prompt: String, isResolved: Bool, resolvedText: String = "Answered", allowsSession: Bool = true, isBusy: Bool = false, onDecision: @escaping (Decision) -> Void) {
    self.title = title
    self.prompt = prompt
    self.isResolved = isResolved
    self.resolvedText = resolvedText
    self.allowsSession = allowsSession
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
      // The whole command shows while it waits for a decision, so nothing is
      // approved unseen; a long one makes the card taller and the transcript
      // scrolls. Once answered it shrinks to a two-line summary.
      Text(prompt)
        .weaveFont(.code)
        .foregroundStyle(isResolved ? Color.weave.muted : Color.weave.ink)
        .textSelection(.enabled)
        .lineLimit(isResolved ? 2 : nil)
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(WeaveSpacing.s3)
        .background(Color.weave.sunken, in: RoundedRectangle(cornerRadius: WeaveRadius.md, style: .continuous))
      if !isResolved {
        ViewThatFits(in: .horizontal) {
          HStack(spacing: WeaveSpacing.s2) { buttons(fullWidth: false) }
          VStack(spacing: WeaveSpacing.s2) { buttons(fullWidth: true) }
        }
        .disabled(isBusy)
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

  @ViewBuilder private func buttons(fullWidth: Bool) -> some View {
    WeaveButton("Approve", kind: .primary, fullWidth: fullWidth, isLoading: isBusy) { onDecision(.approve) }
      .fixedSize(horizontal: !fullWidth, vertical: false)
    if allowsSession {
      WeaveButton("For session", kind: .secondary, fullWidth: fullWidth) { onDecision(.approveForSession) }
        .fixedSize(horizontal: !fullWidth, vertical: false)
    }
    WeaveButton("Deny", kind: .destructive, fullWidth: fullWidth) { onDecision(.deny) }
      .fixedSize(horizontal: !fullWidth, vertical: false)
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

  var body: some View {
    ScrollView {
      VStack(spacing: WeaveSpacing.s4) {
        ApprovalCard(prompt: "git push origin inc/0931-weave", isResolved: false) { _ in }
        ApprovalCard(prompt: Self.heredoc, isResolved: false) { _ in }
        ApprovalCard(prompt: "rm -rf node_modules", isResolved: true, resolvedText: "Approved") { _ in }
      }
    }
  }
}
