import XCTest
import SwiftUI
import Weave
import SWCSync
@testable import SWCFeatures

/// Build 38 hung an iPhone Duo in an Percy thread (scene-update watchdog, main
/// thread in layout). This opens the same shape of thread on the whole app,
/// scrolls through the bottom of the transcript and fails when the main thread
/// stops answering for longer than a frame budget allows.
nonisolated final class AideThreadHangTests: XCTestCase {
  /// The coordinator in the column beside the thread.
  @MainActor func testAideThreadSettlesBesideTheCoordinator() throws {
    try settles(besideCoordinator: true)
  }

  /// The list in the column beside the thread, as on the Duo that hung.
  @MainActor func testAideThreadSettlesBesideTheList() throws {
    try settles(besideCoordinator: false)
  }

  @MainActor private func settles(besideCoordinator: Bool) throws {
    for key in ["swc.chatColumnWidth", "swc.sidebarCollapsed", "swc.listColumnWidth", AppRouter.coordinatorBesideKey] {
      UserDefaults.standard.removeObject(forKey: key)
    }
    let engine = FixtureEngine(scenario: .default)
    engine.latency = .zero
    engine.streamDelay = .zero
    let model = AppModel(engine: engine)
    XCTAssertTrue(waitFor { model.aide != nil && !(model.aide.map { model.threads(in: $0.ref) } ?? []).isEmpty })
    let aide = try XCTUnwrap(model.aide)
    let thread = try XCTUnwrap(model.threads(in: aide.ref).first { $0.ref.threadId == "t-aide-research" })
    let router = AppBootstrap.router(for: model)
    router.showsCoordinatorBeside = besideCoordinator
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

    let stalls = StallWatch()
    stalls.start()
    defer { stalls.stop() }

    RunLoop.current.run(until: Date().addingTimeInterval(2))
    attach(host, "Percy thread opened")
    let scroll = try XCTUnwrap(transcriptScrollView(in: host.view), "no transcript scroll view")
    let bottom = max(0, scroll.contentSize.height + scroll.adjustedContentInset.bottom - scroll.bounds.height)
    // Rest at every point of the bottom 400 pt, where the scroll-to-latest
    // button comes and goes and the collapsed rows sit.
    var offset = bottom
    while offset > bottom - 400, offset > 0 {
      scroll.setContentOffset(CGPoint(x: 0, y: offset), animated: false)
      RunLoop.current.run(until: Date().addingTimeInterval(0.12))
      offset -= 6
    }
    XCTAssertLessThan(stalls.longest, 1.0, "the main thread stalled for \(stalls.longest) s while scrolling")
    // At rest a settled layout leaves the main thread idle.
    stalls.reset()
    RunLoop.current.run(until: Date().addingTimeInterval(2))
    attach(host, "Percy thread after scrolling")
    XCTAssertLessThan(stalls.longest, 0.5, "the main thread stalled for \(stalls.longest) s at rest")
    XCTAssertLessThan(stalls.busyRatio, 0.3, "the main thread stayed busy at rest (\(stalls.busyRatio) of pings late)")
  }

  @MainActor private func transcriptScrollView(in view: UIView) -> UIScrollView? {
    var best: UIScrollView?
    func walk(_ v: UIView) {
      if let s = v as? UIScrollView, s.bounds.height > 200, s.contentSize.height > s.bounds.height,
         best == nil || s.contentSize.height > best!.contentSize.height { best = s }
      v.subviews.forEach(walk)
    }
    walk(view)
    return best
  }

  @MainActor private func attach(_ host: UIViewController, _ name: String) {
    let image = UIGraphicsImageRenderer(bounds: host.view.bounds).image { _ in
      host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true)
    }
    let attachment = XCTAttachment(image: image)
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
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

/// Pings the main queue from a background thread and records how long each
/// ping waited, and how often the main thread was still busy at the next ping.
private final class StallWatch: @unchecked Sendable {
  private let lock = NSLock()
  private var running = false
  private var longestWait: TimeInterval = 0
  private var pings = 0
  private var late = 0

  var longest: TimeInterval { lock.withLock { longestWait } }
  var busyRatio: Double { lock.withLock { pings == 0 ? 0 : Double(late) / Double(pings) } }

  func start() {
    lock.withLock { running = true }
    Thread.detachNewThread { [self] in
      while lock.withLock({ running }) {
        let sent = Date()
        let answered = DispatchSemaphore(value: 0)
        DispatchQueue.main.async { answered.signal() }
        answered.wait()
        let wait = Date().timeIntervalSince(sent)
        lock.withLock {
          pings += 1
          if wait > 0.05 { late += 1 }
          longestWait = max(longestWait, wait)
        }
        Thread.sleep(forTimeInterval: 0.02)
      }
    }
  }

  func stop() { lock.withLock { running = false } }

  func reset() { lock.withLock { longestWait = 0; pings = 0; late = 0 } }
}
