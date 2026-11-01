import XCTest
import SwiftUI
import SWCFeatures
import SWCSync

/// A rotation or fold must settle. On the phone a layout that kept invalidating
/// itself held the main thread at 88% for minutes, heated the phone and got the
/// app killed by the scene-update watchdog. Here the real root view on a long
/// transcript is swept through the Duo's postures the way an animated rotation
/// resizes it, then left idle; the app must go quiet.
nonisolated final class RotationSettleTests: XCTestCase {
  @MainActor func testRotationAndFoldSettleToIdle() throws {
    let engine = FixtureEngine(scenario: .long)
    engine.latency = .zero
    engine.streamDelay = .zero
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

    let portrait = CGSize(width: 669, height: 951)
    let landscape = CGSize(width: 951, height: 669)
    let folded = CGSize(width: 466, height: 678)
    let sweeps: [(CGSize, CGSize, UIUserInterfaceSizeClass)] = [
      (folded, portrait, .regular),
      (portrait, landscape, .regular),
      (landscape, portrait, .regular),
      (portrait, landscape, .regular),
      (landscape, folded, .compact),
    ]
    resize(host, to: folded, sizeClass: .compact)
    idle(2)
    for (from, to, sizeClass) in sweeps {
      host.traitOverrides.horizontalSizeClass = sizeClass
      for step in 1...12 {
        let t = CGFloat(step) / 12
        resize(host, to: CGSize(width: from.width + (to.width - from.width) * t, height: from.height + (to.height - from.height) * t), sizeClass: sizeClass)
        idle(1.0 / 60)
      }
      idle(1)
      let busy = cpuSeconds(during: 2)
      XCTAssertLessThan(busy, 0.5, "Still busy \(busy)s of 2s after moving to \(Int(to.width))x\(Int(to.height)): the layout is not settling")
    }
  }

  @MainActor private func resize(_ host: UIViewController, to size: CGSize, sizeClass: UIUserInterfaceSizeClass) {
    host.traitOverrides.horizontalSizeClass = sizeClass
    host.view.frame = CGRect(origin: .zero, size: size)
    host.view.setNeedsLayout()
    host.view.layoutIfNeeded()
  }

  @MainActor private func idle(_ seconds: TimeInterval) {
    RunLoop.current.run(until: Date().addingTimeInterval(seconds))
  }

  /// CPU time the whole process used while the main run loop idled.
  @MainActor private func cpuSeconds(during seconds: TimeInterval) -> Double {
    let start = processCPU()
    idle(seconds)
    return processCPU() - start
  }

  private func processCPU() -> Double {
    var usage = rusage()
    getrusage(RUSAGE_SELF, &usage)
    let user = Double(usage.ru_utime.tv_sec) + Double(usage.ru_utime.tv_usec) / 1_000_000
    let system = Double(usage.ru_stime.tv_sec) + Double(usage.ru_stime.tv_usec) / 1_000_000
    return user + system
  }
}
