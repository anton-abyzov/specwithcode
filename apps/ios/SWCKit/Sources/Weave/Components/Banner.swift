import SwiftUI

/// Tone of an inline notice or toast.
public nonisolated enum WeaveNoticeKind: String, Sendable, CaseIterable {
  case info, pass, warn, fail

  var systemImage: String {
    switch self {
    case .info: "info.circle"
    case .pass: "checkmark.circle"
    case .warn: "exclamationmark.triangle"
    case .fail: "xmark.octagon"
    }
  }

  var foreground: Color {
    switch self {
    case .info: .weave.iris
    case .pass: .weave.pass
    case .warn: .weave.warn
    case .fail: .weave.fail
    }
  }

  var background: Color {
    switch self {
    case .info: .weave.irisTint
    case .pass: .weave.passTint
    case .warn: .weave.warnTint
    case .fail: .weave.failTint
    }
  }

  /// What VoiceOver says before a warning or an error, which color and glyph
  /// carry for sighted readers.
  public var spokenPrefix: String? {
    switch self {
    case .warn: "Warning"
    case .fail: "Error"
    case .info, .pass: nil
    }
  }

  /// How long a toast of this kind stays up. Errors stay longer so there is
  /// time to read them.
  public func toastDuration(_ base: Duration) -> Duration {
    self == .fail ? max(base, .seconds(6)) : base
  }

  /// Lines a toast of this kind may wrap to before it truncates.
  public var toastLineLimit: Int { self == .fail ? 5 : 2 }

  /// The text announced when a toast of this kind appears.
  public func announcement(for text: String) -> String {
    [spokenPrefix, text].compactMap(\.self).joined(separator: ": ")
  }
}

/// An inline notice: offline machine, stale data, a pairing that expires soon.
public struct Banner: View {
  let title: String?
  let message: String
  let kind: WeaveNoticeKind
  let actionTitle: String?
  let action: (() -> Void)?
  let onDismiss: (() -> Void)?

  public init(_ message: String, title: String? = nil, kind: WeaveNoticeKind = .info, actionTitle: String? = nil, action: (() -> Void)? = nil, onDismiss: (() -> Void)? = nil) {
    self.title = title
    self.message = message
    self.kind = kind
    self.actionTitle = actionTitle
    self.action = action
    self.onDismiss = onDismiss
  }

  public var body: some View {
    HStack(alignment: .top, spacing: WeaveSpacing.s3) {
      Image(systemName: kind.systemImage)
        .font(.system(size: 16, weight: .medium))
        .foregroundStyle(kind.foreground)
        .padding(.top, 2)
        .accessibilityLabel(kind.spokenPrefix ?? "")
        .accessibilityHidden(kind.spokenPrefix == nil)
      VStack(alignment: .leading, spacing: WeaveSpacing.s1) {
        if let title {
          Text(title)
            .font(.weave(.callout, weight: .semibold))
            .foregroundStyle(Color.weave.ink)
        }
        Text(message)
          .weaveFont(.callout)
          .foregroundStyle(Color.weave.ink)
          .fixedSize(horizontal: false, vertical: true)
        if let actionTitle, let action {
          Button(actionTitle, action: action)
            .font(.weave(.callout, weight: .semibold))
            .foregroundStyle(kind == .info ? Color.weave.irisStrong : kind.foreground)
            .buttonStyle(.plain)
            .frame(minHeight: WeaveSize.minTap)
            .contentShape(Rectangle())
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      if let onDismiss {
        Button(action: onDismiss) {
          Image(systemName: "xmark")
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(Color.weave.muted)
            .frame(width: WeaveSize.minTap, height: WeaveSize.minTap)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.top, -12)
        .padding(.trailing, -12)
        .accessibilityLabel("Dismiss")
      }
    }
    .padding(.horizontal, WeaveSpacing.s4)
    .padding(.vertical, WeaveSpacing.s3)
    .background(kind.background, in: RoundedRectangle(cornerRadius: WeaveRadius.lg, style: .continuous))
    .accessibilityElement(children: .combine)
  }
}

/// A transient message for `weaveToast(_:)`.
public struct WeaveToastMessage: Identifiable, Equatable, Sendable {
  public let id: UUID
  public var text: String
  public var kind: WeaveNoticeKind
  public var systemImage: String?

  public init(_ text: String, kind: WeaveNoticeKind = .info, systemImage: String? = nil) {
    self.id = UUID()
    self.text = text
    self.kind = kind
    self.systemImage = systemImage
  }
}

/// A short glass capsule message, for example "Copied" or "Saved".
public struct Toast: View {
  let message: WeaveToastMessage

  public init(_ message: WeaveToastMessage) { self.message = message }

  public init(_ text: String, kind: WeaveNoticeKind = .info, systemImage: String? = nil) {
    self.message = WeaveToastMessage(text, kind: kind, systemImage: systemImage)
  }

  public var body: some View {
    HStack(spacing: WeaveSpacing.s2) {
      Image(systemName: message.systemImage ?? message.kind.systemImage)
        .font(.system(size: 15, weight: .semibold))
        .foregroundStyle(message.kind.foreground)
        .accessibilityLabel(message.kind.spokenPrefix ?? "")
        .accessibilityHidden(message.kind.spokenPrefix == nil)
      Text(message.text)
        .font(.weave(.callout, weight: .medium))
        .foregroundStyle(Color.weave.ink)
        .lineLimit(message.kind.toastLineLimit)
    }
    .padding(.horizontal, WeaveSpacing.s4)
    .padding(.vertical, WeaveSpacing.s3)
    .weaveGlass(in: Capsule())
    .accessibilityElement(children: .combine)
  }
}

extension View {
  /// Shows `message` as a toast at the top and clears it after `duration`
  /// (at least 6 seconds for an error). Tapping it dismisses it.
  public func weaveToast(_ message: Binding<WeaveToastMessage?>, duration: Duration = .seconds(2.5)) -> some View {
    modifier(WeaveToastModifier(message: message, duration: duration))
  }
}

private struct WeaveToastModifier: ViewModifier {
  @Binding var message: WeaveToastMessage?
  let duration: Duration

  func body(content: Content) -> some View {
    content
      .overlay(alignment: .top) {
        if let current = message {
          Toast(current)
            .padding(.top, WeaveSpacing.s2)
            .padding(.horizontal, WeaveSpacing.gutter)
            .transition(.move(edge: .top).combined(with: .opacity))
            .onTapGesture { withAnimation { message = nil } }
            .task(id: current.id) {
              postAccessibilityAnnouncement(current.kind.announcement(for: current.text))
              try? await Task.sleep(for: current.kind.toastDuration(duration))
              guard !Task.isCancelled, message?.id == current.id else { return }
              withAnimation(.easeOut(duration: 0.25)) { message = nil }
            }
        }
      }
      .animation(.spring(response: 0.35, dampingFraction: 0.85), value: message?.id)
  }

  private func postAccessibilityAnnouncement(_ text: String) {
    var announcement = AttributedString(text)
    announcement.accessibilitySpeechAnnouncementPriority = .high
    AccessibilityNotification.Announcement(announcement).post()
  }
}

#Preview("Light") {
  NoticePreview().weavePreview(.light)
}

#Preview("Dark") {
  NoticePreview().weavePreview(.dark)
}

private struct NoticePreview: View {
  @State private var toast: WeaveToastMessage? = WeaveToastMessage("Copied", kind: .pass)

  var body: some View {
    VStack(spacing: WeaveSpacing.s4) {
      Banner("Showing saved data. Live updates resume when M4 reconnects.", kind: .info, onDismiss: {})
      Banner("This pairing expires in 3 days.", title: "Pair again soon", kind: .warn, actionTitle: "Pair again", action: {})
      Banner("The server rejected the message: thread not found.", kind: .fail)
      Toast("Saved", kind: .pass)
    }
    .weaveToast($toast)
  }
}
