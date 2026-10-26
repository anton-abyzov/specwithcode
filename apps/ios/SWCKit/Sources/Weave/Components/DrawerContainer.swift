import SwiftUI

/// A side drawer under the main content. Opening slides the content to the
/// right, shrinks it into a rounded card and dims it; tapping or swiping the
/// card closes the drawer. Opens from a button (set `isOpen`) or by swiping
/// from the leading edge. Under Reduce Motion the content stays put: the
/// drawer fades in over the dimmed content instead.
///
/// The edge swipe sits above the content, so turn it off while a pushed
/// screen needs the system back swipe: `edgeSwipeEnabled: path.isEmpty`.
public struct DrawerContainer<Drawer: View, Content: View>: View {
  @Binding var isOpen: Bool
  let edgeSwipeEnabled: Bool
  let sceneInsets: EdgeInsets
  let drawer: Drawer
  let content: Content

  @State private var drag: CGFloat = 0
  @State private var dragging = false
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.horizontalSizeClass) private var horizontalSizeClass
  @Environment(\.layoutDirection) private var layoutDirection

  public init(isOpen: Binding<Bool>, edgeSwipeEnabled: Bool = true, sceneInsets: EdgeInsets = EdgeInsets(), @ViewBuilder drawer: () -> Drawer, @ViewBuilder content: () -> Content) {
    self._isOpen = isOpen
    self.edgeSwipeEnabled = edgeSwipeEnabled
    self.sceneInsets = sceneInsets
    self.drawer = drawer()
    self.content = content()
  }

  private var direction: CGFloat { layoutDirection == .rightToLeft ? -1 : 1 }

  private static var spring: Animation { .spring(response: 0.36, dampingFraction: 0.88) }

  /// The spring, or a short fade under Reduce Motion.
  private var animation: Animation { reduceMotion ? .easeInOut(duration: 0.2) : Self.spring }

  public var body: some View {
    GeometryReader { proxy in
      // A regular size class also occurs on an unfolded iPhone. Keep a
      // readable detail column when Split View or mirroring narrows the scene.
      let persistent = horizontalSizeClass == .regular && proxy.size.width >= 600
      let width = persistent ? min(proxy.size.width * 0.4, 320) : min(max(proxy.size.width * 0.8, 1), 340)
      let modalOpen = isOpen && !persistent
      let progress: CGFloat = persistent ? 0 : progress(drawerWidth: width)
      ZStack(alignment: .leading) {
        if persistent || isOpen || dragging {
          drawer
            .safeAreaPadding(EdgeInsets(
              top: sceneInsets.top, leading: sceneInsets.leading,
              bottom: sceneInsets.bottom,
              trailing: max(0, width - (proxy.size.width - sceneInsets.trailing))
            ))
            .frame(width: width)
            .frame(maxHeight: .infinity)
            // Above the content under Reduce Motion, so it needs its own fill.
            .background(persistent || reduceMotion ? Color.weave.sunken : Color.clear)
            .shadow(color: .black.opacity(reduceMotion ? 0.14 * progress : 0), radius: 24, x: 4)
            .offset(x: persistent || reduceMotion ? 0 : (progress - 1) * width * 0.25)
            .opacity(persistent ? 1 : reduceMotion ? progress : 0.4 + 0.6 * progress)
            .allowsHitTesting(persistent || progress > 0.99)
            .accessibilityAction(.escape) { close() }
            .transition(drawerTransition(drawerWidth: width))
            .zIndex(reduceMotion ? 1 : 0)
        }

        ZStack {
          content
            .padding(EdgeInsets(
              top: sceneInsets.top,
              leading: max(0, sceneInsets.leading - (persistent ? width : 0)),
              bottom: sceneInsets.bottom, trailing: sceneInsets.trailing
            ))
            .background(Color.weave.canvas)
            .accessibilityHidden(modalOpen)
            .environment(\.isCoveredByDrawer, modalOpen)
            .environment(\.isNavigationSidebarVisible, persistent)
          // Keep the dismissal control outside the hidden content subtree.
          // Newer SwiftUI versions propagate that hidden state to overlays.
          dim(progress: progress, drawerWidth: width, active: modalOpen)
        }
          .frame(width: max(0, proxy.size.width - (persistent ? width : 0)), height: proxy.size.height)
          .clipShape(RoundedRectangle(cornerRadius: reduceMotion ? 0 : WeaveRadius.drawerContent * progress, style: .continuous))
          .shadow(color: .black.opacity(reduceMotion ? 0 : 0.14 * progress), radius: 24, x: -4)
          .scaleEffect(reduceMotion ? 1 : 1 - 0.06 * progress, anchor: .leading)
          .offset(x: persistent ? width : reduceMotion ? 0 : (width + 8) * progress)
          .overlay(alignment: .leading) {
            if edgeSwipeEnabled, !isOpen, !persistent {
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
      .onChange(of: persistent) { _, _ in
        // A fold can arrive in the middle of a swipe. Do not carry a stale
        // translation or an invisible modal cover into the new layout.
        drag = 0
        dragging = false
        isOpen = false
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

extension EnvironmentValues {
  /// Navigation is already visible beside the detail; a menu button is redundant.
  public nonisolated var isNavigationSidebarVisible: Bool {
    get { self[NavigationSidebarVisibleKey.self] }
    set { self[NavigationSidebarVisibleKey.self] = newValue }
  }

  /// True while an open drawer covers this content.
  public nonisolated var isCoveredByDrawer: Bool {
    get { self[CoveredByDrawerKey.self] }
    set { self[CoveredByDrawerKey.self] = newValue }
  }
}

extension View {
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
        WeaveRow("Aide", action: { open = false }) {
          ProjectAvatar(icon: .lucide(name: "concierge-bell", tint: "violet"), title: "Aide", size: 24, style: .plain)
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
          TitleCapsule(title: "Aide")
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
