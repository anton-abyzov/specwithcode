import Foundation
import SwiftUI
import Testing
@testable import SWCFeatures
import SWCSync
import Weave
#if canImport(AppKit)
import AppKit
#endif

/// The access request card and the waiting row, built from the same mappings
/// the chat and lists use. With SWC_RENDER_EVIDENCE=1 it also writes PNGs to
/// ~/.specwithcode/m4/evidence/access-request-card for a visual check.
@MainActor
@Suite("Access request card")
struct AccessRequestCardRenderTests {
  static let png = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==")

  static let request = AccessRequestRow(
    threadId: "thr_1", itemId: "turn-item:access-request:thr_1:app", title: "Use Notes",
    reason: "Draft the launch post in Notes from the showcase captions.",
    subjects: [.init(kind: "app", key: "app:notes", label: "Notes", detail: "See and control its windows", iconPNG: png)],
    state: .pending
  )

  static let mixed = AccessRequestRow(
    threadId: "thr_1", itemId: "turn-item:access-request:thr_1:mixed", title: "Use Activity Monitor and iPhone 17 Pro",
    reason: "To see what keeps the Mac awake and check the fix on the phone.",
    subjects: [
      .init(kind: "app", key: "app:activity monitor", label: "Activity Monitor", detail: "See and control its windows"),
      .init(kind: "device", key: "device:iphone", label: "iPhone 17 Pro", detail: "Install and drive apps", hostLabel: "M1", platform: "ios"),
    ],
    state: .pending
  )

  /// A long reason and many subjects: more than the card may show at once.
  static let long = AccessRequestRow(
    threadId: "thr_1", itemId: "turn-item:access-request:thr_1:long", title: "Use six apps and two devices",
    reason: String(repeating: "Check the release build end to end, compare the screenshots against the last run, and confirm the update banner shows on both phones. ", count: 4),
    subjects: (1...6).map { .init(kind: "app", key: "app:\($0)", label: "App \($0)", detail: "See and control its windows") }
      + [
        .init(kind: "device", key: "device:iphone", label: "iPhone 17 Pro", detail: "Install and drive apps", hostLabel: "M1", platform: "ios"),
        .init(kind: "device", key: "device:ipad", label: "iPad Pro", detail: "Install and drive apps", hostLabel: "M1", platform: "ios"),
      ],
    state: .pending
  )

  static var waitingThread: ThreadSummary {
    var thread = ThreadSummary(
      ref: ThreadRef(environmentId: "env", threadId: "thr_1"), title: "Launch SpecWithCode iPhone Duo showcase",
      activity: .needsYou, preview: "Asking to use apps on your computer", updatedAt: Date(), machineLabel: "M4", machineOnline: true
    )
    thread.asksForAccess = true
    return thread
  }

  @Test func waitingThreadShowsAHandAndTheSubtitle() {
    let thread = Self.waitingThread
    #expect(ThreadStatusMark.state(of: thread) == .needsYou)
    #expect(ThreadStatusMark.needsYouSymbol(thread) == "hand.raised")
    #expect(thread.accessWaitLine == "Asking to use apps on your computer")
    var reply = thread
    reply.asksForAccess = false
    #expect(ThreadStatusMark.needsYouSymbol(reply) == "bubble.left.fill")
    #expect(reply.accessWaitLine == nil)
  }

  @Test func cardButtonsAnswerWithTheirScope() {
    #expect(AccessRequestCard.allowTitle == "Allow for this session")
    #expect(AccessRequestCard.alwaysTitle == "Always allow on this machine")
    #expect(AccessRequestCard.Answer.allow(.thread).engineAnswer == .allow(.thread))
    #expect(AccessRequestCard.Answer.allow(.machine).engineAnswer == .allow(.machine))
    #expect(AccessRequestCard.Answer.deny.engineAnswer == .deny)
  }

  #if canImport(AppKit)
  @Test func longCardStaysUnderItsCap() {
    func height(_ view: some View) -> CGFloat {
      let host = NSHostingController(rootView: view.frame(width: 390))
      return host.sizeThatFits(in: CGSize(width: 390, height: 10_000)).height
    }
    let cap: CGFloat = 420
    let open = height(Self.long.card(agent: "Claude", style: .composer, isBusy: false) { _ in })
    let capped = height(Self.long.card(agent: "Claude", style: .composer, isBusy: false, maxHeight: cap) { _ in })
    #expect(open > cap)
    #expect(capped <= cap + 1)
    // A short card is not stretched to the cap.
    let short = height(Self.request.card(agent: "Claude", style: .composer, isBusy: false, maxHeight: 2_000) { _ in })
    #expect(short == height(Self.request.card(agent: "Claude", style: .composer, isBusy: false) { _ in }))
  }

  @Test(.enabled(if: ProcessInfo.processInfo.environment["SWC_RENDER_EVIDENCE"] == "1"))
  func renderEvidence() throws {
    let dir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".specwithcode/m4/evidence/access-request-card")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    for scheme in [ColorScheme.light, .dark] {
      let name = scheme == .light ? "light" : "dark"
      for (width, label) in [(CGFloat(390), "phone"), (CGFloat(720), "wide")] {
        try write(card(Self.request, agent: "Claude"), width: width, scheme: scheme, to: dir.appendingPathComponent("ios-composer-card-\(label)-\(name).png"))
      }
      try write(card(Self.mixed, agent: "Codex"), width: 390, scheme: scheme, to: dir.appendingPathComponent("ios-composer-card-two-subjects-\(name).png"))
      try write(transcriptLines, width: 390, scheme: scheme, to: dir.appendingPathComponent("ios-transcript-lines-\(name).png"))
      try write(waitingRow, width: 390, scheme: scheme, to: dir.appendingPathComponent("ios-waiting-row-\(name).png"))
      // A phone with the keyboard up leaves about 420 points; the card takes at most 45% plus its buttons' floor.
      // ImageRenderer leaves a scroll view blank, so the scrolling card is drawn in a hosting view.
      try writeHosted(Self.long.card(agent: "Claude", style: .composer, isBusy: false, maxHeight: 420 * 0.45, waitingCount: 3) { _ in }, width: 390, scheme: scheme, to: dir.appendingPathComponent("ios-composer-card-long-capped-\(name).png"))
      try write(Self.mixed.card(agent: "Codex", style: .composer, isBusy: false, waitingCount: 2) { _ in }, width: 390, scheme: scheme, to: dir.appendingPathComponent("ios-composer-card-queue-\(name).png"))
      try write(card(Self.request, agent: "Claude").environment(\.dynamicTypeSize, .accessibility2), width: 390, scheme: scheme, to: dir.appendingPathComponent("ios-composer-card-large-type-\(name).png"))
    }
  }

  private func card(_ request: AccessRequestRow, agent: String) -> some View {
    VStack(spacing: WeaveSpacing.s2) {
      Spacer(minLength: 0)
      // The composer's text field does not render off screen, so only the card is drawn.
      request.card(agent: agent, style: .composer, isBusy: false) { _ in }
    }
  }

  private var transcriptLines: some View {
    VStack(spacing: WeaveSpacing.s3) {
      Self.request.card(agent: "Claude", style: .transcript, isBusy: false) { _ in }
      ForEach([AccessRequestRow.State.allowedInThread, .allowedOnMachine, .denied, .ended], id: \.self) { state in
        Self.answered(state).card(agent: "Claude", style: .transcript, isBusy: false) { _ in }
      }
      Self.inherited.card(agent: "Claude", style: .transcript, isBusy: false) { _ in }
    }
  }

  static var inherited: AccessRequestRow {
    var row = request
    row.isInherited = true
    return row
  }

  static func answered(_ state: AccessRequestRow.State) -> AccessRequestRow {
    var row = request
    row.state = state
    return row
  }

  /// The sidebar's thread line for a thread waiting on access.
  private var waitingRow: some View {
    let thread = Self.waitingThread
    return HStack(spacing: WeaveSpacing.s2) {
      ThreadStatusMark(thread: thread)
      VStack(alignment: .leading, spacing: 1) {
        Text(thread.title).font(.weave(.callout)).foregroundStyle(Color.weave.ink).lineLimit(1)
        Text(thread.accessWaitLine ?? "").font(.weave(.footnote)).foregroundStyle(Color.weave.muted).lineLimit(1)
      }
      Spacer(minLength: 0)
    }
    .frame(minHeight: 36)
  }

  private func writeHosted(_ view: some View, width: CGFloat, scheme: ColorScheme, to url: URL) throws {
    let content = view
      .padding(WeaveSpacing.gutter)
      .frame(width: width)
      .background(Color.weave.canvas)
      .environment(\.colorScheme, scheme)
    let host = NSHostingView(rootView: content)
    host.appearance = NSAppearance(named: scheme == .dark ? .darkAqua : .aqua)
    let size = host.fittingSize
    let window = NSWindow(contentRect: CGRect(origin: .zero, size: size), styleMask: .borderless, backing: .buffered, defer: false)
    window.appearance = host.appearance
    window.contentView = host
    host.frame = CGRect(origin: .zero, size: size)
    host.layoutSubtreeIfNeeded()
    RunLoop.main.run(until: Date().addingTimeInterval(0.2))
    let rep = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
    host.cacheDisplay(in: host.bounds, to: rep)
    let png = try #require(rep.representation(using: .png, properties: [:]))
    try png.write(to: url)
  }

  private func write(_ view: some View, width: CGFloat, scheme: ColorScheme, to url: URL) throws {
    let content = view
      .padding(WeaveSpacing.gutter)
      .frame(width: width)
      .background(Color.weave.canvas)
      .environment(\.colorScheme, scheme)
    let renderer = ImageRenderer(content: content)
    renderer.scale = 2
    let appearance = NSAppearance(named: scheme == .dark ? .darkAqua : .aqua)
    var data: Data?
    appearance?.performAsCurrentDrawingAppearance {
      guard let image = renderer.cgImage else { return }
      data = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])
    }
    let png = try #require(data)
    try png.write(to: url)
  }
  #endif
}
