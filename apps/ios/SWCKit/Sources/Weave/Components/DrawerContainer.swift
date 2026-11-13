import SwiftUI

/// A side drawer under the main content. Opening slides the content to the
/// right, shrinks it into a rounded card and dims it; tapping or swiping the
/// card closes the drawer. Opens from a button (set `isOpen`) or by swiping
/// from the leading edge. Under Reduce Motion the content stays put: the
/// drawer fades in over the dimmed content instead.
///
/// The edge swipe sits above the content, so turn it off while a pushed
/// screen needs the system back swipe: `edgeSwipeEnabled: path.isEmpty`.
/// The drawer reads `isNavigationSidebarVisible` to tell a persistent column
/// from the modal drawer.
///
/// From `WeaveSize.sidebarBreakpoint` points wide the drawer is a column
/// beside the content, whatever the size class: an unfolded or rotated iPhone
/// Duo can report a compact class at full width. `isCollapsed` hides that
/// column so the content takes the whole width; `isContentCollapsed` gives a
/// chat column the whole width instead; `isWideLayout` tells screens the
/// column exists, shown or not.
public struct DrawerContainer<Drawer: View, Content: View>: View {
  @Binding var isOpen: Bool
  @Binding var isCollapsed: Bool
  /// The column holds a conversation rather than a list, so it opens at half
  /// the scene, on the Duo's hinge, and may grow further.
  let isChatColumn: Bool
  /// The chat column takes the whole width and the content waits off screen,
  /// laid out at its usual size so it comes back unchanged.
  let isContentCollapsed: Bool
  let edgeSwipeEnabled: Bool
  let sceneInsets: EdgeInsets
  let drawer: Drawer
  let content: Content

  @State private var drag: CGFloat = 0
  @State private var dragging = false
  /// The column width the person dragged to; 0 follows the scene width.
  @AppStorage("swc.listColumnWidth") private var chosenListWidth: Double = 0
  @AppStorage("swc.chatColumnWidth") private var chosenChatWidth: Double = 0
  private var chosenWidth: Double {
    get { isChatColumn ? chosenChatWidth : chosenListWidth }
    nonmutating set {
      if isChatColumn { chosenChatWidth = newValue } else { chosenListWidth = newValue }
    }
  }
  /// How far the divider has moved in the drag in progress. Gesture state
  /// resets itself when the drag ends or is cancelled (a fold, a rotation, a
  /// system gesture), so a lost drag never leaves a stale width behind.
  @GestureState private var resizeDrag: CGFloat?
  private var resizing: Bool { resizeDrag != nil }
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.layoutDirection) private var layoutDirection

  public init(isOpen: Binding<Bool>, isCollapsed: Binding<Bool> = .constant(false), isChatColumn: Bool = false, isContentCollapsed: Bool = false, edgeSwipeEnabled: Bool = true, sceneInsets: EdgeInsets = EdgeInsets(), @ViewBuilder drawer: () -> Drawer, @ViewBuilder content: () -> Content) {
    self._isOpen = isOpen
    self._isCollapsed = isCollapsed
    self.isChatColumn = isChatColumn
    self.isContentCollapsed = isContentCollapsed
    self.edgeSwipeEnabled = edgeSwipeEnabled
    self.sceneInsets = sceneInsets
    self.drawer = drawer()
    self.content = content()
  }

  private var direction: CGFloat { layoutDirection == .rightToLeft ? -1 : 1 }

  private static var spring: Animation { .spring(response: 0.36, dampingFraction: 0.88) }

  /// Showing or hiding the wide column: a short, nearly critically damped
  /// spring, the sidebar motion desktop coding apps use.
  private var collapseAnimation: Animation { reduceMotion ? .easeInOut(duration: 0.2) : .spring(duration: 0.3, bounce: 0.1) }

  /// The spring, or a short fade under Reduce Motion.
  private var animation: Animation { reduceMotion ? .easeInOut(duration: 0.2) : Self.spring }

  public var body: some View {
    GeometryReader { proxy in
      // Width alone decides: Split View or mirroring narrows the scene below
      // the breakpoint, and the Duo reports compact classes at full width.
      let wide = proxy.size.width >= WeaveSize.sidebarBreakpoint
      let persistent = wide && !isCollapsed
      let columnOnly = persistent && isChatColumn && isContentCollapsed
      let split = persistent ? columnWidth(scene: proxy.size.width) : 0
      let width = columnOnly ? proxy.size.width : persistent ? split : min(max(proxy.size.width * 0.8, 1), 340)
      let modalOpen = isOpen && !persistent
      let progress: CGFloat = persistent ? 0 : progress(drawerWidth: width)
      ZStack(alignment: .leading) {
        if persistent || isOpen || dragging {
          drawer
            .environment(\.isNavigationSidebarVisible, persistent)
            .environment(\.isWideLayout, wide)
            .environment(\.layoutClass, WeaveLayoutClass(width: width))
            .environment(\.drawerHorizontalInsets, drawerInsets(width: width, scene: proxy.size.width))
            .safeAreaPadding(EdgeInsets(
              top: sceneInsets.top, leading: sceneInsets.leading,
              bottom: sceneInsets.bottom,
              trailing: drawerInsets(width: width, scene: proxy.size.width).trailing
            ))
            // The drawer takes only the insets computed here. On iPhone Duo
            // the system reports its rail as a trailing inset to every
            // UIKit-backed view, which narrowed the column by the rail's width.
            .ignoresSafeArea(.container, edges: .horizontal)
            .frame(width: width)
            .frame(maxHeight: .infinity)
            // Above the content under Reduce Motion, so it needs its own fill.
            .background(persistent || reduceMotion ? Color.weave.sunken : Color.clear)
            .shadow(color: .black.opacity(reduceMotion ? 0.14 * progress : 0), radius: 24, x: 4)
            .offset(x: persistent || reduceMotion ? 0 : (progress - 1) * width * 0.25)
            .opacity(persistent ? 1 : reduceMotion ? progress : 0.4 + 0.6 * progress)
            .allowsHitTesting(persistent || progress > 0.99)
            .accessibilityAction(.escape) { close() }
            // The wide column slides away whole when it collapses.
            .transition(wide && !reduceMotion ? .move(edge: .leading) : drawerTransition(drawerWidth: width))
            // Only the modal drawer fades in above the content. A column stays
            // below it so the divider's whole grab area takes touches.
            .zIndex(reduceMotion && !persistent ? 1 : 0)
        }

        ZStack {
          content
            .padding(EdgeInsets(
              top: sceneInsets.top,
              leading: max(0, sceneInsets.leading - (persistent ? split : 0)),
              bottom: sceneInsets.bottom, trailing: sceneInsets.trailing
            ))
            .background(Color.weave.canvas)
            .accessibilityHidden(modalOpen || columnOnly)
            .environment(\.isCoveredByDrawer, modalOpen)
            .environment(\.isNavigationSidebarVisible, persistent)
            .environment(\.isWideLayout, wide)
            .environment(\.layoutClass, WeaveLayoutClass(width: max(0, proxy.size.width - (persistent ? split : 0) - max(0, sceneInsets.leading - (persistent ? split : 0)) - sceneInsets.trailing)))
          // Keep the dismissal control outside the hidden content subtree.
          // Newer SwiftUI versions propagate that hidden state to overlays.
          dim(progress: progress, drawerWidth: width, active: modalOpen)
        }
          .frame(width: max(0, proxy.size.width - (persistent ? split : 0)), height: proxy.size.height)
          .clipShape(RoundedRectangle(cornerRadius: reduceMotion ? 0 : WeaveRadius.drawerContent * progress, style: .continuous))
          .shadow(color: .black.opacity(reduceMotion ? 0 : 0.14 * progress), radius: 24, x: -4)
          .scaleEffect(reduceMotion ? 1 : 1 - 0.06 * progress, anchor: .leading)
          .offset(x: persistent ? width : reduceMotion ? 0 : (width + 8) * progress)
          .allowsHitTesting(!columnOnly)
          .overlay(alignment: .leading) {
            if persistent, !columnOnly {
              // The content is moved by offset, which leaves its overlay at
              // the scene's leading edge, so the handle moves to the divider.
              ResizeHandle(
                active: resizing,
                adjust: { step in chosenWidth = Double(clampColumn(width + step, scene: proxy.size.width)) },
                reset: { withAnimation(collapseAnimation) { chosenWidth = 0 } }
              )
                .offset(x: width - ResizeHandle.width / 2)
                .gesture(resizeGesture(scene: proxy.size.width))
            }
            if edgeSwipeEnabled, !isOpen, !wide {
              Color.clear
                .frame(width: WeaveSpacing.gutter)
                .contentShape(Rectangle())
                .gesture(openGesture(drawerWidth: width))
                .accessibilityHidden(true)
            }
          }
      }
      .frame(width: proxy.size.width, height: proxy.size.height, alignment: .leading)
      .background(Color.weave.sunken.ignoresSafeArea())
      .animation(dragging ? nil : animation, value: isOpen)
      .animation(collapseAnimation, value: isCollapsed)
      .animation(collapseAnimation, value: isChatColumn && wide)
      .animation(collapseAnimation, value: isContentCollapsed)
      .transaction { if resizing { $0.animation = nil } }
      .onChange(of: isCollapsed) { _, _ in
        // Hiding the column must not reveal a modal drawer left open earlier.
        drag = 0
        dragging = false
        isOpen = false
      }
      .onChange(of: wide) { _, _ in
        // A fold can arrive in the middle of a swipe. Do not carry a stale
        // translation or an invisible modal cover into the new layout.
        drag = 0
        dragging = false
        isOpen = false
      }
    }
  }

  /// The scene's system regions that overlap the drawer, and nothing else:
  /// the drawer sits at the leading edge, so a trailing region only counts
  /// where the drawer reaches into it.
  private func drawerInsets(width: CGFloat, scene: CGFloat) -> EdgeInsets {
    EdgeInsets(top: 0, leading: sceneInsets.leading, bottom: 0, trailing: max(0, width - (scene - sceneInsets.trailing)))
  }

  /// Width bounds of the wide column: a list stays wide enough for project
  /// names and at most 45% of the scene; a chat may take up to 62%. Both always
  /// leave 340 points for the chat beside them.
  private var minColumn: CGFloat { isChatColumn ? 280 : 240 }
  private func maxColumn(scene: CGFloat) -> CGFloat {
    let limit = isChatColumn ? scene * 0.62 : min(440, scene * 0.45)
    return max(minColumn, min(limit, scene - 340 - sceneInsets.trailing))
  }

  private var savedWidth: CGFloat? { chosenWidth > 0 ? CGFloat(chosenWidth) : nil }

  private func clampColumn(_ wanted: CGFloat, scene: CGFloat) -> CGFloat {
    min(max(wanted, minColumn), maxColumn(scene: scene))
  }

  private func restingWidth(scene: CGFloat) -> CGFloat {
    savedWidth ?? (isChatColumn ? scene * 0.5 : min(max(scene * 0.42, 288), 420))
  }

  private func columnWidth(scene: CGFloat) -> CGFloat {
    clampColumn(clampColumn(restingWidth(scene: scene), scene: scene) + (resizeDrag ?? 0), scene: scene)
  }

  /// Drag the divider to resize the column; drag it well past the narrowest
  /// width to hide the column, as desktop sidebars do. Double tap resets.
  private func resizeGesture(scene: CGFloat) -> some Gesture {
    DragGesture(minimumDistance: 2, coordinateSpace: .global)
      .updating($resizeDrag) { value, state, _ in
        state = value.translation.width * direction
      }
      .onEnded { value in
        let target = clampColumn(restingWidth(scene: scene), scene: scene) + value.translation.width * direction
        if target < minColumn - 72 {
          withAnimation(collapseAnimation) { isCollapsed = true }
        } else {
          chosenWidth = Double(clampColumn(target, scene: scene))
        }
      }
  }

  /// The drawer leaves the tree once it is closed, so neither VoiceOver nor
  /// UI automation can reach it. Its transition matches the slide and fade
  /// it shows at the closed end of a drag.
  private func drawerTransition(drawerWidth: CGFloat) -> AnyTransition {
    reduceMotion ? .opacity : .offset(x: -drawerWidth * 0.25).combined(with: .opacity)
  }

  private func progress(drawerWidth: CGFloat) -> CGFloat {
    let base: CGFloat = isOpen ? drawerWidth : 0
    return min(max((base + drag) / drawerWidth, 0), 1)
  }

  /// Always mounted, so taking hit testing away is instant when `isOpen`
  /// flips. A layer removed through an animated transition keeps taking taps
  /// while it fades, which swallowed taps on the content right after closing.
  private func dim(progress: CGFloat, drawerWidth: CGFloat, active: Bool) -> some View {
    Color.black.opacity(0.12 * progress)
      .contentShape(Rectangle())
      .onTapGesture { close() }
      .gesture(closeGesture(drawerWidth: drawerWidth))
      .overlay {
        // The spoken control exists only while the drawer is open.
        if active {
          Button(action: close) {
            Color.clear.contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .accessibilityLabel("Close menu")
          .simultaneousGesture(closeGesture(drawerWidth: drawerWidth))
        }
      }
      // Include the overlay in the hit-testing decision. A zero-opacity
      // overlay host must never intercept the closed drawer's controls.
      .allowsHitTesting(active)
  }

  private func openGesture(drawerWidth: CGFloat) -> some Gesture {
    DragGesture(minimumDistance: 8, coordinateSpace: .global)
      .onChanged { value in
        dragging = true
        drag = max(0, min(value.translation.width * direction, drawerWidth))
      }
      .onEnded { value in
        let shouldOpen = value.predictedEndTranslation.width * direction > drawerWidth * 0.4
        withAnimation(animation) {
          dragging = false
          drag = 0
          isOpen = shouldOpen
        }
      }
  }

  private func closeGesture(drawerWidth: CGFloat) -> some Gesture {
    DragGesture(minimumDistance: 8, coordinateSpace: .global)
      .onChanged { value in
        dragging = true
        drag = min(0, max(value.translation.width * direction, -drawerWidth))
      }
      .onEnded { value in
        let shouldClose = value.predictedEndTranslation.width * direction < -drawerWidth * 0.3
        withAnimation(animation) {
          dragging = false
          drag = 0
          if shouldClose { isOpen = false }
        }
      }
  }

  private func close() {
    withAnimation(animation) { isOpen = false }
  }
}

private nonisolated struct NavigationSidebarVisibleKey: EnvironmentKey {
  static let defaultValue = false
}

private nonisolated struct CoveredByDrawerKey: EnvironmentKey {
  static let defaultValue = false
}

private nonisolated struct WideLayoutKey: EnvironmentKey {
  static let defaultValue = false
}

private nonisolated struct DrawerHorizontalInsetsKey: EnvironmentKey {
  static let defaultValue: EdgeInsets? = nil
}

extension EnvironmentValues {
  /// Navigation is already visible beside the detail; a menu button is redundant.
  public nonisolated var isNavigationSidebarVisible: Bool {
    get { self[NavigationSidebarVisibleKey.self] }
    set { self[NavigationSidebarVisibleKey.self] = newValue }
  }

  /// The scene is wide enough for a navigation column, shown or collapsed.
  public nonisolated var isWideLayout: Bool {
    get { self[WideLayoutKey.self] }
    set { self[WideLayoutKey.self] = newValue }
  }

  /// The leading and trailing insets the drawer really overlaps, set only
  /// inside a drawer. `fillsDrawerWidth()` reads it.
  public nonisolated var drawerHorizontalInsets: EdgeInsets? {
    get { self[DrawerHorizontalInsetsKey.self] }
    set { self[DrawerHorizontalInsetsKey.self] = newValue }
  }

  /// True while an open drawer covers this content.
  public nonisolated var isCoveredByDrawer: Bool {
    get { self[CoveredByDrawerKey.self] }
    set { self[CoveredByDrawerKey.self] = newValue }
  }
}

extension View {
  /// Lays a screen hosted inside the drawer, such as the root of a navigation
  /// stack, across the drawer's whole width. A stack hosts its screens in
  /// UIKit, which hands them the window's horizontal insets wherever the
  /// drawer sits. On iPhone Duo that is the status rail at the far edge, and
  /// it left an empty strip of the rail's width beside the sidebar. This
  /// drops those insets and applies only the ones the drawer overlaps.
  public func fillsDrawerWidth() -> some View {
    modifier(FillsDrawerWidth())
  }

  /// Hides this screen from VoiceOver while an open drawer covers it. A
  /// navigation stack hosts its screens apart from the views around it, so
  /// hiding the drawer's content does not reach them: each screen root takes
  /// this modifier.
  public func hiddenUnderDrawer() -> some View {
    modifier(HiddenUnderDrawer())
  }

  /// Gives an edge bar no accessibility elements at all while an open drawer
  /// covers it. Edge bars are hosted apart from their screen, and plain
  /// hiding leaves their controls in the tree UI automation reads. The bar is
  /// rebuilt when the drawer opens or closes, so use it only on views whose
  /// state lives elsewhere.
  public func silentUnderDrawer() -> some View {
    modifier(SilentUnderDrawer())
  }
}

private struct FillsDrawerWidth: ViewModifier {
  @Environment(\.drawerHorizontalInsets) private var insets

  func body(content: Content) -> some View {
    if let insets {
      content
        .safeAreaPadding(.leading, insets.leading)
        .safeAreaPadding(.trailing, insets.trailing)
        .ignoresSafeArea(.container, edges: .horizontal)
    } else {
      content
    }
  }
}

private struct HiddenUnderDrawer: ViewModifier {
  @Environment(\.isCoveredByDrawer) private var covered

  func body(content: Content) -> some View {
    content.accessibilityHidden(covered)
  }
}

private struct SilentUnderDrawer: ViewModifier {
  @Environment(\.isCoveredByDrawer) private var covered

  func body(content: Content) -> some View {
    if covered {
      content
        .accessibilityRepresentation { EmptyView() }
        .transition(.identity)
    } else {
      content.transition(.identity)
    }
  }
}

#Preview("Light") {
  DrawerContainerPreview().environment(\.colorScheme, .light)
}

#Preview("Dark") {
  DrawerContainerPreview().environment(\.colorScheme, .dark)
}

private struct DrawerContainerPreview: View {
  @State private var open = true

  var body: some View {
    DrawerContainer(isOpen: $open) {
      VStack(alignment: .leading, spacing: 0) {
        Text("SpecWithCode")
          .weaveFont(.title)
          .padding(.horizontal, WeaveSpacing.gutter)
          .padding(.vertical, WeaveSpacing.s4)
        SectionHeader("Pinned").padding(.horizontal, WeaveSpacing.gutter)
        WeaveRow("Percy", action: { open = false }) {
          ProjectAvatar(icon: .lucide(name: "concierge-bell", tint: "violet"), title: "Percy", size: 24, style: .plain)
        } trailing: {
          StatusDot(.working)
        }
        WeaveRow("specweave", action: { open = false }) {
          ProjectAvatar(icon: .lucide(name: "dna", tint: "amber"), title: "specweave", size: 24, style: .plain)
        } trailing: {
          EmptyView()
        }
        Spacer()
      }
      .foregroundStyle(Color.weave.ink)
    } content: {
      VStack {
        HStack {
          WeaveIconButton("line.3.horizontal", label: "Menu") { open.toggle() }
          Spacer()
          TitleCapsule(title: "Percy")
          Spacer()
          WeaveIconButton("checklist", label: "Overview") {}
        }
        .padding(.horizontal, WeaveSpacing.gutter)
        Spacer()
        MarkdownText("Good morning. Two threads need you.")
          .padding(.horizontal, WeaveSpacing.contentInset)
        Spacer()
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .background(Color.weave.canvas)
    }
  }
}

/// The divider between the wide column and the content: a wide invisible
/// grab area with a short grip that shows while dragging.
private struct ResizeHandle: View {
  static let width: CGFloat = 16
  let active: Bool
  let adjust: (CGFloat) -> Void
  let reset: () -> Void

  var body: some View {
    ZStack {
      Rectangle()
        .fill(Color.weave.line)
        .frame(width: WeaveSize.hairline)
      Capsule()
        .fill(active ? Color.weave.iris : Color.weave.muted.opacity(0.35))
        .frame(width: active ? 4 : 3, height: 36)
        .animation(.easeOut(duration: 0.15), value: active)
    }
    .frame(width: Self.width)
    .frame(maxHeight: .infinity)
    .contentShape(Rectangle())
    .onTapGesture(count: 2, perform: reset)
    .accessibilityElement()
    .accessibilityLabel("Sidebar width")
    .accessibilityHint("Swipe up or down to resize.")
    .accessibilityAdjustableAction { direction in
      switch direction {
      case .increment: adjust(24)
      case .decrement: adjust(-24)
      @unknown default: break
      }
    }
    .accessibilityAction(named: "Reset width", reset)
    .accessibilityIdentifier("sidebar.resize")
  }
}
