import XCTest
import SwiftUI
import Weave

/// Native component resizing is not a substitute for Duo pose acceptance.
nonisolated final class AdaptiveDrawerTests: XCTestCase {
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
        let expectedWidth = width >= 600 ? width - min(width * 0.4, 320) : width
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
        if width >= 600 {
          XCTAssertEqual(frame.width, width - min(width * 0.4, 320), accuracy: 1)
          XCTAssertEqual(frame.minX, direction == .leftToRight ? min(width * 0.4, 320) : 0, accuracy: 1)
        } else {
          XCTAssertEqual(frame.width, width, accuracy: 1)
        }
      }
    }
  }

  @MainActor func testAsymmetricInsetsOnlyConsumeOverlappingEdges() throws {
    // Scene width, leading/trailing system regions, expected navigation/detail widths.
    let cases: [(Double, CGFloat, CGFloat, CGFloat, CGFloat, LayoutDirection)] = [
      (1000, 0, 84, 320, 596, .leftToRight),
      (669, 0, 84, 267.6, 317.4, .leftToRight),
      (320, 0, 84, 236, 236, .leftToRight),
      (1000, 84, 0, 236, 680, .rightToLeft),
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

  @MainActor func testWideCompactSizeClassRetainsModalDrawer() throws {
    for open in [false, true] {
      let host = UIHostingController(rootView: DrawerContainer(isOpen: .constant(open)) {
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
      XCTAssertEqual(detail.bounds.width, 1000, accuracy: 1, "Compact traits must never reserve a persistent column")
      if open {
        let navigation = try XCTUnwrap(findField(in: host.view, name: "navigation"))
        XCTAssertEqual(navigation.bounds.width, 340, accuracy: 1)
      } else {
        XCTAssertNil(findField(in: host.view, name: "navigation"), "Closed modal navigation must leave the hierarchy")
      }
    }
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
