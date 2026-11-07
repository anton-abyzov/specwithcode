import XCTest
import SwiftUI
import Weave
import SWCSync
@testable import SWCFeatures

/// The whole app on fleet fixture data at every iPhone portrait width, from
/// the SE to the Pro Max and the folded Duo. A screen that asks for more width
/// than it is offered is laid out wider and centered, so it spills past both
/// edges: the menu button and the composer's + leave the screen.
nonisolated final class PhoneWidthLayoutTests: XCTestCase {
  /// SE and mini, 16e and 16, 17, Pro Max, folded Duo beside its rail.
  static let widths: [CGFloat] = [320, 358, 375, 390, 393, 402, 440]

  @MainActor func testCoordinatorAndThreadFitEveryPhoneWidth() throws {
    try run(longNames: false, unfoldFirst: false)
  }

  /// Real machine names are longer than the fixture's "M4": "ministorm",
  /// "Anton's MacBook M4MAX".
  @MainActor func testLongMachineNamesFitEveryPhoneWidth() throws {
    try run(longNames: true, unfoldFirst: false)
  }

  /// A wider scene first (an unfolded Duo, a rotation, Split View), then back
  /// to the phone's width: nothing measured at the wide size may stay.
  @MainActor func testComingBackFromAWideSceneFits() throws {
    try run(longNames: true, unfoldFirst: true)
  }

  /// Turned to landscape (wide enough for the sidebar column) and back.
  @MainActor func testComingBackFromLandscapeFits() throws {
    try run(longNames: true, unfoldFirst: true, wideSize: CGSize(width: 852, height: 393))
  }

  @MainActor private func run(longNames: Bool, unfoldFirst: Bool, wideSize: CGSize = CGSize(width: 700, height: 852)) throws {
    for key in ["swc.chatColumnWidth", "swc.sidebarCollapsed", "swc.listColumnWidth", AppRouter.coordinatorBesideKey] {
      UserDefaults.standard.removeObject(forKey: key)
    }
    let engine = FixtureEngine(scenario: .fleet)
    engine.latency = .zero
    engine.streamDelay = .zero
    let model = AppModel(engine: engine)
    XCTAssertTrue(waitFor { model.projects.contains { $0.members.count > 1 } })
    if longNames {
      let names = ["ministorm", "Anton’s MacBook M4MAX", "m1"]
      model.projects = model.projects.map { project in
        var project = project
        project.members = project.members.enumerated().map { index, member in
          var member = member
          member.machineLabel = names[index % names.count]
          return member
        }
        return project
      }
    }
    // A project on more than one machine: its header carries the machine switch and Threads.
    let project = try XCTUnwrap(model.projects.first { $0.members.count > 1 })
    let thread = try XCTUnwrap(model.threads(in: project.ref).first)
    let router = AppBootstrap.router(for: model)

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

    var failures: [String] = []
    for (name, target) in [("coordinator", ChatTarget.project(project.ref)), ("thread", .thread(thread.ref))] {
      router.open(target)
      for width in Self.widths {
        if unfoldFirst {
          host.view.frame = CGRect(origin: .zero, size: wideSize)
          host.view.layoutIfNeeded()
          RunLoop.current.run(until: Date().addingTimeInterval(0.6))
        }
        let size = CGSize(width: width, height: 852)
        host.view.frame = CGRect(origin: .zero, size: size)
        host.view.layoutIfNeeded()
        RunLoop.current.run(until: Date().addingTimeInterval(0.8))
        let wanted = host.sizeThatFits(in: size).width
        let label = "\(name)\(longNames ? "-long" : "")\(unfoldFirst ? "-from\(Int(wideSize.width))" : "")-\(Int(width))"
        // The composer's text field is the screen's widest control; it must sit inside the screen.
        let fields = textInputs(in: host.view).map { $0.convert($0.bounds, to: host.view) }
        let spill = fields.filter { $0.minX < -1 || $0.maxX > width + 1 }
        print("layout \(label): asks \(wanted), inputs \(fields.map { "\(Int($0.minX))...\(Int($0.maxX))" })")
        if wanted > width + 0.5 { failures.append("\(label) asks for \(wanted)") }
        if !spill.isEmpty { failures.append("\(label) input at \(spill.map { "\(Int($0.minX))...\(Int($0.maxX))" })") }
        save(host.view, label)
      }
    }
    XCTAssertTrue(failures.isEmpty, failures.joined(separator: "; "))
  }

  /// One PNG per case, for the CI artifact and for comparing by eye.
  @MainActor private func save(_ view: UIView, _ name: String) {
    let image = UIGraphicsImageRenderer(bounds: view.bounds).image { _ in
      view.drawHierarchy(in: view.bounds, afterScreenUpdates: true)
    }
    let attachment = XCTAttachment(image: image)
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
    guard let home = ProcessInfo.processInfo.environment["SIMULATOR_HOST_HOME"] else { return }
    let folder = URL(fileURLWithPath: home).appendingPathComponent("layout-shots")
    try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    try? image.pngData()?.write(to: folder.appendingPathComponent("\(name).png"))
  }

  @MainActor private func textInputs(in view: UIView) -> [UIView] {
    if view.isHidden || view.alpha == 0 { return [] }
    let own: [UIView] = (view is UITextField || view is UITextView) ? [view] : []
    return own + view.subviews.flatMap { textInputs(in: $0) }
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
