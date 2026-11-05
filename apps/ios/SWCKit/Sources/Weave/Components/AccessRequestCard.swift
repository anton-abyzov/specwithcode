import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// An agent asks to use apps, devices, machines or folders.
///
/// The `.composer` style is the quiet card that sits above the composer while
/// the request waits: a small blue shield and "Claude wants to use Notes" on
/// one left-aligned line, the agent's reason in muted text, one compact chip per
/// subject, one note line, then Deny, Allow for this session and a small
/// "Always allow on this machine" link on one row. The reason and
/// chips scroll when the card would pass `maxHeight`; the title and buttons
/// stay in view. The `.transcript` style is the one-line row the conversation
/// keeps, pending or answered. A request inherited from a forked thread shows
/// only a line, since it is answered in the thread that asked.
public struct AccessRequestCard: View {
  /// How long an Allow lasts.
  public enum Scope: String, Sendable, CaseIterable, Identifiable {
    case thread, machine
    public var id: String { rawValue }
    public var label: String {
      switch self {
      case .thread: "This thread"
      case .machine: "Always on this machine"
      }
    }
  }

  public enum Answer: Hashable, Sendable {
    case allow(Scope)
    case deny
  }

  public enum Style: Sendable {
    /// The full card above the composer.
    case composer
    /// A one-line row in the conversation.
    case transcript
  }

  /// Where an answered request ended.
  public enum Outcome: String, Sendable, CaseIterable {
    case allowedInThread, allowedOnMachine, denied, ended

    public var text: String {
      switch self {
      case .allowedInThread: "Allowed for this session"
      case .allowedOnMachine: "Allowed on this machine"
      case .denied: "Denied"
      case .ended: "Request ended"
      }
    }

    var symbol: String {
      switch self {
      case .allowedInThread, .allowedOnMachine: "checkmark.shield"
      case .denied: "xmark.shield"
      case .ended: "shield.slash"
      }
    }
  }

  /// The transcript row's chip while the request waits.
  public static let waitingText = "Waiting for your answer"
  /// The line for a request inherited from a forked thread while it waits.
  public static let waitingElsewhereText = "Waiting for an answer in the original thread"
  public static let allowTitle = "Allow for this session"
  public static let alwaysTitle = "Always allow on this machine"

  /// One thing the agent asks to use.
  public struct Subject: Identifiable {
    public let id: String
    let label: String
    let detail: String
    let hostLabel: String?
    let tag: String
    let symbol: String
    let icon: Image?

    /// - Parameters:
    ///   - kind: `app`, `device`, `machine` or `folder`; picks the fallback glyph.
    ///   - platform: `ios` or `android`, for a device.
    ///   - tag: The pill at the end of the chip, "All" today.
    ///   - iconPNG: The subject's own icon. Shown instead of the glyph when it decodes.
    public init(id: String, kind: String, label: String, detail: String, hostLabel: String? = nil, platform: String? = nil, tag: String = "All", iconPNG: Data? = nil) {
      self.id = id
      self.label = label
      self.detail = detail
      self.hostLabel = hostLabel
      self.tag = tag
      self.symbol = AccessRequestCard.symbol(kind: kind, platform: platform, label: label)
      self.icon = iconPNG.flatMap(AccessRequestCard.image(png:))
    }
  }

  let title: String
  let headline: String
  let reason: String
  let subjects: [Subject]
  let note: String
  let outcome: Outcome?
  let style: Style
  let isBusy: Bool
  let maxHeight: CGFloat?
  let waitingCount: Int
  let isElsewhere: Bool
  let onAnswer: (Answer) -> Void

  @State private var pendingAnswer: Answer?
  @Environment(\.colorScheme) private var colorScheme
  @ScaledMetric(relativeTo: .body) private var iconSize: CGFloat = 20
  @ScaledMetric(relativeTo: .body) private var buttonHeight: CGFloat = 34
  @ScaledMetric(relativeTo: .caption) private var badgeReserve: CGFloat = 56

  /// - Parameters:
  ///   - title: What is asked, e.g. "Use Notes"; the transcript row shows it.
  ///   - headline: "Claude wants to use Notes".
  ///   - reason: Why the agent asks.
  ///   - note: The one line saying what Allow lets the agent do.
  ///   - outcome: Nil while the request waits for an answer.
  ///   - isBusy: Disables the buttons while the answer is being sent.
  ///   - maxHeight: The tallest the composer card may be; the reason and chips scroll past it.
  ///   - waitingCount: How many requests wait in this chat, this one included. Above one the card says "1 of N".
  ///   - isElsewhere: Inherited from a forked thread; it can only be answered in the thread that asked.
  public init(title: String, headline: String, reason: String, subjects: [Subject], note: String, outcome: Outcome?, style: Style = .composer, isBusy: Bool = false, maxHeight: CGFloat? = nil, waitingCount: Int = 1, isElsewhere: Bool = false, onAnswer: @escaping (Answer) -> Void) {
    self.title = title
    self.headline = headline
    self.reason = reason
    self.subjects = subjects
    self.note = note
    self.outcome = outcome
    self.style = style
    self.isBusy = isBusy
    self.maxHeight = maxHeight
    self.waitingCount = waitingCount
    self.isElsewhere = isElsewhere
    self.onAnswer = onAnswer
  }

  public var body: some View {
    if let outcome {
      line(symbol: outcome.symbol, symbolColor: outcome == .denied ? Color.weave.fail : Color.weave.muted, chip: outcome.text, chipKind: outcome == .denied ? .fail : .neutral)
    } else if isElsewhere {
      elsewhereLine
    } else if style == .transcript {
      line(symbol: "hand.raised", symbolColor: Color.weave.warn, chip: Self.waitingText, chipKind: .warn)
    } else {
      pendingCard
    }
  }

  // MARK: Pending

  /// The tile's blue, the web card's accent.
  private var tileColor: Color {
    colorScheme == .dark
      ? Color(.sRGB, red: 0x4a / 255, green: 0x86 / 255, blue: 0xf0 / 255)
      : Color(.sRGB, red: 0x3b / 255, green: 0x78 / 255, blue: 0xe7 / 255)
  }

  /// "1 of 3" when other requests wait behind this one.
  public static func queueText(waitingCount: Int) -> String? {
    waitingCount > 1 ? "1 of \(waitingCount)" : nil
  }

  private static let topPadding = WeaveSpacing.s3
  private static let bottomPadding = WeaveSpacing.s3

  private var pendingCard: some View {
    CappedMiddleStack(
      spacing: WeaveSpacing.s2,
      maxHeight: maxHeight.map { $0 - Self.topPadding - Self.bottomPadding },
      minMiddle: 72
    ) {
      header
      // Measures the reason and chips at full height; never drawn.
      middle.hidden().accessibilityHidden(true)
      // Plain when the details fit, a scroll view when they are cut short.
      ViewThatFits(in: .vertical) {
        middle
        ScrollView(.vertical) { middle }
          .scrollBounceBehavior(.basedOnSize)
          .accessibilityIdentifier("access.details")
      }
      footer
    }
    .padding(.horizontal, WeaveSpacing.s3 + 2)
    .padding(.top, Self.topPadding)
    .padding(.bottom, Self.bottomPadding)
    .frame(maxWidth: .infinity, alignment: .leading)
    // The shadow sits on the card's shape only, so the text inside stays crisp.
    .background {
      RoundedRectangle(cornerRadius: WeaveRadius.lg + 2, style: .continuous)
        .fill(Color.weave.panel)
        .shadow(color: .black.opacity(0.05), radius: 10, y: 3)
    }
    .overlay(
      RoundedRectangle(cornerRadius: WeaveRadius.lg + 2, style: .continuous)
        .strokeBorder(Color.weave.line, lineWidth: 1)
    )
    .overlay(alignment: .topTrailing) { queueBadge }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("access.card")
    .onChange(of: isBusy) { _, busy in if !busy { pendingAnswer = nil } }
  }

  @ViewBuilder private var queueBadge: some View {
    if let text = Self.queueText(waitingCount: waitingCount) {
      Text(text)
        .font(.weave(.caption, weight: .semibold))
        .foregroundStyle(Color.weave.muted)
        .monospacedDigit()
        .padding(.horizontal, WeaveSpacing.s2)
        .padding(.vertical, 2)
        .background(Color.weave.sunken, in: Capsule())
        .padding(WeaveSpacing.s2 + 2)
        .accessibilityLabel("1 of \(waitingCount) access requests")
        .accessibilityHint("The next one shows after you answer this one")
        .accessibilityIdentifier("access.queue")
    }
  }

  private var header: some View {
    HStack(alignment: .firstTextBaseline, spacing: WeaveSpacing.s2) {
      Image(systemName: "shield.fill")
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(tileColor)
        .accessibilityHidden(true)
      Text(headline)
        .font(.weave(.callout, weight: .medium))
        .foregroundStyle(Color.weave.ink)
        .multilineTextAlignment(.leading)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityAddTraits(.isHeader)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    // Room for the "1 of N" badge at the top right.
    .padding(.trailing, waitingCount > 1 ? badgeReserve : 0)
  }

  /// The reason and the subject chips: the part that scrolls on a short screen.
  private var middle: some View {
    VStack(alignment: .leading, spacing: WeaveSpacing.s2) {
      if !reason.isEmpty {
        Text(reason)
          .weaveFont(.caption)
          .foregroundStyle(Color.weave.muted)
          .textSelection(.enabled)
          .fixedSize(horizontal: false, vertical: true)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
      VStack(spacing: WeaveSpacing.s1) {
        ForEach(subjects) { subjectChip($0) }
      }
    }
  }

  private var footer: some View {
    VStack(alignment: .leading, spacing: WeaveSpacing.s2) {
      if !note.isEmpty {
        Text(note)
          .weaveFont(.footnote)
          .foregroundStyle(Color.weave.muted)
          .fixedSize(horizontal: false, vertical: true)
      }
      // One left-aligned row; the link drops under the buttons when it does not fit.
      ViewThatFits(in: .horizontal) {
        HStack(spacing: WeaveSpacing.s2) {
          denyButton
          allowButton
          alwaysButton
          Spacer(minLength: 0)
        }
        VStack(alignment: .leading, spacing: 0) {
          HStack(spacing: WeaveSpacing.s2) {
            denyButton
            allowButton
            Spacer(minLength: 0)
          }
          alwaysButton
        }
        // Large type: one button per line.
        VStack(alignment: .leading, spacing: WeaveSpacing.s2) {
          allowButton
          denyButton
          alwaysButton
        }
      }
      .disabled(isBusy)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.top, 2)
    }
  }

  private var alwaysButton: some View {
    Button {
      send(.allow(.machine))
    } label: {
      HStack(spacing: WeaveSpacing.s1) {
        if isBusy, pendingAnswer == .allow(.machine) { ProgressView().controlSize(.mini) }
        Text(Self.alwaysTitle).lineLimit(2).minimumScaleFactor(0.85)
      }
      .font(.weave(.footnote, weight: .medium))
      .foregroundStyle(Color.weave.muted)
      .frame(minHeight: WeaveSize.minTap)
      .padding(.horizontal, WeaveSpacing.s1)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityHint("Allows it in every thread on this machine")
    .accessibilityIdentifier("access.allowMachine")
  }

  private func subjectChip(_ subject: Subject) -> some View {
    HStack(spacing: WeaveSpacing.s2 + 2) {
      subjectIcon(subject)
        .frame(width: iconSize, height: iconSize)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 1) {
        Text(subject.label)
          .font(.weave(.callout, weight: .medium))
          .foregroundStyle(Color.weave.ink)
          .lineLimit(2)
        if let host = subject.hostLabel {
          Text("on \(host)")
            .weaveFont(.caption)
            .foregroundStyle(Color.weave.muted)
            .lineLimit(1)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      Text(subject.tag)
        .font(.weave(.footnote, weight: .semibold))
        .foregroundStyle(Color.weave.warn)
        .padding(.horizontal, WeaveSpacing.s1 + 2)
        .padding(.vertical, 1)
        .background(Color.weave.warnTint, in: Capsule())
        .fixedSize()
    }
    .padding(.horizontal, WeaveSpacing.s2 + 2)
    .padding(.vertical, WeaveSpacing.s1 + 2)
    .background(Color.weave.sunken, in: RoundedRectangle(cornerRadius: WeaveRadius.md + 2, style: .continuous))
    .accessibilityElement(children: .combine)
    .accessibilityHint(subject.detail)
  }

  @ViewBuilder private func subjectIcon(_ subject: Subject) -> some View {
    if let icon = subject.icon {
      icon
        .resizable()
        .interpolation(.high)
        .aspectRatio(contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: iconSize * 0.22, style: .continuous))
    } else {
      Image(systemName: subject.symbol)
        .font(.system(size: iconSize * 0.7, weight: .regular))
        .foregroundStyle(Color.weave.ink)
    }
  }

  private var denyButton: some View {
    Button { send(.deny) } label: {
      pillLabel("Deny", loading: isBusy && pendingAnswer == .deny, foreground: Color.weave.ink)
        .background(Capsule().fill(Color.weave.panel))
        .overlay(Capsule().strokeBorder(Color.weave.control, lineWidth: 1))
        .modifier(TapArea(height: WeaveSize.minTap))
    }
    .buttonStyle(WeavePressStyle())
    .accessibilityIdentifier("access.deny")
  }

  private var allowButton: some View {
    Button { send(.allow(.thread)) } label: {
      pillLabel(Self.allowTitle, loading: isBusy && pendingAnswer == .allow(.thread), foreground: Color.weave.canvas)
        .background(Capsule().fill(Color.weave.ink))
        .modifier(TapArea(height: WeaveSize.minTap))
    }
    .buttonStyle(WeavePressStyle())
    .accessibilityHint("Allows it for this session")
    .accessibilityIdentifier("access.allowThread")
  }

  private func pillLabel(_ title: String, loading: Bool, foreground: Color) -> some View {
    HStack(spacing: WeaveSpacing.s2) {
      if loading { ProgressView().controlSize(.small).tint(foreground) }
      // Shrinks, then wraps, before large type overflows the card.
      Text(title).lineLimit(2).minimumScaleFactor(0.85).multilineTextAlignment(.center)
    }
    .font(.weave(.callout, weight: .medium))
    .foregroundStyle(foreground)
    .padding(.horizontal, WeaveSpacing.s3 + 2)
    .frame(minHeight: buttonHeight)
  }

  private func send(_ answer: Answer) {
    guard !isBusy else { return }
    pendingAnswer = answer
    onAnswer(answer)
  }

  // MARK: Transcript line

  /// "Waiting for an answer in the original thread: Use Notes", as the web client words it.
  private var elsewhereLine: some View {
    HStack(spacing: WeaveSpacing.s2) {
      Image(systemName: "shield")
        .font(.system(size: 14, weight: .medium))
        .foregroundStyle(Color.weave.muted)
        .accessibilityHidden(true)
      Text("\(Self.waitingElsewhereText): \(title)")
        .font(.weave(.callout, weight: .medium))
        .foregroundStyle(Color.weave.muted)
        .lineLimit(2)
        .truncationMode(.tail)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    .padding(.horizontal, WeaveSpacing.s3)
    .padding(.vertical, WeaveSpacing.s2)
    .frame(maxWidth: .infinity, minHeight: WeaveSize.minTap, alignment: .leading)
    .background(Color.weave.panel, in: RoundedRectangle(cornerRadius: WeaveRadius.card, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: WeaveRadius.card, style: .continuous)
        .strokeBorder(Color.weave.line, lineWidth: WeaveSize.hairline)
    )
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("access.elsewhere")
  }

  private func line(symbol: String, symbolColor: Color, chip: String, chipKind: StatusChip.Kind) -> some View {
    HStack(spacing: WeaveSpacing.s2) {
      Image(systemName: symbol)
        .font(.system(size: 14, weight: .medium))
        .foregroundStyle(symbolColor)
        .accessibilityHidden(true)
      Text(title)
        .font(.weave(.callout, weight: .medium))
        .foregroundStyle(Color.weave.muted)
        .lineLimit(1)
        .truncationMode(.tail)
      Spacer(minLength: WeaveSpacing.s2)
      StatusChip(chip, kind: chipKind)
        .layoutPriority(1)
    }
    .padding(.horizontal, WeaveSpacing.s3)
    .padding(.vertical, WeaveSpacing.s2)
    .frame(maxWidth: .infinity, minHeight: WeaveSize.minTap, alignment: .leading)
    .background(Color.weave.panel, in: RoundedRectangle(cornerRadius: WeaveRadius.card, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: WeaveRadius.card, style: .continuous)
        .strokeBorder(Color.weave.line, lineWidth: WeaveSize.hairline)
    )
    .accessibilityElement(children: .combine)
  }

  // MARK: Helpers

  /// The SF Symbol for a subject without its own icon.
  public nonisolated static func symbol(kind: String, platform: String?, label: String) -> String {
    switch kind {
    case "app": "app.dashed"
    case "device":
      switch platform {
      case "android": "smartphone"
      default: label.localizedCaseInsensitiveContains("ipad") ? "ipad" : "iphone"
      }
    case "machine": "desktopcomputer"
    case "folder": "folder"
    default: "questionmark.square.dashed"
    }
  }

  /// A SwiftUI image from PNG bytes, nil when they do not decode.
  nonisolated static func image(png: Data) -> Image? {
    #if canImport(UIKit)
    UIImage(data: png).map { Image(uiImage: $0) }
    #elseif canImport(AppKit)
    NSImage(data: png).map { Image(nsImage: $0) }
    #else
    nil
    #endif
  }
}

/// The pending card's column: a header, the details twice (a hidden copy that
/// measures their full height, then the copy that shows them, scrolling when
/// cut short) and a footer. The details get their full height, or what is left of `maxHeight`
/// after the header and footer (never under `minMiddle`), and scroll beyond it.
struct CappedMiddleStack: Layout {
  var spacing: CGFloat
  var maxHeight: CGFloat?
  var minMiddle: CGFloat

  private struct Heights { var header, middle, footer: CGFloat }

  private func heights(_ subviews: Subviews, width: CGFloat?) -> Heights {
    let proposal = ProposedViewSize(width: width, height: nil)
    let header = subviews[0].sizeThatFits(proposal).height
    let natural = subviews[1].sizeThatFits(proposal).height
    let footer = subviews[3].sizeThatFits(proposal).height
    var middle = natural
    if let maxHeight {
      let room = maxHeight - header - footer - spacing * 2
      middle = min(natural, max(minMiddle, room))
    }
    return Heights(header: header, middle: middle, footer: footer)
  }

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    guard subviews.count == 4 else { return .zero }
    let h = heights(subviews, width: proposal.width)
    let width = proposal.width ?? [0, 1, 3].map { subviews[$0].sizeThatFits(.unspecified).width }.max() ?? 0
    return CGSize(width: width, height: h.header + h.middle + h.footer + spacing * 2)
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    guard subviews.count == 4 else { return }
    let h = heights(subviews, width: bounds.width)
    var y = bounds.minY
    subviews[0].place(at: CGPoint(x: bounds.minX, y: y), proposal: .init(width: bounds.width, height: h.header))
    y += h.header + spacing
    // The measuring copy sits behind the scroll view, hidden, at no height.
    subviews[1].place(at: CGPoint(x: bounds.minX, y: y), proposal: .init(width: bounds.width, height: 0))
    subviews[2].place(at: CGPoint(x: bounds.minX, y: y), proposal: .init(width: bounds.width, height: h.middle))
    y += h.middle + spacing
    subviews[3].place(at: CGPoint(x: bounds.minX, y: y), proposal: .init(width: bounds.width, height: h.footer))
  }
}

/// Keeps a compact pill's look and extends its hit area to `height`.
private struct TapArea: ViewModifier {
  let height: CGFloat
  func body(content: Content) -> some View {
    content
      .frame(minHeight: height)
      .contentShape(Rectangle())
  }
}

#Preview("Composer light") {
  AccessRequestCardPreview.composer.weavePreview(.light)
}

#Preview("Composer dark") {
  AccessRequestCardPreview.composer.weavePreview(.dark)
}

#Preview("Phone width, two subjects") {
  AccessRequestCardPreview.mixedComposer.frame(width: 358).weavePreview(.light)
}

#Preview("Transcript lines light") {
  AccessRequestCardPreview.lines.weavePreview(.light)
}

#Preview("Transcript lines dark") {
  AccessRequestCardPreview.lines.weavePreview(.dark)
}

#Preview("Large type") {
  AccessRequestCardPreview.composer
    .weavePreview(.light)
    .environment(\.dynamicTypeSize, .accessibility2)
}

/// Sample cards for previews and rendered snapshots.
public enum AccessRequestCardPreview {
  /// A 1x1 iris PNG standing in for an app's icon.
  static let png = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==")

  static let subjects: [AccessRequestCard.Subject] = [
    .init(id: "app:notes", kind: "app", label: "Notes", detail: "See and control its windows", iconPNG: png),
  ]

  static let mixed: [AccessRequestCard.Subject] = [
    .init(id: "app:activity monitor", kind: "app", label: "Activity Monitor", detail: "See and control its windows"),
    .init(id: "device:iphone", kind: "device", label: "iPhone 17 Pro", detail: "Install and drive apps", hostLabel: "M1", platform: "ios"),
  ]

  public static var composer: some View {
    AccessRequestCard(
      title: "Use Notes",
      headline: "Claude wants to use Notes",
      reason: "Draft the launch post in Notes from the showcase captions.",
      subjects: subjects,
      note: "The agent can see your screen and click and type in these apps while it works.",
      outcome: nil
    ) { _ in }
  }

  public static var mixedComposer: some View {
    AccessRequestCard(
      title: "Use Activity Monitor and iPhone 17 Pro",
      headline: "Codex wants to use Activity Monitor and control iPhone 17 Pro",
      reason: "To see what keeps the Mac awake and check the fix on the phone.",
      subjects: mixed,
      note: "The agent can see your screen, click and type in these apps, and drive the device.",
      outcome: nil
    ) { _ in }
  }

  public static var lines: some View {
    VStack(spacing: WeaveSpacing.s3) {
      AccessRequestCard(title: "Use Notes", headline: "", reason: "", subjects: subjects, note: "", outcome: nil, style: .transcript) { _ in }
      ForEach(AccessRequestCard.Outcome.allCases, id: \.self) { outcome in
        AccessRequestCard(title: "Use Notes", headline: "", reason: "", subjects: subjects, note: "", outcome: outcome, style: .transcript) { _ in }
      }
    }
  }
}
