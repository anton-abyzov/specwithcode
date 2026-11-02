import SwiftUI
import Weave

/// A floating header: leading and trailing controls with a title between them.
///
/// `.center` gives both sides the same width so the title stays centered.
/// `.leading` lets the title take all the width the controls leave, starting
/// right after the leading control, for long titles such as thread names.
/// Text in the header grows with Dynamic Type only up to a compact limit; the
/// buttons show the large content viewer instead.
struct ScreenHeader<Leading: View, Center: View, Trailing: View>: View {
  enum TitleAlignment { case center, leading }

  let alignment: TitleAlignment
  let leading: Leading
  let center: Center
  let trailing: Trailing

  init(alignment: TitleAlignment = .center, @ViewBuilder leading: () -> Leading, @ViewBuilder center: () -> Center, @ViewBuilder trailing: () -> Trailing) {
    self.alignment = alignment
    self.leading = leading()
    self.center = center()
    self.trailing = trailing()
  }

  var body: some View {
    Group {
      switch alignment {
      case .center: centered
      case .leading: leadingAligned
      }
    }
    .frame(minHeight: WeaveSize.control)
    .dynamicTypeSize(...DynamicTypeSize.xxLarge)
  }

  private var centered: some View {
    CenteredHeaderLayout(spacing: WeaveSpacing.s2) {
      leading.fixedSize()
      center
      trailing.fixedSize()
    }
  }

  private var leadingAligned: some View {
    HStack(spacing: WeaveSpacing.s2) {
      leading.fixedSize()
      center.frame(maxWidth: .infinity, alignment: .leading)
      trailing.fixedSize()
    }
  }
}

/// Leading control, title, trailing control. The controls keep their natural
/// widths and the title takes what is left, centered on the header when that
/// leaves it room. The header never asks for more than it was offered: a wider
/// answer would widen the whole screen, which then overflows on both sides.
/// That is what the iPhone Duo's status rail did to the folded display.
struct CenteredHeaderLayout: Layout {
  var spacing: CGFloat

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    guard subviews.count == 3 else { return .zero }
    let sides = subviews[0].sizeThatFits(.unspecified).width + subviews[2].sizeThatFits(.unspecified).width + 2 * spacing
    let title = subviews[1].sizeThatFits(ProposedViewSize(width: proposal.width.map { max(0, $0 - sides) }, height: proposal.height))
    let height = max(subviews[0].sizeThatFits(.unspecified).height, title.height, subviews[2].sizeThatFits(.unspecified).height)
    return CGSize(width: proposal.width ?? (sides + title.width), height: height)
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    guard subviews.count == 3 else { return }
    let leading = subviews[0].sizeThatFits(.unspecified)
    let trailing = subviews[2].sizeThatFits(.unspecified)
    let room = max(0, bounds.width - leading.width - trailing.width - 2 * spacing)
    let title = subviews[1].sizeThatFits(ProposedViewSize(width: room, height: bounds.height))
    let earliest = bounds.minX + leading.width + spacing
    let latest = bounds.maxX - trailing.width - spacing - title.width
    let x = min(max(bounds.midX - title.width / 2, earliest), max(earliest, latest))
    subviews[0].place(at: CGPoint(x: bounds.minX, y: bounds.midY), anchor: .leading, proposal: .unspecified)
    subviews[1].place(at: CGPoint(x: x, y: bounds.midY), anchor: .leading, proposal: ProposedViewSize(width: room, height: bounds.height))
    subviews[2].place(at: CGPoint(x: bounds.maxX, y: bounds.midY), anchor: .trailing, proposal: .unspecified)
  }
}

/// A plain centered header title with an optional second line.
struct HeaderTitle: View {
  let title: String
  var subtitle: String?

  var body: some View {
    VStack(spacing: 0) {
      Text(title)
        .font(.weave(.headline))
        .foregroundStyle(Color.weave.ink)
      if let subtitle {
        Text(subtitle)
          .font(.weave(.footnote))
          .foregroundStyle(Color.weave.muted)
      }
    }
    .lineLimit(1)
    .multilineTextAlignment(.center)
    .accessibilityElement(children: .combine)
    .accessibilityAddTraits(.isHeader)
  }
}

extension View {
  /// Canvas background under the status bar, a floating header that content
  /// scrolls beneath, and no system navigation bar.
  func screenChrome<Header: View>(@ViewBuilder header: () -> Header) -> some View {
    modifier(ScreenChrome(header: header()))
  }

  /// Canvas background that reaches under the status bar and home indicator.
  func screenBackground() -> some View {
    self
      .background(Color.weave.canvas.ignoresSafeArea())
      .hideNavigationBar()
  }

  @ViewBuilder func hideNavigationBar() -> some View {
    #if os(iOS)
    self.toolbar(.hidden, for: .navigationBar)
    #else
    self
    #endif
  }

  /// Keyboard settings for links and codes: no capitalization or correction.
  @ViewBuilder func linkInput() -> some View {
    #if os(iOS)
    self
      .textInputAutocapitalization(.never)
      .autocorrectionDisabled()
      .keyboardType(.URL)
      .textContentType(.URL)
    #else
    self.autocorrectionDisabled()
    #endif
  }

  /// Keyboard settings for a person's name for a device.
  @ViewBuilder func nameInput() -> some View {
    #if os(iOS)
    self
      .textInputAutocapitalization(.words)
      .autocorrectionDisabled()
    #else
    self.autocorrectionDisabled()
    #endif
  }

  /// A sheet with the Weave sheet corners and canvas background.
  func weaveSheetStyle(appearance: String, detents: Set<PresentationDetent> = [.large]) -> some View {
    self
      .weaveTheme(appearance: appearance)
      .presentationDetents(detents)
      .presentationCornerRadius(WeaveRadius.sheet)
      .presentationBackground(Color.weave.canvas)
      .presentationDragIndicator(.hidden)
      .environment(\.headerTopPadding, WeaveSpacing.s4)
  }
}

private struct ScreenChrome<Header: View>: ViewModifier {
  let header: Header
  @Environment(\.headerTopPadding) private var topPadding

  func body(content: Content) -> some View {
    content
      .edgeBar(.top) {
        header
          .padding(.horizontal, WeaveSpacing.gutter)
          .padding(.top, topPadding)
          .padding(.bottom, WeaveSpacing.s3)
      }
      .screenBackground()
  }
}

extension View {
  /// Pins a bar to the top or bottom edge. Scroll content starts clear of the
  /// bar and fades out under it: the canvas stays solid behind the controls
  /// and fades over a short band past the bar, and on iOS 26 the soft scroll
  /// edge effect blurs what passes beneath. Nothing reads through the gaps
  /// between the controls.
  @ViewBuilder func edgeBar<Bar: View>(_ edge: VerticalEdge, @ViewBuilder bar: () -> Bar) -> some View {
    if #available(iOS 26.0, macOS 26.0, *) {
      self
        .safeAreaBar(edge: edge, spacing: 0) { bar().background { EdgeFade(edge: edge) }.silentUnderDrawer() }
        .scrollEdgeEffectStyle(.soft, for: edge == .top ? .top : .bottom)
    } else {
      self.safeAreaInset(edge: edge, spacing: 0) { bar().background { EdgeFade(edge: edge) }.silentUnderDrawer() }
    }
  }
}

/// The canvas behind an edge bar: solid from the screen edge to `inset`
/// points short of the bar's inner edge, then fading to clear `fade` points
/// past it. The header fades well into the content; the composer fades only
/// within the transcript's bottom padding, so the last message stays clear.
private struct EdgeFade: View {
  let edge: VerticalEdge

  private var inset: CGFloat { edge == .top ? WeaveSpacing.s3 : WeaveSpacing.s2 }
  private var fade: CGFloat { edge == .top ? WeaveSpacing.s4 : WeaveSpacing.s2 }

  var body: some View {
    GeometryReader { proxy in
      let total = proxy.size.height + fade
      let solid = max(0, proxy.size.height - inset) / total
      LinearGradient(
        stops: [
          .init(color: Color.weave.canvas, location: 0),
          .init(color: Color.weave.canvas, location: solid),
          .init(color: Color.weave.canvas.opacity(0), location: 1),
        ],
        startPoint: edge == .top ? .top : .bottom,
        endPoint: edge == .top ? .bottom : .top
      )
      .frame(height: total)
      .offset(y: edge == .top ? 0 : -fade)
    }
    .ignoresSafeArea(edges: edge == .top ? .top : .bottom)
    .allowsHitTesting(false)
    .accessibilityHidden(true)
  }
}

private nonisolated struct HeaderTopPaddingKey: EnvironmentKey {
  static let defaultValue: CGFloat = WeaveSpacing.s1
}

extension EnvironmentValues {
  /// Space above screen headers. Sheets use more, since nothing sits above them.
  nonisolated var headerTopPadding: CGFloat {
    get { self[HeaderTopPaddingKey.self] }
    set { self[HeaderTopPaddingKey.self] = newValue }
  }
}

/// Press feedback for custom buttons: a slight shrink and fade.
struct PressableStyle: ButtonStyle {
  var scale: CGFloat = 0.96

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .scaleEffect(configuration.isPressed ? scale : 1)
      .opacity(configuration.isPressed ? 0.8 : 1)
      .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
  }
}

/// Back and menu buttons for headers.
struct BackButton: View {
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    WeaveIconButton("chevron.left", label: "Back") { dismiss() }
  }
}

struct CloseButton: View {
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    WeaveIconButton("xmark", label: "Close") { dismiss() }
  }
}

struct MenuButton: View {
  @Environment(\.isNavigationSidebarVisible) private var sidebarVisible
  @Environment(\.isWideLayout) private var wide
  @Environment(AppRouter.self) private var router

  var body: some View {
    if sidebarVisible {
      // Reserve the header spacing while removing the redundant control.
      Color.clear.frame(width: WeaveSize.minTap, height: WeaveSize.minTap)
        .accessibilityHidden(true)
    } else if wide {
      // The column is collapsed: bring it back rather than cover the chat.
      WeaveIconButton("sidebar.left", label: "Show sidebar") { router.isSidebarCollapsed = false }
        .accessibilityIdentifier("chrome.show-sidebar")
    } else {
      WeaveIconButton("line.3.horizontal", label: "Menu") { router.isDrawerOpen = true }
    }
  }
}

/// A small filled dot that marks unread items. Always paired with a spoken value.
struct UnreadDot: View {
  var body: some View {
    Circle()
      .fill(Color.weave.iris)
      .frame(width: 8, height: 8)
      .accessibilityHidden(true)
  }
}
