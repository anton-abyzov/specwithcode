import SwiftUI
import SWCSync
import Weave

/// One transcript row drawn with the matching Weave component.
struct TranscriptRowView: View {
  let row: TranscriptRow
  let busyRequests: Set<String>
  let onDecision: (String, ApprovalDecision) -> Void
  let onOpenThread: (ThreadRef) -> Void

  /// Replies longer than this collapse behind "Show more".
  static let collapseThreshold = 1_200
  /// Extra leading inset that lines unbubbled rows up with the content inset.
  private static let textInset = WeaveSpacing.contentInset - WeaveSpacing.gutter

  var body: some View {
    switch row.kind {
    case let .user(text, state):
      MessageBubble(text, footnote: state.footnote, isPending: state != .sent)

    case let .assistant(markdown, streaming):
      if markdown.isEmpty, streaming {
        EmptyView()
      } else {
        MarkdownText(markdown, collapsible: !streaming && markdown.count > Self.collapseThreshold)
          .padding(.leading, Self.textInset)
          .padding(.trailing, WeaveSpacing.s2)
      }

    case let .reasoning(text, streaming):
      ReasoningRow(text: text, streaming: streaming)
        .padding(.leading, Self.textInset)

    case let .tool(title, detail, symbol, status):
      ToolRow(title: title, detail: detail, systemName: symbol, state: status.progressState)
        .padding(.leading, Self.textInset)

    case let .plan(steps):
      PlanCard(steps: steps.map { PlanCard.Step(id: $0.id, text: $0.text, state: $0.status.progressState) })

    case let .proposedPlan(markdown):
      ProposedPlanCard(markdown: markdown)

    case let .approval(requestId, prompt, resolved):
      ApprovalCard(prompt: prompt, isResolved: resolved, isBusy: busyRequests.contains(requestId)) { decision in
        onDecision(requestId, decision.engineDecision)
      }

    case let .question(_, prompt, resolved):
      QuestionCard(prompt: prompt, resolved: resolved)

    case let .subagent(title, child):
      SubagentRow(title: title, child: child, onOpen: onOpenThread)
        .padding(.leading, Self.textInset)

    case let .error(message):
      Banner(message, kind: .fail)

    case let .notice(text):
      Text(text)
        .weaveFont(.caption)
        .foregroundStyle(Color.weave.muted)
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity)
        .padding(.vertical, WeaveSpacing.s1)
    }
  }
}

/// The model's reasoning, collapsed to one line until tapped.
private struct ReasoningRow: View {
  let text: String
  let streaming: Bool
  @State private var expanded = false

  var body: some View {
    VStack(alignment: .leading, spacing: WeaveSpacing.s2) {
      Button {
        withAnimation(.snappy) { expanded.toggle() }
      } label: {
        HStack(spacing: WeaveSpacing.s2) {
          Image(systemName: "brain")
            .font(.system(size: 14, weight: .regular))
            .frame(width: 20)
            .accessibilityHidden(true)
          Text(streaming ? "Thinking…" : "Thought")
            .font(.weave(.callout, weight: .medium))
          Image(systemName: expanded ? "chevron.up" : "chevron.down")
            .font(.system(size: 11, weight: .semibold))
            .accessibilityHidden(true)
          Spacer(minLength: 0)
        }
        .foregroundStyle(Color.weave.muted)
        .frame(minHeight: WeaveSize.minTap)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel(streaming ? "Thinking" : "Thought")
      .accessibilityValue(expanded ? "Expanded" : "Collapsed")
      .accessibilityHint(expanded ? "Hides the reasoning" : "Shows the reasoning")
      if expanded {
        Text(text)
          .weaveFont(.callout)
          .foregroundStyle(Color.weave.muted)
          .textSelection(.enabled)
          .padding(.leading, 28)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
  }
}

private struct ProposedPlanCard: View {
  let markdown: String

  var body: some View {
    VStack(alignment: .leading, spacing: WeaveSpacing.s3) {
      Label("Proposed plan", systemImage: "list.bullet.clipboard")
        .font(.weave(.callout, weight: .semibold))
        .foregroundStyle(Color.weave.ink)
      MarkdownText(markdown, collapsible: markdown.count > TranscriptRowView.collapseThreshold, collapsedHeight: 320)
    }
    .padding(WeaveSpacing.s4)
    .frame(maxWidth: .infinity, alignment: .leading)
    .weavePanel(in: RoundedRectangle(cornerRadius: WeaveRadius.card, style: .continuous))
    .accessibilityElement(children: .contain)
  }
}

/// A question the run asked. The answer goes in the composer.
private struct QuestionCard: View {
  let prompt: String
  let resolved: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: WeaveSpacing.s3) {
      HStack(spacing: WeaveSpacing.s2) {
        Image(systemName: resolved ? "checkmark.bubble" : "questionmark.bubble")
          .font(.system(size: 15, weight: .medium))
          .foregroundStyle(resolved ? Color.weave.muted : Color.weave.warn)
          .accessibilityHidden(true)
        Text("Question")
          .font(.weave(.callout, weight: .semibold))
          .foregroundStyle(resolved ? Color.weave.muted : Color.weave.ink)
        Spacer(minLength: 0)
        if resolved { StatusChip("Answered", kind: .neutral) }
      }
      Text(prompt)
        .weaveFont(.body)
        .foregroundStyle(resolved ? Color.weave.muted : Color.weave.ink)
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
      if !resolved {
        Text("Reply in the message box below.")
          .weaveFont(.caption)
          .foregroundStyle(Color.weave.muted)
      }
    }
    .padding(WeaveSpacing.s4)
    .weavePanel(in: RoundedRectangle(cornerRadius: WeaveRadius.card, style: .continuous))
    .accessibilityElement(children: .combine)
  }
}

/// A delegated thread. Opens that thread when it is known.
private struct SubagentRow: View {
  let title: String
  let child: ThreadRef?
  let onOpen: (ThreadRef) -> Void

  var body: some View {
    let content = HStack(alignment: .firstTextBaseline, spacing: WeaveSpacing.s3) {
      Image(systemName: "arrow.triangle.branch")
        .font(.system(size: 14, weight: .regular))
        .foregroundStyle(Color.weave.muted)
        .frame(width: 20)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 2) {
        Text(title)
          .font(.weave(.callout, weight: .medium))
          .foregroundStyle(Color.weave.ink)
          .lineLimit(2)
        Text(child == nil ? "Sub-thread" : "Sub-thread · Open")
          .font(.weave(.caption))
          .foregroundStyle(child == nil ? Color.weave.muted : Color.weave.iris)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      if child != nil {
        Image(systemName: "chevron.right")
          .font(.system(size: 12, weight: .semibold))
          .foregroundStyle(Color.weave.control)
          .accessibilityHidden(true)
      }
    }
    .padding(.vertical, WeaveSpacing.s2)
    .frame(minHeight: WeaveSize.minTap)
    .contentShape(Rectangle())

    if let child {
      Button { onOpen(child) } label: { content }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Sub-thread: \(title)")
        .accessibilityHint("Opens the thread")
        .accessibilityAddTraits(.isButton)
    } else {
      content
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Sub-thread: \(title)")
    }
  }
}
