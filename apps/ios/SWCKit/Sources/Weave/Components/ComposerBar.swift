import SwiftUI

/// The message composer: a glass capsule with attach, a growing text field, mic
/// and send. While a run is active and the field is empty, send becomes stop;
/// typing turns it back into send, which queues the message. A suggested next
/// prompt shows as a chip above it while the field is empty and idle.
public struct ComposerBar: View {
  @Binding var text: String
  let isRunning: Bool
  let placeholder: String?
  let blockedReason: String?
  let hasAttachments: Bool
  let suggestion: String?
  let focus: FocusState<Bool>.Binding?
  let onSend: () -> Void
  let onStop: (() -> Void)?
  let onAttach: (() -> Void)?
  let onMic: (() -> Void)?
  private var attachmentControl: AnyView?
  let onAcceptSuggestion: ((String) -> Void)?

  @FocusState private var ownFocus: Bool
  @Environment(\.verticalSizeClass) private var verticalSizeClass

  /// - Parameters:
  ///   - placeholder: Overrides "Message…" (idle) and "Queue a message…" (running).
  ///   - blockedReason: When set, the composer is disabled and shows this line above it.
  ///   - hasAttachments: Something to send even with no text.
  ///   - suggestion: A predicted next prompt, offered while the field is empty.
  ///   - focus: Lets the caller move focus into the field.
  ///   - onStop: Hides the stop button when nil.
  ///   - onAttach: Hides the attach button when nil.
  ///   - onMic: Hides the mic button when nil.
  ///   - onAcceptSuggestion: Fills the draft with the suggestion; hides it when nil.
  public init(
    text: Binding<String>,
    isRunning: Bool = false,
    placeholder: String? = nil,
    blockedReason: String? = nil,
    hasAttachments: Bool = false,
    suggestion: String? = nil,
    focus: FocusState<Bool>.Binding? = nil,
    onSend: @escaping () -> Void,
    onStop: (() -> Void)? = nil,
    onAttach: (() -> Void)? = nil,
    onMic: (() -> Void)? = nil,
    onAcceptSuggestion: ((String) -> Void)? = nil
  ) {
    self._text = text
    self.isRunning = isRunning
    self.placeholder = placeholder
    self.blockedReason = blockedReason
    self.hasAttachments = hasAttachments
    self.suggestion = suggestion
    self.focus = focus
    self.onSend = onSend
    self.onStop = onStop
    self.onAttach = onAttach
    self.onMic = onMic
    self.onAcceptSuggestion = onAcceptSuggestion
  }

  /// Places a feature-owned attachment control at the actual composer anchor.
  /// Its menus and pickers must be attached here, not to the enclosing screen.
  public func attachmentControl<Control: View>(@ViewBuilder _ control: () -> Control) -> Self {
    var copy = self
    copy.attachmentControl = AnyView(control())
    return copy
  }

  /// The stop square is a small solid shape; at the default scale it reads
  /// as a dot, so it is drawn larger than the other composer glyphs.
  static let stopGlyphScale: CGFloat = 0.55

  private var isBlocked: Bool { blockedReason != nil }
  private var isEmpty: Bool { text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !hasAttachments }
  private var canSend: Bool { !isEmpty && !isBlocked }
  private var showsStop: Bool { isRunning && isEmpty && onStop != nil }
  private var shownSuggestion: String? {
    guard onAcceptSuggestion != nil, isEmpty, !isRunning, !isBlocked else { return nil }
    return suggestion
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: WeaveSpacing.s2) {
      if let blockedReason {
        Label(blockedReason, systemImage: "exclamationmark.circle")
          .font(.weave(.callout))
          .foregroundStyle(Color.weave.muted)
          .padding(.horizontal, WeaveSpacing.s4)
          .transition(.opacity)
      }
      if let shownSuggestion, let onAcceptSuggestion {
        Button {
          onAcceptSuggestion(shownSuggestion)
          (focus ?? $ownFocus).wrappedValue = true
        } label: {
          Label(shownSuggestion, systemImage: "arrow.turn.down.right")
            .font(.weave(.callout))
            .foregroundStyle(Color.weave.ink)
            .lineLimit(2)
            .multilineTextAlignment(.leading)
            .padding(.horizontal, WeaveSpacing.s3)
            .padding(.vertical, WeaveSpacing.s2)
            .background(Color.weave.sunken, in: Capsule())
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .frame(minHeight: WeaveSize.minTap)
        .padding(.horizontal, WeaveSpacing.s2)
        .accessibilityLabel("Suggested prompt: \(shownSuggestion)")
        .accessibilityHint("Fills the message")
        .accessibilityIdentifier("composer.suggestion")
        .transition(.opacity)
      }
      HStack(alignment: .bottom, spacing: WeaveSpacing.s2) {
        if let attachmentControl {
          attachmentControl
            .frame(width: WeaveSize.innerControl, height: WeaveSize.innerControl)
            .disabled(isBlocked)
        } else if let onAttach {
          WeaveIconButton("plus", label: "Attach", style: .sunken, size: WeaveSize.innerControl, action: onAttach)
            .frame(width: WeaveSize.innerControl, height: WeaveSize.innerControl)
            .disabled(isBlocked)
        }
        let prompt = placeholder ?? (isRunning ? "Queue a message…" : "Message…")
        TextField(prompt, text: $text, prompt: Text.weavePlaceholder(prompt), axis: .vertical)
          .font(.weave(.body))
          .foregroundStyle(Color.weave.ink)
          // Landscape phones have little height; a 6-line field would hide the transcript.
          .lineLimit(1...(verticalSizeClass == .compact ? 3 : 6))
          .focused(focus ?? $ownFocus)
          .disabled(isBlocked)
          .padding(.vertical, 7)
          .padding(.leading, onAttach == nil && attachmentControl == nil ? WeaveSpacing.s2 : 0)
          .frame(minHeight: WeaveSize.innerControl)
          .accessibilityLabel("Message")
        if let onMic, isEmpty, !showsStop {
          WeaveIconButton("mic", label: "Dictate", style: .sunken, size: WeaveSize.innerControl, action: onMic)
            .frame(width: WeaveSize.innerControl, height: WeaveSize.innerControl)
            .disabled(isBlocked)
        }
        trailingButton
          .frame(width: WeaveSize.innerControl, height: WeaveSize.innerControl)
      }
      .padding(WeaveSpacing.s2)
      .frame(minHeight: WeaveSize.composer)
      .weaveGlass(in: RoundedRectangle(cornerRadius: WeaveSize.composer / 2, style: .continuous))
      .contentShape(RoundedRectangle(cornerRadius: WeaveSize.composer / 2, style: .continuous))
      .onTapGesture { if !isBlocked { (focus ?? $ownFocus).wrappedValue = true } }
      // The whole capsule is the field's touch target; the identifier lets UI
      // tests measure it instead of the field's text line.
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("composer")
    }
    .animation(.easeOut(duration: 0.15), value: showsStop)
    .animation(.easeOut(duration: 0.15), value: blockedReason)
    .animation(.easeOut(duration: 0.15), value: shownSuggestion)
  }

  @ViewBuilder private var trailingButton: some View {
    if showsStop, let onStop {
      // A bare square reads as "stop recording" beside a dictation keyboard;
      // the turning ring ties it to the agent's reply that is still running.
      WeaveIconButton("stop.fill", label: "Stop reply", style: .sunken, size: WeaveSize.innerControl, glyphScale: Self.stopGlyphScale, action: onStop)
        .overlay { RunningRing(diameter: WeaveSize.innerControl) }
        .accessibilityHint("Stops the agent's current turn")
        .disabled(isBlocked)
        .transition(.scale.combined(with: .opacity))
    } else {
      WeaveIconButton("arrow.up", label: isRunning ? "Queue message" : "Send", style: .filled, size: WeaveSize.innerControl) {
        if canSend { onSend() }
      }
      .disabled(!canSend)
      .keyboardShortcut(.return, modifiers: .command)
      .transition(.scale.combined(with: .opacity))
    }
  }
}

#Preview("Light") {
  ComposerBarPreview().weavePreview(.light)
}

#Preview("Dark") {
  ComposerBarPreview().weavePreview(.dark)
}

private struct ComposerBarPreview: View {
  @State private var empty = ""
  @State private var draft = "Ship the release after checks pass"
  @State private var long = "First line of a longer message\nSecond line\nThird line"

  var body: some View {
    VStack(spacing: WeaveSpacing.s6) {
      ComposerBar(text: $empty, onSend: {}, onAttach: {}, onMic: {})
      ComposerBar(text: $draft, onSend: {})
      ComposerBar(text: $empty, isRunning: true, onSend: {}, onStop: {}, onAttach: {})
      ComposerBar(text: $draft, isRunning: true, onSend: {}, onStop: {})
      ComposerBar(text: $long, onSend: {}, onAttach: {})
      ComposerBar(text: $empty, suggestion: "Run the tests and open a PR", onSend: {}, onAcceptSuggestion: { empty = $0 })
      ComposerBar(text: $empty, blockedReason: "M4 is offline. Messages send when it reconnects.", onSend: {})
    }
  }
}

/// A partial iris ring that turns around the stop button while a run is
/// working; with Reduce Motion it stays still.
private struct RunningRing: View {
  let diameter: CGFloat
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var turning = false

  var body: some View {
    Circle()
      .trim(from: 0, to: 0.28)
      .stroke(Color.weave.iris, style: StrokeStyle(lineWidth: 2, lineCap: .round))
      .frame(width: diameter, height: diameter)
      .rotationEffect(.degrees(turning ? 360 : 0))
      .animation(reduceMotion ? nil : .linear(duration: 1.1).repeatForever(autoreverses: false), value: turning)
      .onAppear { turning = true }
      .allowsHitTesting(false)
      .accessibilityHidden(true)
  }
}
