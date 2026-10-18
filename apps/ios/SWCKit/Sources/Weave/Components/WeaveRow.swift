import SwiftUI

/// A list or settings row: leading view, title, optional subtitle, trailing view
/// and an optional chevron. Rows have no chevron by default; settings rows that
/// push a screen pass `showsChevron: true`.
///
/// Titles and subtitles wrap. List previews pass line limits; at accessibility
/// text sizes those limits double so more of the text stays readable. Rows
/// with a text or menu value on the trailing edge pass `stacksTrailing`, and
/// at accessibility sizes that value moves under the title instead of being
/// squeezed beside it.
public struct WeaveRow<Leading: View, Trailing: View>: View {
  let title: String
  let subtitle: String?
  let titleLineLimit: Int?
  let subtitleLineLimit: Int?
  let showsChevron: Bool
  let isDestructive: Bool
  let insets: EdgeInsets
  let stacksTrailing: Bool
  let action: (() -> Void)?
  let leading: Leading
  let trailing: Trailing

  @Environment(\.dynamicTypeSize) private var dynamicTypeSize

  public init(
    _ title: String,
    subtitle: String? = nil,
    titleLineLimit: Int? = nil,
    subtitleLineLimit: Int? = nil,
    showsChevron: Bool = false,
    isDestructive: Bool = false,
    insets: EdgeInsets = WeaveRowInsets.standard,
    stacksTrailing: Bool = false,
    action: (() -> Void)? = nil,
    @ViewBuilder leading: () -> Leading,
    @ViewBuilder trailing: () -> Trailing
  ) {
    self.title = title
    self.subtitle = subtitle
    self.titleLineLimit = titleLineLimit
    self.subtitleLineLimit = subtitleLineLimit
    self.showsChevron = showsChevron
    self.isDestructive = isDestructive
    self.insets = insets
    self.stacksTrailing = stacksTrailing
    self.action = action
    self.leading = leading()
    self.trailing = trailing()
  }

  public var body: some View {
    if let action {
      Button(action: action) { row }
        .buttonStyle(WeaveRowButtonStyle())
    } else {
      row
    }
  }

  private var row: some View {
    let stacked = stacksTrailing && dynamicTypeSize.isAccessibilitySize
    let layout = stacked
      ? AnyLayout(VStackLayout(alignment: .leading, spacing: WeaveSpacing.s1))
      : AnyLayout(HStackLayout(spacing: WeaveSpacing.s3))
    return HStack(spacing: WeaveSpacing.s3) {
      leading
        .foregroundStyle(isDestructive ? Color.weave.fail : Color.weave.ink)
      layout {
        titles
        trailing
      }
      if showsChevron {
        Image(systemName: "chevron.right")
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(Color.weave.control)
          .accessibilityHidden(true)
      }
    }
    .padding(insets)
    .frame(minHeight: subtitle == nil ? 52 : 64)
    .contentShape(Rectangle())
    .accessibilityElement(children: .combine)
  }

  private var titles: some View {
    VStack(alignment: .leading, spacing: insets.top > WeaveRowInsets.standard.top ? 3 : 2) {
      Text(title)
        .font(.weave(.body))
        .foregroundStyle(isDestructive ? Color.weave.fail : Color.weave.ink)
        .lineLimit(scaled(titleLineLimit))
        .fixedSize(horizontal: false, vertical: titleLineLimit == nil)
      if let subtitle {
        Text(subtitle)
          .font(.weave(.callout))
          .foregroundStyle(Color.weave.muted)
          .lineLimit(scaled(subtitleLineLimit))
          .fixedSize(horizontal: false, vertical: subtitleLineLimit == nil)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private func scaled(_ limit: Int?) -> Int? {
    limit.map { dynamicTypeSize.isAccessibilitySize ? $0 * 2 : $0 }
  }
}

/// Padding inside a row.
public nonisolated enum WeaveRowInsets {
  /// Settings rows inside cards.
  public static let standard = EdgeInsets(top: 10, leading: WeaveSpacing.s4, bottom: 10, trailing: WeaveSpacing.s4)
  /// Full-width list rows, such as threads in an overview: more air, text at 24 pt.
  public static let list = EdgeInsets(top: 14, leading: WeaveSpacing.s6, bottom: 14, trailing: WeaveSpacing.s6)
}

/// The leading SF Symbol of a row, 22 pt in a fixed-width slot.
public struct WeaveRowSymbol: View {
  let systemName: String?
  let tint: Color?

  public init(_ systemName: String?, tint: Color? = nil) {
    self.systemName = systemName
    self.tint = tint
  }

  public var body: some View {
    if let systemName {
      Image(systemName: systemName)
        .font(.system(size: 19, weight: .regular))
        .foregroundStyle(tint ?? Color.weave.ink)
        .frame(width: 28)
        .accessibilityHidden(true)
    }
  }
}

/// Trailing secondary text of a row.
public struct WeaveRowTrailingText: View {
  let text: String?

  @Environment(\.dynamicTypeSize) private var dynamicTypeSize

  public init(_ text: String?) { self.text = text }

  public var body: some View {
    if let text {
      Text(text)
        .font(.weave(.body))
        .foregroundStyle(Color.weave.muted)
        .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1)
    }
  }
}

extension WeaveRow where Leading == WeaveRowSymbol, Trailing == WeaveRowTrailingText {
  public init(_ title: String, subtitle: String? = nil, symbol: String? = nil, symbolTint: Color? = nil, trailingText: String? = nil, showsChevron: Bool = false, isDestructive: Bool = false, action: (() -> Void)? = nil) {
    self.init(title, subtitle: subtitle, showsChevron: showsChevron, isDestructive: isDestructive, stacksTrailing: trailingText != nil, action: action) {
      WeaveRowSymbol(symbol, tint: isDestructive ? .weave.fail : symbolTint)
    } trailing: {
      WeaveRowTrailingText(trailingText)
    }
  }
}

/// A row with a switch on the trailing edge. The whole row toggles; the switch
/// only shows the state. VoiceOver reads one toggle with the subtitle as hint.
public struct WeaveToggleRow: View {
  let title: String
  let subtitle: String?
  let symbol: String?
  @Binding var isOn: Bool

  public init(_ title: String, subtitle: String? = nil, symbol: String? = nil, isOn: Binding<Bool>) {
    self.title = title
    self.subtitle = subtitle
    self.symbol = symbol
    self._isOn = isOn
  }

  public var body: some View {
    WeaveRow(title, subtitle: subtitle, action: { isOn.toggle() }) {
      WeaveRowSymbol(symbol)
    } trailing: {
      WeaveSwitchIndicator(isOn: isOn)
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(title)
    .accessibilityValue(isOn ? "On" : "Off")
    .accessibilityHint(subtitle ?? "")
    .accessibilityRemoveTraits(.isButton)
    .accessibilityAddTraits(.isToggle)
    .accessibilityAction { isOn.toggle() }
  }
}

/// The switch drawn on a toggle row, sized like the system switch. It only
/// shows the state: the row takes the taps and is the one element VoiceOver
/// and UI tests see. A system Toggle here would surface as a second, smaller
/// switch even when hidden from accessibility.
struct WeaveSwitchIndicator: View {
  let isOn: Bool

  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.isEnabled) private var isEnabled

  static let trackSize = CGSize(width: 63, height: 28)
  static let knobSize = CGSize(width: 37, height: 24)

  var body: some View {
    Capsule()
      .fill(isOn ? Color.weave.iris : Color.weave.line)
      .frame(width: Self.trackSize.width, height: Self.trackSize.height)
      .overlay(alignment: isOn ? .trailing : .leading) {
        Capsule()
          .fill(Color.white)
          .frame(width: Self.knobSize.width, height: Self.knobSize.height)
          .shadow(color: .black.opacity(0.12), radius: 2, y: 1)
          .padding(.horizontal, (Self.trackSize.height - Self.knobSize.height) / 2)
      }
      .opacity(isEnabled ? 1 : 0.5)
      .animation(reduceMotion ? nil : .snappy(duration: 0.2), value: isOn)
      .accessibilityHidden(true)
  }
}

/// Highlights a row while pressed, like a table cell.
struct WeaveRowButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .background(configuration.isPressed ? Color.weave.line.opacity(0.5) : Color.clear)
  }
}

#Preview("Light") {
  WeaveRowPreview().weavePreview(.light)
}

#Preview("Dark") {
  WeaveRowPreview().weavePreview(.dark)
}

private struct WeaveRowPreview: View {
  @State private var haptics = true

  var body: some View {
    VStack(spacing: WeaveSpacing.s6) {
      GroupedCard {
        WeaveRow("Machines", symbol: "laptopcomputer", trailingText: "3", showsChevron: true) {}
        WeaveRow("Default model", symbol: "cpu", trailingText: "Default", showsChevron: true) {}
        WeaveToggleRow("Haptic feedback", symbol: "hand.tap", isOn: $haptics)
      }
      GroupedCard {
        WeaveRow("Archive", symbol: "archivebox") {}
        WeaveRow("Delete project", symbol: "trash", isDestructive: true) {}
      }
      VStack(spacing: 0) {
        WeaveRow("Guided macOS permissions for computer use", subtitle: "58m", action: {}) {
          EmptyView()
        } trailing: {
          MachineBadge(status: .online)
        }
        WeaveRow("Release 3.0.24", subtitle: "PRs #355/#368/#369 open; merging each once checks pass") {
          EmptyView()
        } trailing: {
          MachineBadge(status: .offline)
        }
      }
    }
  }
}
