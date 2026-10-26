import SwiftUI
import SWCSync
import Weave
#if canImport(UIKit)
import UIKit
import WebKit
#endif

/// Which device the viewer shows: a machine and the device's
/// `DeviceSessionSummary.id`, so it follows the device across state updates.
nonisolated struct DeviceViewerRoute: Identifiable, Hashable, Sendable {
  let machineId: String
  let key: String
  var id: String { machineId + "\n" + key }
}

extension View {
  /// Presents the device viewer full screen while `route` is set.
  func deviceViewer(_ route: Binding<DeviceViewerRoute?>) -> some View {
    #if os(iOS)
    fullScreenCover(item: route) { DeviceViewerScreen(route: $0) }
    #else
    sheet(item: route) { DeviceViewerScreen(route: $0) }
    #endif
  }
}

#if canImport(UIKit)
/// A simulator or emulator on a machine, streamed full screen. Touches on
/// the stream reach the device; the bar on top closes the viewer and presses
/// hardware buttons. Works in portrait and landscape.
struct DeviceViewerScreen: View {
  let route: DeviceViewerRoute

  @Environment(AppModel.self) private var model
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var scenePhase

  @State private var lastSession: DeviceSessionSummary?
  @State private var access: DeviceHubAccess?
  @State private var accessError: String?
  /// Each value loads the page again with a fresh ticket.
  @State private var attempt = 0
  @State private var status: DeviceStreamMessage.Status = .connecting
  @State private var streamError: String?
  @State private var started = false
  @State private var inputConnected = false
  @State private var controlsVisible = true
  @State private var refusals = 0
  @State private var processRetried = false
  /// Only a real trip to the background ends the stream; Control Center and alerts don't.
  @State private var wentToBackground = false
  @State private var handle = DeviceStreamHandle()

  private var liveSession: DeviceSessionSummary? {
    model.devices[route.machineId]?.sessions.first { $0.id == route.key }
  }

  /// The live session, or the last one seen while the state is loading or the machine reconnects.
  private var session: DeviceSessionSummary? { liveSession ?? lastSession }

  /// The machine's current device list no longer has this device.
  private var deviceClosed: Bool {
    lastSession != nil && liveSession == nil && model.devices[route.machineId]?.support == .available
  }

  private var closedMessage: String {
    "This device is no longer open on \(model.machine(route.machineId)?.displayName ?? "the computer")."
  }

  var body: some View {
    ZStack {
      Color.weave.sunken.ignoresSafeArea()
      if let session, let access, let script = Self.script {
        DeviceStreamView(
          html: DeviceStreamDocument.html(configuration: DeviceStreamDocument.configuration(access: access, session: session), script: script),
          handle: handle,
          onMessage: received,
          onProcessTerminated: processTerminated
        )
        .id(attempt)
        .ignoresSafeArea()
        .accessibilityLabel(session.isAndroid ? "Android Emulator screen" : "iOS Simulator screen")
      }
      if status != .streaming || access == nil {
        statusOverlay
      }
      VStack(spacing: 0) {
        if controlsVisible {
          controlBar
            .transition(.move(edge: .top).combined(with: .opacity))
        } else {
          showControlsButton
        }
        Spacer(minLength: 0)
      }
      .animation(.snappy, value: controlsVisible)
    }
    .environment(\.colorScheme, .dark)
    .statusBarHidden()
    .persistentSystemOverlays(.hidden)
    .onAppear {
      lastSession = session
    }
    .onDisappear {
      handle.stop()
    }
    .onChange(of: liveSession) { _, next in if let next { lastSession = next } }
    .onChange(of: deviceClosed) { _, closed in if closed { fail(closedMessage) } }
    .onChange(of: scenePhase) { _, phase in
      switch phase {
      case .background:
        wentToBackground = true
        handle.stop()
      // Streams don't survive the background; come back with a fresh ticket.
      case .active where wentToBackground:
        wentToBackground = false
        if access != nil, streamError == nil { reconnect() }
      default: break
      }
    }
    .task(id: attempt) { await loadAccess() }
    .task(id: "\(attempt)-\(started)-\(access != nil)") {
      // The shared transport owns its own timeouts once the page reports in.
      guard !started, access != nil else { return }
      try? await Task.sleep(for: .seconds(15))
      guard !Task.isCancelled, !started else { return }
      fail("Device viewer could not start. Reconnect to try again.")
    }
    .task(id: status) {
      guard status == .streaming else { return }
      try? await Task.sleep(for: .seconds(4))
      guard !Task.isCancelled, status == .streaming else { return }
      controlsVisible = false
    }
  }

  // MARK: Chrome

  private var controlBar: some View {
    HStack(spacing: WeaveSpacing.s2) {
      WeaveIconButton("xmark", label: "Close") { dismiss() }
        .accessibilityIdentifier("device.close")
      VStack(alignment: .leading, spacing: 0) {
        Text(session?.name ?? "Device")
          .weaveFont(.headline)
          .foregroundStyle(Color.weave.ink)
          .lineLimit(1)
        if let detail = session?.detail, !detail.isEmpty {
          Text(detail)
            .weaveFont(.caption)
            .foregroundStyle(Color.weave.muted)
            .lineLimit(1)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .accessibilityElement(children: .combine)
      WeaveIconButton("circle.circle", label: "Home") { handle.command(.home) }
        .disabled(!inputConnected)
        .accessibilityIdentifier("device.home")
      Menu {
        Section {
          // Android rotates from its own Tools; the stream turns only the iOS Simulator.
          if session?.isAndroid != true {
            Button("Rotate", systemImage: "rotate.right") { handle.command(.rotate) }
          }
          Button("App switcher", systemImage: "square.stack") { handle.command(.appSwitcher) }
          if session?.isAndroid == true {
            Button("Back", systemImage: "chevron.backward") { handle.command(.back) }
          }
        }
        .disabled(!inputConnected)
        Section {
          Button("Reconnect", systemImage: "arrow.clockwise") { reconnect() }
          Button("Hide controls", systemImage: "chevron.up") { controlsVisible = false }
        }
      } label: {
        Image(systemName: "ellipsis")
          .font(.system(size: 17, weight: .semibold))
          .foregroundStyle(Color.weave.ink)
          .frame(width: WeaveSize.control, height: WeaveSize.control)
          .weaveGlass(in: Circle(), interactive: true)
      }
      .menuIndicator(.hidden)
      .accessibilityLabel("More device controls")
      .accessibilityIdentifier("device.more")
    }
    .padding(.horizontal, WeaveSpacing.gutter)
    .padding(.top, WeaveSpacing.s2)
    .padding(.bottom, WeaveSpacing.s4)
    // Keeps the name readable over a light device screen.
    .background {
      LinearGradient(colors: [Color.black.opacity(0.6), .clear], startPoint: .top, endPoint: .bottom)
        .ignoresSafeArea(edges: .top)
        .allowsHitTesting(false)
    }
  }

  /// A small handle that brings the bar back, so taps on the stream stay with the device.
  private var showControlsButton: some View {
    Button {
      controlsVisible = true
    } label: {
      Image(systemName: "chevron.compact.down")
        .font(.system(size: 22, weight: .semibold))
        .foregroundStyle(Color.weave.muted)
        .frame(width: 64, height: 28)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel("Show device controls")
    .accessibilityIdentifier("device.showControls")
  }

  private var statusOverlay: some View {
    VStack(spacing: WeaveSpacing.s4) {
      if let message = accessError ?? streamError {
        Text(message)
          .weaveFont(.callout)
          .foregroundStyle(Color.weave.muted)
          .multilineTextAlignment(.center)
          .textSelection(.enabled)
        WeaveButton("Reconnect", systemImage: "arrow.clockwise", kind: .secondary) { reconnect() }
          .accessibilityIdentifier("device.reconnect")
      } else {
        ProgressView().tint(Color.weave.muted)
        Text("Connecting to device…")
          .weaveFont(.callout)
          .foregroundStyle(Color.weave.muted)
      }
    }
    .padding(.horizontal, WeaveSpacing.s8)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Color.weave.sunken)
    .accessibilityElement(children: .contain)
  }

  // MARK: Stream

  private func loadAccess() async {
    access = nil
    accessError = nil
    streamError = nil
    status = .connecting
    started = false
    inputConnected = false
    guard let session, !deviceClosed else {
      accessError = closedMessage
      return
    }
    guard Self.script != nil else {
      accessError = "This build is missing the device viewer. Rebuild the app with `make project`."
      return
    }
    do {
      let next = try await model.engine.deviceHubAccess(machineId: route.machineId, hostId: session.hostId)
      guard !Task.isCancelled else { return }
      access = next
    } catch is CancellationError {
    } catch {
      accessError = error.localizedDescription
    }
  }

  private func received(_ message: DeviceStreamMessage) {
    guard streamError == nil else { return }
    switch message {
    case .unauthorized:
      // A refused ticket gets a fresh one; a machine that keeps refusing won't change its mind.
      refusals += 1
      if refusals > 3 {
        fail("This computer refused the device stream. Pair the phone again if this keeps happening.")
      } else {
        attempt += 1
      }
    case .retry:
      processRetried = false
      attempt += 1
    case let .input(connected):
      inputConnected = connected
      // Only a working input socket proves the ticket is accepted; video alone can stream without it.
      if connected { refusals = 0 }
    case let .status(next, detail):
      started = true
      if next == .error {
        fail(detail ?? "Device stream failed.")
      } else {
        status = next
        if next == .streaming { processRetried = false }
      }
    }
  }

  /// The page's process died. One reload, then give up.
  private func processTerminated() {
    // After a failure the error stays up until the person reconnects.
    guard streamError == nil else { return }
    inputConnected = false
    if processRetried {
      fail("Device viewer stopped. Reconnect to try again.")
    } else {
      processRetried = true
      attempt += 1
    }
  }

  private func fail(_ message: String) {
    guard streamError == nil else { return }
    handle.stop()
    inputConnected = false
    streamError = message
    status = .error
    controlsVisible = true
  }

  private func reconnect() {
    refusals = 0
    processRetried = false
    attempt += 1
  }

  // MARK: Support

  /// The bundled stream transport, from `Tools/generate-device-stream.mjs`.
  static let script: String? = Bundle.main.url(forResource: "device-stream", withExtension: "js")
    .flatMap { try? String(contentsOf: $0, encoding: .utf8) }
}

/// Lets the viewer's buttons reach the page.
@MainActor
final class DeviceStreamHandle {
  weak var webView: WKWebView?

  func command(_ command: DeviceCommand) {
    webView?.evaluateJavaScript(DeviceStreamDocument.commandScript(command))
  }

  func stop() {
    webView?.evaluateJavaScript(DeviceStreamDocument.stopScript)
  }
}

/// The page that runs the shared stream transport.
private struct DeviceStreamView: UIViewRepresentable {
  let html: String
  let handle: DeviceStreamHandle
  let onMessage: (DeviceStreamMessage) -> Void
  let onProcessTerminated: () -> Void

  func makeCoordinator() -> Coordinator { Coordinator() }

  func makeUIView(context: Context) -> WKWebView {
    let configuration = WKWebViewConfiguration()
    let content = WKUserContentController()
    content.addUserScript(WKUserScript(source: DeviceStreamDocument.bridgeShim, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    content.add(WeakScriptHandler(context.coordinator), name: DeviceStreamDocument.handlerName)
    configuration.userContentController = content
    configuration.allowsInlineMediaPlayback = true
    configuration.mediaTypesRequiringUserActionForPlayback = []
    configuration.websiteDataStore = .nonPersistent()
    // The page is a local document reaching the machine's hub, as the Expo app's WebView does.
    configuration.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")
    configuration.setValue(true, forKey: "allowUniversalAccessFromFileURLs")

    let webView = WKWebView(frame: .zero, configuration: configuration)
    webView.isOpaque = false
    webView.backgroundColor = .clear
    webView.scrollView.isScrollEnabled = false
    webView.scrollView.bounces = false
    webView.scrollView.contentInsetAdjustmentBehavior = .never
    webView.navigationDelegate = context.coordinator
    context.coordinator.parent = self
    handle.webView = webView
    webView.loadHTMLString(html, baseURL: URL(string: "file:///"))
    return webView
  }

  func updateUIView(_ webView: WKWebView, context: Context) {
    context.coordinator.parent = self
  }

  static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
    coordinator.parent = nil
    webView.evaluateJavaScript(DeviceStreamDocument.stopScript)
    webView.configuration.userContentController.removeScriptMessageHandler(forName: DeviceStreamDocument.handlerName)
  }

  final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
    var parent: DeviceStreamView?

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
      guard let parsed = DeviceStreamMessage.parse(message.body) else { return }
      parent?.onMessage(parsed)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
      // Only the document itself loads in the frame; the stream opens its own connections.
      let url = navigationAction.request.url?.absoluteString
      return url == "about:blank" || url == "file:///" ? .allow : .cancel
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
      parent?.onProcessTerminated()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) {
      parent?.onMessage(.status(.error, detail: "Device viewer could not load. Reconnect to try again."))
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) {
      parent?.onMessage(.status(.error, detail: "Device viewer could not load. Reconnect to try again."))
    }
  }
}

/// `WKUserContentController` keeps its handlers alive; this keeps the coordinator from leaking.
private final class WeakScriptHandler: NSObject, WKScriptMessageHandler {
  weak var target: (any WKScriptMessageHandler)?
  init(_ target: any WKScriptMessageHandler) { self.target = target }

  func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
    target?.userContentController(userContentController, didReceive: message)
  }
}
#else
struct DeviceViewerScreen: View {
  let route: DeviceViewerRoute
  var body: some View { Text("The device viewer runs on iPhone.") }
}
#endif
