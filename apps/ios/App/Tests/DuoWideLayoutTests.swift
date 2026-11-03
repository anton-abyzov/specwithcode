import XCTest
import SwiftUI
import Weave
import SWCSync
@testable import SWCFeatures

/// The whole app on fixture data at the Duo's unfolded landscape size, with
/// renders attached so the layout can be compared by eye.
nonisolated final class DuoWideLayoutTests: XCTestCase {
  @MainActor func testRendersEveryWideColumnAtDuoSize() throws {
    for key in ["swc.chatColumnWidth", "swc.sidebarCollapsed", "swc.listColumnWidth", AppRouter.coordinatorBesideKey] {
      UserDefaults.standard.removeObject(forKey: key)
    }
    let engine = FixtureEngine(scenario: .default)
    engine.latency = .zero
    engine.streamDelay = .zero
    let model = AppModel(engine: engine)
    XCTAssertTrue(waitFor { model.projects.contains { !model.threads(in: $0.ref).isEmpty } })
    let project = try XCTUnwrap(model.projects.first { !model.threads(in: $0.ref).isEmpty })
    let thread = try XCTUnwrap(model.threads(in: project.ref).first)
    let router = AppBootstrap.router(for: model)
    router.open(.thread(thread.ref))

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
    host.view.frame = CGRect(x: 0, y: 0, width: 951, height: 669)
    host.view.layoutIfNeeded()

    func attach(_ name: String) {
      RunLoop.current.run(until: Date().addingTimeInterval(1.5))
      let image = UIGraphicsImageRenderer(bounds: host.view.bounds).image { _ in
        host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true)
      }
      let attachment = XCTAttachment(image: image)
      attachment.name = name
      attachment.lifetime = .keepAlways
      add(attachment)
    }

    attach("Duo coordinator beside thread")
    XCTAssertEqual(router.sidebarScope(in: model), project.ref)
    router.showsCoordinatorBeside = false
    attach("Duo list beside thread")
    router.sidebarShowsAllProjects = true
    XCTAssertNil(router.sidebarScope(in: model))
    attach("Duo all projects")
    router.sidebarShowsAllProjects = false

    // The list stays while threads change on the right.
    let other = try XCTUnwrap(model.threads(in: project.ref).first { $0.ref != thread.ref })
    router.open(.thread(other.ref))
    XCTAssertFalse(router.showsCoordinatorBeside)
    XCTAssertEqual(Set(router.sidebarThreads(in: model).map(\.ref)), Set(model.threads(in: project.ref).filter { !$0.isResolved }.map(\.ref)))
    let listed = router.sidebarThreads(in: model).map(\.ref)
    router.sidebarMachine = "no-such-machine"
    XCTAssertEqual(router.sidebarThreads(in: model).map(\.ref), listed)
    router.sidebarMachine = nil
    attach("Duo list after switching thread")
    router.showsCoordinatorBeside = true
  }

  @MainActor private func waitFor(timeout: TimeInterval = 5, _ condition: () -> Bool) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      if condition() { return true }
      RunLoop.current.run(until: Date().addingTimeInterval(0.05))
    }
    return condition()
  }
}
