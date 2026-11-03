import XCTest
import SwiftUI
import SWCFeatures
import SWCSync

/// The real root view on fixture data, resized through the Duo's folded,
/// unfolded portrait and unfolded landscape geometry. Hinge poses themselves
/// need the Duo simulator or the phone.
nonisolated final class AdaptiveSplitTests: XCTestCase {
  @MainActor func testFoldAndUnfoldKeepTheChatDraftAndSwitchNavigation() throws {
    let engine = FixtureEngine(scenario: .long)
    engine.latency = .zero
    engine.streamDelay = .zero
    // A sidebar hidden on this simulator earlier must not change the layout under test.
    UserDefaults.standard.removeObject(forKey: "swc.sidebarCollapsed")
    UserDefaults.standard.removeObject(forKey: "swc.listColumnWidth")
    let host = UIHostingController(rootView: RootView(model: AppModel(engine: engine)))
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

    // Folded, unfolded portrait, unfolded landscape (regular and compact
    // classes), narrow Split View, folded.
    let postures: [(CGSize, UIUserInterfaceSizeClass, Bool)] = [
      (CGSize(width: 466, height: 678), .compact, false),
      // Upright, the chat keeps the whole width; the sidebar would crowd it.
      (CGSize(width: 669, height: 951), .regular, false),
      (CGSize(width: 951, height: 669), .regular, true),
      // The Duo can report a compact class unfolded; width alone decides.
      (CGSize(width: 951, height: 669), .compact, true),
      (CGSize(width: 540, height: 669), .regular, false),
      (CGSize(width: 466, height: 678), .compact, false),
    ]
    var composer: UITextView?
    for (size, sizeClass, expanded) in postures {
      host.traitOverrides.horizontalSizeClass = sizeClass
      host.view.frame = CGRect(origin: .zero, size: size)
      host.view.setNeedsLayout()
      host.view.layoutIfNeeded()
      let context = "\(Int(size.width))x\(Int(size.height))"
      XCTAssertTrue(waitUntil { self.composer(in: host.view) != nil }, "No composer at \(context)")
      let current = try XCTUnwrap(self.composer(in: host.view))
      if let composer {
        XCTAssertTrue(current === composer, "Resize to \(context) remounted the chat")
      } else {
        current.insertText("Draft survives folding")
        composer = current
      }
      XCTAssertEqual(current.text, "Draft survives folding", context)
      XCTAssertTrue(waitUntil {
        let sidebar = self.visibleSidebar(in: host.view)
        let frame = current.convert(current.bounds, to: host.view)
        return expanded
          ? sidebar != nil && frame.minX >= sidebar!.maxX - 1
          : sidebar == nil && frame.minX < 60
      }, "Navigation at \(context) should be \(expanded ? "a sidebar beside the chat" : "the modal drawer"): composer \(current.convert(current.bounds, to: host.view)), lists \(debugLists(in: host.view))")
      let frame = current.convert(current.bounds, to: host.view)
      XCTAssertLessThanOrEqual(frame.maxX, size.width + 1, context)
      XCTAssertFalse(hiddenFromAccessibility(current), "Composer hidden from accessibility at \(context)")
      let image = UIGraphicsImageRenderer(bounds: host.view.bounds).image { _ in
        host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true)
      }
      let attachment = XCTAttachment(image: image)
      attachment.name = "Root view \(context) \(expanded ? "sidebar" : "drawer")"
      attachment.lifetime = .keepAlways
      add(attachment)
    }
  }

  @MainActor private func waitUntil(_ predicate: () -> Bool) -> Bool {
    let deadline = Date().addingTimeInterval(5)
    while !predicate(), Date() < deadline {
      RunLoop.current.run(until: Date().addingTimeInterval(0.02))
    }
    return predicate()
  }

  @MainActor private func composer(in view: UIView) -> UITextView? {
    if let text = view as? UITextView, text.isEditable, !text.isHidden { return text }
    return view.subviews.lazy.compactMap { self.composer(in: $0) }.first
  }

  /// The sidebar list's frame, if a sidebar list is on screen.
  @MainActor private func visibleSidebar(in root: UIView) -> CGRect? {
    func lists(in view: UIView) -> [UICollectionView] {
      (view as? UICollectionView).map { [$0] } ?? view.subviews.flatMap(lists)
    }
    return lists(in: root)
      .filter { !$0.isHidden && $0.window != nil && $0.alpha > 0 }
      .map { $0.convert($0.bounds, to: root) }
      .first { $0.width > 100 && $0.maxX > 1 && $0.minX < root.bounds.width / 2 }
  }

  @MainActor private func debugLists(in view: UIView) -> String {
    var out: [String] = []
    func walk(_ v: UIView) {
      if v is UIScrollView { out.append("\(type(of: v)) \(v.convert(v.bounds, to: view)) hidden=\(v.isHidden) alpha=\(v.alpha)") }
      v.subviews.forEach(walk)
    }
    walk(view)
    return out.joined(separator: "; ")
  }

  @MainActor private func hiddenFromAccessibility(_ view: UIView) -> Bool {
    var current: UIView? = view
    while let v = current {
      if v.accessibilityElementsHidden || v.isHidden { return true }
      current = v.superview
    }
    return false
  }
}
