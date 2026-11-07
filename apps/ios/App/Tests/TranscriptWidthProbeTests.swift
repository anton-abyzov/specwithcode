import XCTest
import SwiftUI
import Weave
@testable import SWCFeatures

/// The chat's own structure (transcript scroll view, composer bar, header)
/// with one kind of wide Markdown at a time, at an iPhone 16's width. The
/// composer must stay on screen whatever the transcript holds.
nonisolated final class TranscriptWidthProbeTests: XCTestCase {
  static let samples: [(String, String)] = [
    ("plain", "Short words that wrap normally across the width of the phone screen, again and again."),
    ("table", """
    | Source | What it shows | What it means | Next step | Owner |
    |---|---|---|---|---|
    | Server traces | A restart at 2:32 PM | It ended before the freeze | Keep the traces | Ministorm |
    """),
    ("code", "```\n/home/anton/.specwithcode/ministorm/userdata/logs/provider/events.project-coordinator-9ce25d03-eb07-42ab-a343-c298a6051f30.log\n```"),
    ("token", "Read /home/anton/.specwithcode/ministorm/userdata/attachments/project-coordinator-9ce25d03-eb07-42ab-a343-c298a6051f30.jpg now"),
    ("link", "Open [a thread](https://example.com/threads/thread%3Adelegated-task%3Acommand%253Amcp%253A566ec9fe-0290-477b-bd15-2ddfc780f4cf) here"),
  ]

  @MainActor func testComposerStaysOnScreenWhateverTheTranscriptHolds() throws {
    var failures: [String] = []
    for (name, markdown) in Self.samples {
      let host = UIHostingController(rootView: DrawerContainer(isOpen: .constant(false)) {
        Text("Navigation")
      } content: {
        NavigationStack {
          ScrollView {
            LazyVStack(alignment: .leading, spacing: WeaveSpacing.s4) {
              ForEach(0..<4, id: \.self) { _ in MarkdownText(markdown) }
            }
            .frame(maxWidth: WeaveSize.readableColumn, alignment: .leading)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, WeaveSpacing.gutter)
          }
          .edgeBar(.bottom) {
            ProbeField(name: "composer").frame(height: 44).padding(.horizontal, WeaveSpacing.gutter)
          }
          .screenChrome {
            ScreenHeader { ProbeField(name: "menu").frame(width: 44, height: 44) } center: { Text("Title") } trailing: { Text("Threads") }
          }
        }
      })
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
      host.view.frame = CGRect(x: 0, y: 0, width: 393, height: 852)
      host.view.layoutIfNeeded()
      RunLoop.current.run(until: Date().addingTimeInterval(0.8))
      for probe in ["composer", "menu"] {
        guard let field = find(probe, in: host.view) else { failures.append("\(name): no \(probe)"); continue }
        let frame = field.convert(field.bounds, to: host.view)
        print("probe \(name) \(probe): \(frame.minX) ... \(frame.maxX)")
        if frame.minX < -1 || frame.maxX > 394 { failures.append("\(name): \(probe) at \(frame.minX)...\(frame.maxX)") }
      }
      let image = UIGraphicsImageRenderer(bounds: host.view.bounds).image { _ in
        host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true)
      }
      if let home = ProcessInfo.processInfo.environment["SIMULATOR_HOST_HOME"] {
        let folder = URL(fileURLWithPath: home).appendingPathComponent("layout-shots")
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try? image.pngData()?.write(to: folder.appendingPathComponent("probe-\(name).png"))
      }
    }
    XCTAssertTrue(failures.isEmpty, failures.joined(separator: "; "))
  }

  @MainActor private func find(_ name: String, in view: UIView) -> UITextField? {
    if let field = view as? UITextField, field.accessibilityIdentifier == name { return field }
    return view.subviews.lazy.compactMap { self.find(name, in: $0) }.first
  }
}

private struct ProbeField: UIViewRepresentable {
  let name: String
  func makeUIView(context: Context) -> UITextField {
    let view = UITextField()
    view.accessibilityIdentifier = name
    return view
  }
  func updateUIView(_ uiView: UITextField, context: Context) {}
}
