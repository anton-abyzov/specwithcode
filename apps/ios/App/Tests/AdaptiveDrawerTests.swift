import XCTest
import SwiftUI
import Weave
import SWCSync
@testable import SWCFeatures

/// Native component resizing is not a substitute for Duo pose acceptance.
nonisolated final class AdaptiveDrawerTests: XCTestCase {
  override func setUp() {
    super.setUp()
    // A width dragged in an earlier run would replace the automatic width.
    UserDefaults.standard.removeObject(forKey: "swc.listColumnWidth")
  }

  @MainActor func testResizePreservesDraftAndFitsBothColumns() throws {
    for direction in [LayoutDirection.leftToRight, .rightToLeft] {
      let host = UIHostingController(rootView: DrawerContainer(isOpen: .constant(false)) {
        Text("Navigation").frame(maxWidth: .infinity, maxHeight: .infinity)
      } content: {
        DraftProbe()
      }
      .environment(\.horizontalSizeClass, .regular)
      .environment(\.layoutDirection, direction)
      .ignoresSafeArea())
      let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
      let previous = scene.windows.first(where: \.isKeyWindow)
      let window = UIWindow(windowScene: scene)
      let container = UIViewController()
      window.rootViewController = container
      container.addChild(host)
      container.view.addSubview(host.view)
      host.didMove(toParent: container)
      window.makeKeyAndVisible()
      defer {
        window.isHidden = true
        previous?.makeKey()
      }
      host.view.frame = CGRect(x: 0, y: 0, width: 400, height: 700)
      host.view.layoutIfNeeded()
      XCTAssertTrue(waitUntil { self.findField(in: host.view) != nil })
      let field = try XCTUnwrap(findField(in: host.view))
      field.text = "Draft survives folding"
      for width in [1000.0, 669.0, 540.0, 1100.0, 400.0] {
        host.view.frame.size.width = width
        host.view.setNeedsLayout()
        host.view.layoutIfNeeded()
        let expectedWidth = width - Self.columnWidth(width)
        XCTAssertTrue(waitUntil {
          guard let field = self.findField(in: host.view) else { return false }
          return abs(field.frame.width - expectedWidth) < 1
        }, "Layout did not adapt to the new scene width")
        let current = try XCTUnwrap(findField(in: host.view))
        XCTAssertTrue(current === field, "Resize remounted the content view")
        XCTAssertEqual(current.text, "Draft survives folding")
        let frame = current.convert(current.bounds, to: host.view)
        XCTAssertGreaterThanOrEqual(frame.minX, -1)
        XCTAssertLessThanOrEqual(frame.maxX, width + 1)
        if Self.columnWidth(width) > 0 {
          XCTAssertEqual(frame.width, width - Self.columnWidth(width), accuracy: 1)
          XCTAssertEqual(frame.minX, direction == .leftToRight ? Self.columnWidth(width) : 0, accuracy: 1)
        } else {
          XCTAssertEqual(frame.width, width, accuracy: 1)
        }
      }
    }
  }

  @MainActor func testAsymmetricInsetsOnlyConsumeOverlappingEdges() throws {
    // Scene width, leading/trailing system regions, expected navigation/detail widths.
    let cases: [(Double, CGFloat, CGFloat, CGFloat, CGFloat, LayoutDirection)] = [
      (1000, 0, 84, 420, 496, .leftToRight),
      // Below the breakpoint the open drawer is modal over full-width content.
      (669, 0, 84, 340, 585, .leftToRight),
      (320, 0, 84, 236, 236, .leftToRight),
      (1000, 84, 0, 336, 580, .rightToLeft),
    ]
    for (width, leading, trailing, navigationWidth, detailWidth, direction) in cases {
      let host = UIHostingController(rootView: DrawerContainer(
        isOpen: .constant(true), sceneInsets: EdgeInsets(top: 0, leading: leading, bottom: 0, trailing: trailing)
      ) {
        DraftProbe(name: "navigation")
      } content: {
        DraftProbe(name: "detail")
      }
      .environment(\.horizontalSizeClass, .regular)
      .environment(\.layoutDirection, direction)
      .ignoresSafeArea())
      let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
      let previous = scene.windows.first(where: \.isKeyWindow)
      let window = UIWindow(windowScene: scene)
      let container = UIViewController()
      window.rootViewController = container
      container.addChild(host)
      container.view.addSubview(host.view)
      host.didMove(toParent: container)
      window.makeKeyAndVisible()
      defer {
        window.isHidden = true
        window.rootViewController = nil
        previous?.makeKey()
      }
      host.view.frame = CGRect(x: 0, y: 0, width: width, height: 700)
      host.view.layoutIfNeeded()
      XCTAssertTrue(waitUntil { self.findField(in: host.view, name: "detail") != nil })
      let navigation = try XCTUnwrap(findField(in: host.view, name: "navigation"))
      let detail = try XCTUnwrap(findField(in: host.view, name: "detail"))
      XCTAssertEqual(navigation.bounds.width, navigationWidth, accuracy: 1)
      XCTAssertEqual(detail.bounds.width, detailWidth, accuracy: 1)
    }
  }

  /// Dragging the list as wide as it goes still leaves the chat its 340
  /// points beside the Duo's status rail.
  @MainActor func testWidestListLeavesTheChatItsWidthBesideTheRail() throws {
    UserDefaults.standard.set(440.0, forKey: "swc.listColumnWidth")
    defer { UserDefaults.standard.removeObject(forKey: "swc.listColumnWidth") }
    let host = UIHostingController(rootView: DrawerContainer(
      isOpen: .constant(true), sceneInsets: EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 84)
    ) {
      DraftProbe(name: "navigation")
    } content: {
      DraftProbe(name: "detail")
    }
    .environment(\.horizontalSizeClass, .regular)
    .ignoresSafeArea())
    let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
    let previous = scene.windows.first(where: \.isKeyWindow)
    let window = UIWindow(windowScene: scene)
    let container = UIViewController()
    window.rootViewController = container
    container.addChild(host)
    container.view.addSubview(host.view)
    host.didMove(toParent: container)
    window.makeKeyAndVisible()
    defer {
      window.isHidden = true
      window.rootViewController = nil
      previous?.makeKey()
    }
    host.view.frame = CGRect(x: 0, y: 0, width: 760, height: 700)
    host.view.layoutIfNeeded()
    XCTAssertTrue(waitUntil { self.findField(in: host.view, name: "detail") != nil })
    let navigation = try XCTUnwrap(findField(in: host.view, name: "navigation"))
    let detail = try XCTUnwrap(findField(in: host.view, name: "detail"))
    XCTAssertEqual(navigation.bounds.width, 336, accuracy: 1)
    XCTAssertEqual(detail.bounds.width, 340, accuracy: 1)
  }

  /// The Duo can report a compact class at full width, so width alone
  /// decides: a compact wide scene still gets the column, and collapsing it
  /// gives the content the whole width.
  @MainActor func testWideCompactSizeClassGetsColumnUntilCollapsed() throws {
    for collapsed in [false, true] {
      let host = UIHostingController(rootView: DrawerContainer(isOpen: .constant(false), isCollapsed: .constant(collapsed)) {
        DraftProbe(name: "navigation")
      } content: {
        DraftProbe(name: "detail")
      }
      .environment(\.horizontalSizeClass, .compact)
      .ignoresSafeArea())
      let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
      let previous = scene.windows.first(where: \.isKeyWindow)
      let window = UIWindow(windowScene: scene)
      let container = UIViewController()
      window.rootViewController = container
      container.addChild(host)
      container.view.addSubview(host.view)
      host.didMove(toParent: container)
      window.makeKeyAndVisible()
      defer {
        window.isHidden = true
        window.rootViewController = nil
        previous?.makeKey()
      }
      host.view.frame = CGRect(x: 0, y: 0, width: 1000, height: 700)
      host.view.layoutIfNeeded()
      XCTAssertTrue(waitUntil { self.findField(in: host.view, name: "detail") != nil })
      let detail = try XCTUnwrap(findField(in: host.view, name: "detail"))
      if collapsed {
        XCTAssertTrue(waitUntil { self.findField(in: host.view, name: "navigation") == nil }, "A collapsed column must leave the hierarchy")
        XCTAssertEqual(detail.bounds.width, 1000, accuracy: 1)
      } else {
        let navigation = try XCTUnwrap(findField(in: host.view, name: "navigation"))
        XCTAssertEqual(navigation.bounds.width, 420, accuracy: 1)
        XCTAssertEqual(detail.bounds.width, 580, accuracy: 1)
      }
    }
  }

  /// iPhone Duo reports its trailing status rail as a safe-area inset to the
  /// whole window. The column sits far from the rail, so a navigation stack
  /// inside it must still fill the column: the rail once left an empty strip
  /// of its own width between the sidebar and the chat.
  /// The real root view with a thread open, at the Duo's unfolded landscape
  /// size: coordinator on the left, thread on the right, each with a composer.
  /// Upright at 669 points the column does not exist and one composer remains.
  @MainActor func testCoordinatorSitsBesideTheOpenThreadWhenUnfolded() throws {
    for key in ["swc.chatColumnWidth", "swc.sidebarCollapsed", AppRouter.coordinatorBesideKey] {
      UserDefaults.standard.removeObject(forKey: key)
    }
    let engine = FixtureEngine(scenario: .default)
    engine.latency = .zero
    engine.streamDelay = .zero
    let model = AppModel(engine: engine)
    XCTAssertTrue(waitUntil { model.projects.contains { !model.threads(in: $0.ref).isEmpty } })
    let project = try XCTUnwrap(model.projects.first { !model.threads(in: $0.ref).isEmpty })
    let thread = try XCTUnwrap(model.threads(in: project.ref).first)
    AppBootstrap.router(for: model).open(.thread(thread.ref))

    let host = UIHostingController(rootView: RootView(model: model))
    let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
    let previous = scene.windows.first(where: \.isKeyWindow)
    let window = UIWindow(windowScene: scene)
    window.rootViewController = host
    window.makeKeyAndVisible()
    defer {
      window.isHidden = true
      window.rootViewController = nil
      previous?.makeKey()
    }

    func composers() -> [CGRect] {
      func walk(_ view: UIView) -> [UITextView] {
        if let text = view as? UITextView, text.isEditable, !text.isHidden, text.window != nil { return [text] }
        return view.subviews.flatMap(walk)
      }
      return walk(host.view).map { $0.convert($0.bounds, to: host.view) }.sorted { $0.minX < $1.minX }
    }
    func attach(_ name: String) {
      let image = UIGraphicsImageRenderer(bounds: host.view.bounds).image { _ in
        host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true)
      }
      let attachment = XCTAttachment(image: image)
      attachment.name = name
      attachment.lifetime = .keepAlways
      add(attachment)
    }

    host.view.frame = CGRect(x: 0, y: 0, width: 951, height: 669)
    host.view.layoutIfNeeded()
    // The column springs from the list's width to half the scene, so the
    // composers settle into place rather than start there.
    XCTAssertTrue(waitUntil {
      let frames = composers()
      return frames.count == 2 && frames[0].maxX <= 951 / 2 + 1 && frames[1].minX >= 951 / 2 - 1
    }, "composers at 951: \(composers())")
    RunLoop.current.run(until: Date().addingTimeInterval(1))
    attach("Coordinator beside thread 951x669")

    let router = AppBootstrap.router(for: model)
    router.showsCoordinatorBeside = false
    XCTAssertTrue(waitUntil { composers().count == 1 }, "composers with the list: \(composers())")
    router.showsCoordinatorBeside = true
    XCTAssertTrue(waitUntil { composers().count == 2 }, "composers after the list: \(composers())")

    host.view.frame = CGRect(x: 0, y: 0, width: 669, height: 951)
    host.view.layoutIfNeeded()
    XCTAssertTrue(waitUntil { composers().count == 1 }, "composers at 669: \(composers())")
    attach("Thread alone 669x951")
  }

  @MainActor func testTrailingRailDoesNotNarrowTheColumnStack() throws {
    let width = 951.0
    let host = UIHostingController(rootView: GeometryReader { proxy in
      DrawerContainer(isOpen: .constant(false), sceneInsets: proxy.safeAreaInsets) {
        NavigationStack {
          List { Text("Projects"); Text("EasyChamp") }
            .listStyle(.sidebar)
            .scrollContentBackground(.hidden)
            .toolbar(.hidden, for: .navigationBar)
            .safeAreaInset(edge: .top, spacing: 0) { Text("Header") }
            .background(DraftProbe(name: "navigation"))
            .fillsDrawerWidth()
        }
      } content: {
        NavigationStack { DraftProbe(name: "detail") }
      }
      .ignoresSafeArea()
    })
    let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
    let previous = scene.windows.first(where: \.isKeyWindow)
    let window = UIWindow(windowScene: scene)
    let container = UIViewController()
    window.rootViewController = container
    container.addChild(host)
    container.view.addSubview(host.view)
    host.didMove(toParent: container)
    host.additionalSafeAreaInsets = UIEdgeInsets(top: 0, left: 0, bottom: 0, right: 84)
    window.makeKeyAndVisible()
    defer {
      window.isHidden = true
      window.rootViewController = nil
      previous?.makeKey()
    }
    host.view.frame = CGRect(x: 0, y: 0, width: width, height: 669)
    host.view.layoutIfNeeded()
    XCTAssertTrue(waitUntil { self.findField(in: host.view, name: "navigation") != nil })
    let navigation = try XCTUnwrap(findField(in: host.view, name: "navigation"))
    let detail = try XCTUnwrap(findField(in: host.view, name: "detail"))
    XCTAssertTrue(waitUntil { abs(navigation.bounds.width - Self.columnWidth(width)) < 1 }, "column stack is \(navigation.bounds.width) wide, column is \(Self.columnWidth(width))")
    XCTAssertEqual(detail.bounds.width, width - Self.columnWidth(width) - 84, accuracy: 1)
  }

  /// The folded Duo leaves 358 points beside its rail. A header that asks for
  /// more widens the whole screen, which then overflows on both sides.
  @MainActor func testCenteredHeaderNeverAsksForMoreThanItIsOffered() {
    let host = UIHostingController(rootView: ScreenHeader {
      Text("Back")
    } center: {
      Text("A coordinator title long enough to need truncating here")
    } trailing: {
      Text("m1 and a long set of thread controls")
    })
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 358, height: 100))
    window.rootViewController = host
    window.isHidden = false
    defer { window.isHidden = true }
    host.view.layoutIfNeeded()
    RunLoop.current.run(until: Date().addingTimeInterval(0.1))
    XCTAssertLessThanOrEqual(host.sizeThatFits(in: CGSize(width: 358, height: 100)).width, 358)
  }

  /// A thread's header starts its title after the Back button. It may not
  /// ask for more than it is offered either, however long the controls are.
  @MainActor func testLeadingHeaderNeverAsksForMoreThanItIsOffered() {
    let host = UIHostingController(rootView: ScreenHeader(alignment: .leading) {
      Text("Back and Menu")
    } center: {
      Text("A thread title long enough to need truncating on a small phone")
    } trailing: {
      Text("Device, machine and thread actions")
    })
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 320, height: 100))
    window.rootViewController = host
    window.isHidden = false
    defer { window.isHidden = true }
    host.view.layoutIfNeeded()
    RunLoop.current.run(until: Date().addingTimeInterval(0.1))
    XCTAssertLessThanOrEqual(host.sizeThatFits(in: CGSize(width: 320, height: 100)).width, 320)
  }

  /// A header with nothing beside the title (a thread beside the sidebar on
  /// the Duo's rail) still shows the title, at its natural width.
  @MainActor func testHeaderWithEmptySidesStillShowsItsTitle() {
    for alignment in [ScreenHeader<EmptyView, Text, EmptyView>.TitleAlignment.center, .leading] {
      let host = UIHostingController(rootView: ScreenHeader(alignment: alignment) {
        EmptyView()
      } center: {
        Text("Release checklist")
      } trailing: {
        EmptyView()
      })
      let size = host.sizeThatFits(in: CGSize(width: 393, height: 100))
      XCTAssertGreaterThan(size.height, 20, "\(alignment) header lost its title")
      XCTAssertLessThanOrEqual(size.width, 393)
    }
  }

  /// The column's width at a scene width, or 0 below the breakpoint.
  private static func columnWidth(_ width: Double) -> Double {
    width >= Double(WeaveSize.sidebarBreakpoint) ? min(max(width * 0.42, 288), 420) : 0
  }

  @MainActor private func waitUntil(_ predicate: () -> Bool) -> Bool {
    let deadline = Date().addingTimeInterval(3)
    while !predicate(), Date() < deadline {
      RunLoop.current.run(until: Date().addingTimeInterval(0.01))
    }
    return predicate()
  }

  @MainActor private func findField(in view: UIView, name: String? = nil) -> UITextField? {
    if let field = view as? UITextField, name == nil || field.accessibilityIdentifier == name { return field }
    return view.subviews.lazy.compactMap { self.findField(in: $0, name: name) }.first
  }
}

private struct DraftProbe: UIViewRepresentable {
  var name: String = "draft"
  func makeUIView(context: Context) -> UITextField {
    let view = UITextField()
    view.placeholder = "Unsent draft"
    view.accessibilityIdentifier = name
    return view
  }
  func updateUIView(_ uiView: UITextField, context: Context) {}
}
