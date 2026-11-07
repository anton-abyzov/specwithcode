import SwiftUI

/// A subtitle that does something of its own, such as a thread's "Thread in
/// specweave" opening the project's coordinator.
public struct TitleCapsuleLink {
  let hint: String
  let identifier: String
  let action: () -> Void

  public init(hint: String, identifier: String, action: @escaping () -> Void) {
    self.hint = hint
    self.identifier = identifier
    self.action = action
  }
}

/// The header title: a 44 pt glass capsule with an optional icon tile, a title
/// and an optional subtitle. With an action it is a button. A subtitle with a
/// glyph says what kind of chat this is; with a link it is its own button.
public struct TitleCapsule<Icon: View>: View {
  let title: String
  let subtitle: String?
  /// Shown in place of the subtitle when it does not fit on one line.
  var compactSubtitle: String?
  let action: (() -> Void)?
  let icon: Icon
  /// Text only, without the glass: for a wide thread, whose title sits on the transcript.
  var isPlain = false
  var subtitleSymbol: String?
  var subtitleLink: TitleCapsuleLink?
  var hint: String?

  public init(
    title: String,
    subtitle: String? = nil,
    compactSubtitle: String? = nil,
    subtitleSymbol: String? = nil,
    subtitleLink: TitleCapsuleLink? = nil,
    isPlain: Bool = false,
    hint: String? = nil,
    action: (() -> Void)? = nil,
    @ViewBuilder icon: () -> Icon
  ) {
    self.title = title
    self.subtitle = subtitle
    self.compactSubtitle = compactSubtitle == subtitle ? nil : compactSubtitle
    self.subtitleSymbol = subtitleSymbol
    self.subtitleLink = subtitle == nil ? nil : subtitleLink
    self.isPlain = isPlain
    self.hint = hint
    self.action = action
    self.icon = icon()
  }

  public var body: some View {
    if let subtitleLink, let subtitle {
      split(subtitle: subtitle, link: subtitleLink)
    } else {
      whole
    }
  }

  /// One button for the whole capsule.
  private var whole: some View {
    Group {
      if let action {
        Button(action: action) { frame(HStack(spacing: WeaveSpacing.s2) { icon; lines }) }
          .buttonStyle(WeavePressStyle())
      } else {
        frame(HStack(spacing: WeaveSpacing.s2) { icon; lines })
      }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(subtitle.map { "\(title), \($0)" } ?? title)
    .accessibilityHint(hint ?? "")
    .accessibilityAddTraits(action == nil ? .isHeader : [.isHeader, .isButton])
    .accessibilityShowsLargeContentViewer { Text(title) }
  }

  /// The title and the subtitle are two buttons, each with its own target.
  private func split(subtitle: String, link: TitleCapsuleLink) -> some View {
    frame(
      HStack(spacing: WeaveSpacing.s2) {
        icon.accessibilityHidden(true)
        VStack(alignment: .leading, spacing: 0) {
          Button(action: action ?? {}) {
            titleText.frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
          }
          .buttonStyle(WeavePressStyle())
          .disabled(action == nil)
          .accessibilityLabel(title)
          .accessibilityHint(hint ?? "")
          .accessibilityAddTraits(.isHeader)
          .accessibilityShowsLargeContentViewer { Text(title) }
          Button(action: link.action) {
            subtitleRow(subtitle, linked: true)
              .frame(maxWidth: .infinity, alignment: .leading)
              // Reaches down to the capsule's edge, so the short line is easier to hit.
              .padding(.bottom, 4)
              .contentShape(Rectangle())
          }
          .buttonStyle(WeavePressStyle())
          .padding(.bottom, -4)
          .accessibilityLabel(subtitle)
          .accessibilityHint(link.hint)
          .accessibilityIdentifier(link.identifier)
          .accessibilityShowsLargeContentViewer { Text(subtitle) }
        }
        .lineLimit(1)
        .truncationMode(.tail)
      }
    )
    .accessibilityElement(children: .contain)
  }

  private var lines: some View {
    VStack(alignment: .leading, spacing: 0) {
      titleText
      if let subtitle { subtitleRow(subtitle, linked: false) }
    }
    .lineLimit(1)
    .truncationMode(.tail)
  }

  private var titleText: some View {
    Text(title)
      .font(.weave(subtitle == nil ? .headline : .callout, weight: .semibold))
      .foregroundStyle(Color.weave.ink)
  }

  private func subtitleRow(_ subtitle: String, linked: Bool) -> some View {
    HStack(spacing: 4) {
      if let subtitleSymbol {
        Image(systemName: subtitleSymbol)
          .font(.system(size: 11, weight: .semibold))
          .foregroundStyle(linked ? Color.weave.iris : Color.weave.muted)
          .accessibilityHidden(true)
      }
      subtitleText(subtitle, linked: linked)
      if linked {
        Image(systemName: "chevron.forward")
          .font(.system(size: 9, weight: .bold))
          .foregroundStyle(Color.weave.muted.opacity(0.7))
          .accessibilityHidden(true)
      }
    }
  }

  /// The full line when it fits, else the short one, which truncates last.
  @ViewBuilder private func subtitleText(_ subtitle: String, linked: Bool) -> some View {
    let font = Font.weave(.footnote, weight: linked ? .medium : .regular)
    if let compactSubtitle {
      ViewThatFits(in: .horizontal) {
        Text(subtitle).fixedSize(horizontal: true, vertical: false)
        Text(compactSubtitle)
      }
      .font(font)
      .foregroundStyle(Color.weave.muted)
    } else {
      Text(subtitle).font(font).foregroundStyle(Color.weave.muted)
    }
  }

  private func frame(_ content: some View) -> some View {
    content
      .padding(.leading, isPlain ? 0 : Icon.self == EmptyView.self ? 14 : WeaveSpacing.s2)
      .padding(.trailing, isPlain ? 0 : 14)
      .frame(minHeight: WeaveSize.control)
      .plainOrGlass(isPlain, interactive: action != nil && subtitleLink == nil)
      .contentShape(Rectangle())
  }
}

extension TitleCapsule where Icon == EmptyView {
  public init(
    title: String,
    subtitle: String? = nil,
    compactSubtitle: String? = nil,
    subtitleSymbol: String? = nil,
    subtitleLink: TitleCapsuleLink? = nil,
    isPlain: Bool = false,
    hint: String? = nil,
    action: (() -> Void)? = nil
  ) {
    self.init(title: title, subtitle: subtitle, compactSubtitle: compactSubtitle, subtitleSymbol: subtitleSymbol, subtitleLink: subtitleLink, isPlain: isPlain, hint: hint, action: action) { EmptyView() }
  }
}

extension View {
  @ViewBuilder fileprivate func plainOrGlass(_ isPlain: Bool, interactive: Bool) -> some View {
    if isPlain { self } else { weaveGlass(in: Capsule(), interactive: interactive) }
  }
}

#Preview("Light") {
  TitleCapsulePreview().weavePreview(.light)
}

#Preview("Dark") {
  TitleCapsulePreview().weavePreview(.dark)
}

private struct TitleCapsulePreview: View {
  var body: some View {
    VStack(spacing: WeaveSpacing.s4) {
      TitleCapsule(title: "specweave", action: {}) {
        ProjectAvatar(icon: .lucide(name: "dna", tint: "amber"), title: "specweave", size: WeaveSize.titleTile)
      }
      TitleCapsule(title: "Guided macOS permissions for computer use", subtitle: "Thread · 1 artifact", action: {})
        .frame(maxWidth: 220)
      TitleCapsule(title: "specweave", subtitle: "Coordinator · m4", subtitleSymbol: "point.3.filled.connected.trianglepath.dotted", action: {})
      TitleCapsule(
        title: "Land all open PRs, then release",
        subtitle: "Thread in specweave",
        compactSubtitle: "In specweave",
        subtitleSymbol: "text.bubble",
        subtitleLink: TitleCapsuleLink(hint: "Opens the specweave coordinator", identifier: "chat.kind") {},
        action: {}
      )
      TitleCapsule(title: "Overview")
    }
  }
}
