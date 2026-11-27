import SwiftUI
#if canImport(UIKit)
import UIKit
import WebKit
#endif

/// A Mermaid diagram drawn from a closed ```` ```mermaid ```` fence.
///
/// The diagram source is untrusted text from a model. One shared, off-screen
/// web view holds the bundled Mermaid build (no network) and lays diagrams out
/// one at a time with the web app's settings: strict security, no HTML labels,
/// directives unable to change those. It hands back an SVG, which is shown in
/// small web views that run no JavaScript at all, behind a policy that loads
/// nothing. No page can message the app or navigate anywhere.
public nonisolated enum MermaidConfig {
  /// Keys a diagram's own `%%{init}%%` directive may not change (mirrors
  /// apps/web/src/components/chat/MermaidDiagram.tsx).
  static let secureKeys = [
    "secure", "securityLevel", "startOnLoad", "maxTextSize", "suppressErrorRendering",
    "maxEdges", "htmlLabels", "themeCSS", "themeVariables", "fontFamily",
  ]

  /// Mermaid theme variables from the Weave palette, so a diagram looks like the app.
  static func themeVariables(dark: Bool) -> [String: String] {
    dark ? [
      "background": "transparent",
      "primaryColor": "#2b2340", "primaryBorderColor": "#a88cf6", "primaryTextColor": "#f3eff9",
      "secondaryColor": "#201c29", "secondaryBorderColor": "#776d8a", "secondaryTextColor": "#f3eff9",
      "tertiaryColor": "#110e17", "tertiaryBorderColor": "#544a66", "tertiaryTextColor": "#f3eff9",
      "lineColor": "#a69fb2", "textColor": "#f3eff9", "mainBkg": "#2b2340", "nodeBorder": "#a88cf6",
      "clusterBkg": "#1b1726", "clusterBorder": "#544a66", "edgeLabelBackground": "#16131d",
      "actorBkg": "#2b2340", "actorBorder": "#a88cf6", "actorTextColor": "#f3eff9", "actorLineColor": "#776d8a",
      "signalColor": "#d9d2e6", "signalTextColor": "#f3eff9", "labelBoxBkgColor": "#2b2340",
      "labelBoxBorderColor": "#a88cf6", "labelTextColor": "#f3eff9", "loopTextColor": "#f3eff9",
      "noteBkgColor": "#33270f", "noteBorderColor": "#e8ab3e", "noteTextColor": "#f3eff9",
      "activationBkgColor": "#322c3e", "activationBorderColor": "#a88cf6",
    ] : [
      "background": "transparent",
      "primaryColor": "#ece6f8", "primaryBorderColor": "#6d4fb5", "primaryTextColor": "#241523",
      "secondaryColor": "#f8f7f9", "secondaryBorderColor": "#8c8399", "secondaryTextColor": "#241523",
      "tertiaryColor": "#ffffff", "tertiaryBorderColor": "#dedae5", "tertiaryTextColor": "#241523",
      "lineColor": "#675d69", "textColor": "#241523", "mainBkg": "#ece6f8", "nodeBorder": "#6d4fb5",
      "clusterBkg": "#f8f7f9", "clusterBorder": "#dedae5", "edgeLabelBackground": "#ffffff",
      "actorBkg": "#ece6f8", "actorBorder": "#6d4fb5", "actorTextColor": "#241523", "actorLineColor": "#8c8399",
      "signalColor": "#241523", "signalTextColor": "#241523", "labelBoxBkgColor": "#ece6f8",
      "labelBoxBorderColor": "#6d4fb5", "labelTextColor": "#241523", "loopTextColor": "#241523",
      "noteBkgColor": "#f7ecd9", "noteBorderColor": "#8f5400", "noteTextColor": "#241523",
      "activationBkgColor": "#efedf2", "activationBorderColor": "#6d4fb5",
    ]
  }

  /// The longest source the renderer accepts; longer stays code.
  static let maxSource = 50_000

  /// The script that lays one diagram out and returns `{svg, width, height}`.
  /// It strips scripts and event handlers from the result as a second guard
  /// behind Mermaid's own sanitizer; the viewers run no script either way.
  static let bootstrap = #"""
  window.__swcRender = async function (source, dark, vars, secure) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      secure: secure,
      htmlLabels: false,
      flowchart: { htmlLabels: false, useMaxWidth: false },
      sequence: { useMaxWidth: false },
      gantt: { useMaxWidth: false },
      class: { useMaxWidth: false },
      state: { useMaxWidth: false },
      er: { useMaxWidth: false },
      pie: { useMaxWidth: false },
      journey: { useMaxWidth: false },
      mindmap: { useMaxWidth: false },
      theme: "base",
      themeVariables: vars,
      fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
    });
    window.__swcCount = (window.__swcCount || 0) + 1;
    const id = "swc-mermaid-" + window.__swcCount;
    try {
      const result = await mermaid.render(id, source);
      const doc = new DOMParser().parseFromString(result.svg, "image/svg+xml");
      const svg = doc.documentElement;
      if (!svg || svg.nodeName.toLowerCase() !== "svg") throw new Error("Mermaid returned no picture.");
      svg.querySelectorAll("script").forEach(function (node) { node.remove(); });
      svg.querySelectorAll("*").forEach(function (node) {
        Array.from(node.attributes).forEach(function (attribute) {
          const name = attribute.name.toLowerCase();
          const value = String(attribute.value).trim().toLowerCase();
          if (name.indexOf("on") === 0) node.removeAttribute(attribute.name);
          if ((name === "href" || name === "xlink:href") && value.indexOf("#") !== 0 && value.indexOf("data:image/") !== 0) node.removeAttribute(attribute.name);
        });
      });
      let width = 0, height = 0;
      const box = (svg.getAttribute("viewBox") || "").split(/[\s,]+/).map(Number);
      if (box.length === 4 && box[2] > 0 && box[3] > 0) { width = box[2]; height = box[3]; }
      if (!width || !height) {
        width = parseFloat(svg.getAttribute("width")) || 600;
        height = parseFloat(svg.getAttribute("height")) || 400;
      }
      svg.removeAttribute("style");
      svg.setAttribute("width", String(width));
      svg.setAttribute("height", String(height));
      return { svg: new XMLSerializer().serializeToString(svg), width: width, height: height };
    } finally {
      const left = document.getElementById("d" + id);
      if (left) left.remove();
      const own = document.getElementById(id);
      if (own) own.remove();
    }
  };
  """#

  /// A page that shows one SVG and nothing else: no scripts, no requests.
  static func page(svg: String, zoomable: Bool) -> String {
    let viewport = zoomable
      ? "width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=8, user-scalable=yes"
      : "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no"
    let layout = zoomable
      ? "html,body{height:100%;}body{display:flex;align-items:center;justify-content:center;}svg{width:100%;height:auto;max-height:100%;}"
      : "svg{width:100%;height:100%;}"
    return """
    <!doctype html><html><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">
    <meta name="viewport" content="\(viewport)">
    <style>html,body{margin:0;padding:0;background:transparent;-webkit-user-select:none;-webkit-touch-callout:none;}svg{display:block;}\(layout)</style>
    </head><body>\(svg)</body></html>
    """
  }
}

/// A finished diagram: the SVG and its natural size in points.
public nonisolated struct MermaidDiagram: Equatable, Sendable {
  public let svg: String
  public let size: CGSize
}

public nonisolated enum MermaidOutcome: Equatable, Sendable {
  case diagram(MermaidDiagram)
  case failure(String)
}

#if canImport(UIKit)
/// Lays diagrams out one at a time in a shared off-screen web view and keeps
/// the results, so a transcript that redraws rows never lays one out twice.
@MainActor
public final class MermaidRenderer: NSObject, WKNavigationDelegate {
  public static let shared = MermaidRenderer()

  private struct Key: Hashable {
    let source: String
    let dark: Bool
  }

  private static let world = WKContentWorld.world(name: "swc-mermaid")
  private static let cacheLimit = 80

  private var cache: [Key: MermaidOutcome] = [:]
  private var order: [Key] = []
  private var inflight: [Key: Task<MermaidOutcome, Never>] = [:]
  private var tail: Task<MermaidOutcome, Never>?
  private var webView: WKWebView?
  private var loaded: [CheckedContinuation<Bool, Never>] = []
  private var isLoaded = false
  private var loadFailed = false

  /// A finished result, without waiting.
  public func cached(_ source: String, dark: Bool) -> MermaidOutcome? {
    cache[Key(source: source, dark: dark)]
  }

  public func render(_ source: String, dark: Bool) async -> MermaidOutcome {
    let key = Key(source: source, dark: dark)
    if let hit = cache[key] { return hit }
    if let running = inflight[key] { return await running.value }
    let previous = tail
    let task = Task { @MainActor [weak self] () -> MermaidOutcome in
      _ = await previous?.value
      guard let self else { return .failure("The diagram couldn't be drawn.") }
      return await self.perform(key)
    }
    inflight[key] = task
    tail = task
    let outcome = await task.value
    inflight[key] = nil
    store(outcome, for: key)
    return outcome
  }

  private func store(_ outcome: MermaidOutcome, for key: Key) {
    if cache[key] == nil { order.append(key) }
    cache[key] = outcome
    while order.count > Self.cacheLimit { cache[order.removeFirst()] = nil }
  }

  private func perform(_ key: Key) async -> MermaidOutcome {
    guard key.source.count <= MermaidConfig.maxSource else { return .failure("This diagram is too long to draw here.") }
    guard await ensureLoaded(), let webView else { return .failure("The diagram renderer couldn't start.") }
    do {
      let value = try await webView.callAsyncJavaScript(
        "return await window.__swcRender(source, dark, vars, secure);",
        arguments: [
          "source": key.source,
          "dark": key.dark,
          "vars": MermaidConfig.themeVariables(dark: key.dark),
          "secure": MermaidConfig.secureKeys,
        ],
        in: nil,
        contentWorld: Self.world
      )
      guard let result = value as? [String: Any], let svg = result["svg"] as? String,
            let width = (result["width"] as? NSNumber)?.doubleValue, let height = (result["height"] as? NSNumber)?.doubleValue,
            width > 0, height > 0 else { return .failure("Mermaid returned no picture.") }
      return .diagram(MermaidDiagram(svg: svg, size: CGSize(width: width, height: height)))
    } catch {
      return .failure(Self.message(error))
    }
  }

  /// Mermaid's own error text, first line, without WebKit's wrapping.
  static func message(_ error: Error) -> String {
    let info = (error as NSError).userInfo
    let raw = (info["WKJavaScriptExceptionMessage"] as? String) ?? error.localizedDescription
    let first = raw.split(separator: "\n").first.map(String.init) ?? raw
    let trimmed = first.replacingOccurrences(of: "Error: ", with: "")
    return trimmed.count > 160 ? String(trimmed.prefix(159)) + "…" : trimmed
  }

  private func ensureLoaded() async -> Bool {
    if isLoaded { return true }
    if loadFailed { return false }
    if webView == nil { start() }
    guard webView != nil else { return false }
    return await withCheckedContinuation { loaded.append($0) }
  }

  private func start() {
    guard let url = Bundle.module.url(forResource: "mermaid.min", withExtension: "js")
            ?? Bundle.module.url(forResource: "mermaid.min", withExtension: "js", subdirectory: "Mermaid"),
          let library = try? String(contentsOf: url, encoding: .utf8) else {
      loadFailed = true
      return
    }
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
    // The page itself runs nothing; Mermaid lives in its own content world.
    let controller = WKUserContentController()
    controller.addUserScript(WKUserScript(source: library, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: Self.world))
    controller.addUserScript(WKUserScript(source: MermaidConfig.bootstrap, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: Self.world))
    configuration.userContentController = controller
    let view = WKWebView(frame: CGRect(x: 0, y: 0, width: 1024, height: 768), configuration: configuration)
    view.navigationDelegate = self
    webView = view
    let page = """
    <!doctype html><html><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">
    </head><body></body></html>
    """
    view.loadHTMLString(page, baseURL: nil)
  }

  private func finishLoading(_ ok: Bool) {
    isLoaded = ok
    loadFailed = !ok
    if !ok { webView = nil }
    let waiting = loaded
    loaded = []
    waiting.forEach { $0.resume(returning: ok) }
  }

  public func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
    // Only the blank page this renderer loads itself.
    !isLoaded && action.request.url?.absoluteString == "about:blank" ? .allow : .cancel
  }

  public func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    if !isLoaded { finishLoading(true) }
  }

  public func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    if !isLoaded { finishLoading(false) }
  }

  public func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    if !isLoaded { finishLoading(false) }
  }

  public func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    // Start over on the next diagram.
    self.webView = nil
    isLoaded = false
    loadFailed = false
  }
}

/// Shows one SVG in a web view that runs no JavaScript and loads nothing.
struct MermaidSVGView: UIViewRepresentable {
  let svg: String
  let zoomable: Bool

  func makeCoordinator() -> Coordinator { Coordinator() }

  func makeUIView(context: Context) -> WKWebView {
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    configuration.defaultWebpagePreferences.allowsContentJavaScript = false
    configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
    configuration.dataDetectorTypes = []
    let view = WKWebView(frame: .zero, configuration: configuration)
    view.navigationDelegate = context.coordinator
    view.isOpaque = false
    view.backgroundColor = .clear
    view.scrollView.backgroundColor = .clear
    view.scrollView.contentInsetAdjustmentBehavior = .never
    view.allowsLinkPreview = false
    if zoomable {
      view.scrollView.bouncesZoom = true
    } else {
      view.isUserInteractionEnabled = false
      view.scrollView.isScrollEnabled = false
    }
    load(view, context: context)
    return view
  }

  func updateUIView(_ view: WKWebView, context: Context) {
    if context.coordinator.svg != svg { load(view, context: context) }
  }

  private func load(_ view: WKWebView, context: Context) {
    context.coordinator.svg = svg
    context.coordinator.allowNext = true
    view.loadHTMLString(MermaidConfig.page(svg: svg, zoomable: zoomable), baseURL: nil)
  }

  final class Coordinator: NSObject, WKNavigationDelegate {
    var svg = ""
    var allowNext = false

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
      // The page this view loads, once; nothing a diagram links to.
      guard allowNext, action.request.url?.absoluteString == "about:blank" else { return .cancel }
      allowNext = false
      return .allow
    }
  }
}
#endif

/// A diagram in a reply or a document: drawn to fit the width, tap for a
/// full-screen view that zooms, with the source one tap away. While it draws
/// it holds the space a cached result needs, so the transcript does not jump.
public struct MermaidDiagramView: View {
  let source: String

  @Environment(\.colorScheme) private var colorScheme
  @State private var outcome: MermaidOutcome?
  @State private var showsSource = false
  @State private var expanded = false
  @State private var copied = false

  /// The tallest a diagram stands in a reply; taller ones shrink to fit and zoom full screen.
  static let maxHeight: CGFloat = 520

  public init(source: String) {
    self.source = source
  }

  private var dark: Bool { colorScheme == .dark }

  public var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      header
      content
    }
    .background(Color.weave.panel, in: RoundedRectangle(cornerRadius: WeaveRadius.md, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: WeaveRadius.md, style: .continuous).strokeBorder(Color.weave.line, lineWidth: WeaveSize.hairline))
    .task(id: "\(dark)\n\(source)") { await draw() }
    #if os(iOS)
    .fullScreenCover(isPresented: $expanded) {
      if case let .diagram(diagram) = current {
        MermaidFullScreen(diagram: diagram, source: source)
      }
    }
    #endif
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("markdown.mermaid")
  }

  /// The result for this scheme: a cached one is shown at once, with no flash.
  private var current: MermaidOutcome? {
    #if canImport(UIKit)
    if let hit = MermaidRenderer.shared.cached(source, dark: dark) { return hit }
    #endif
    return outcome
  }

  private var header: some View {
    HStack(spacing: 0) {
      Label("Diagram", systemImage: "point.3.connected.trianglepath.dotted")
        .labelStyle(.titleAndIcon)
        .font(.weave(.caption))
        .foregroundStyle(Color.weave.muted)
      Spacer()
      if case .diagram = current {
        iconButton(showsSource ? "chart.bar.doc.horizontal" : "chevron.left.forwardslash.chevron.right",
                   label: showsSource ? "Show diagram" : "Show source") {
          showsSource.toggle()
        }
        iconButton("arrow.up.left.and.arrow.down.right", label: "Open diagram full screen") { expanded = true }
      }
      iconButton(copied ? "checkmark" : "doc.on.doc", label: "Copy diagram source", tint: copied ? Color.weave.pass : nil) {
        WeaveClipboard.copyAnnounced(source)
        copied = true
      }
      .task(id: copied) {
        guard copied else { return }
        try? await Task.sleep(for: .seconds(2))
        copied = false
      }
    }
    .padding(.leading, WeaveSpacing.s3)
  }

  private func iconButton(_ symbol: String, label: String, tint: Color? = nil, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Image(systemName: symbol)
        .font(.system(size: 13))
        .foregroundStyle(tint ?? Color.weave.muted)
        .frame(width: WeaveSize.minTap, height: WeaveSize.minTap)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(label)
  }

  @ViewBuilder private var content: some View {
    switch current {
    case let .diagram(diagram) where !showsSource:
      picture(diagram)
    case let .failure(message):
      VStack(alignment: .leading, spacing: WeaveSpacing.s2) {
        Label("Couldn't draw this diagram: \(message)", systemImage: "exclamationmark.triangle")
          .font(.weave(.caption))
          .foregroundStyle(Color.weave.warn)
          .fixedSize(horizontal: false, vertical: true)
        sourceText
      }
      .padding(.horizontal, WeaveSpacing.s3)
      .padding(.bottom, WeaveSpacing.s3)
    case .diagram:
      sourceText
        .padding(.horizontal, WeaveSpacing.s3)
        .padding(.bottom, WeaveSpacing.s3)
    case nil:
      ProgressView()
        .frame(maxWidth: .infinity, minHeight: 160)
        .accessibilityLabel("Drawing the diagram")
    }
  }

  private var sourceText: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      Text(source)
        .weaveFont(.code)
        .foregroundStyle(Color.weave.ink)
        .fixedSize(horizontal: true, vertical: true)
        .textSelection(.enabled)
    }
  }

  @ViewBuilder private func picture(_ diagram: MermaidDiagram) -> some View {
    #if canImport(UIKit)
    let ratio = diagram.size.width / max(diagram.size.height, 1)
    MermaidSVGView(svg: diagram.svg, zoomable: false)
      // Never wider than drawn, never taller than maxHeight: the ratio sets the rest.
      .aspectRatio(ratio, contentMode: .fit)
      .frame(maxWidth: diagram.size.width, maxHeight: min(diagram.size.height, Self.maxHeight))
      .frame(maxWidth: .infinity)
      .padding(.horizontal, WeaveSpacing.s3)
      .padding(.bottom, WeaveSpacing.s3)
      .contentShape(Rectangle())
      .onTapGesture { expanded = true }
      .accessibilityElement()
      .accessibilityLabel("Diagram")
      .accessibilityHint("Opens the diagram full screen")
      .accessibilityAddTraits(.isButton)
    #else
    sourceText.padding(WeaveSpacing.s3)
    #endif
  }

  private func draw() async {
    #if canImport(UIKit)
    if let hit = MermaidRenderer.shared.cached(source, dark: dark) {
      outcome = hit
      return
    }
    outcome = nil
    let result = await MermaidRenderer.shared.render(source, dark: dark)
    guard !Task.isCancelled else { return }
    outcome = result
    #else
    outcome = .failure("Diagrams draw on iPhone and iPad.")
    #endif
  }
}

#if os(iOS)
/// The diagram on its own: pinch to zoom up to 8x, drag to pan, the source a tap away.
private struct MermaidFullScreen: View {
  let diagram: MermaidDiagram
  let source: String

  @Environment(\.dismiss) private var dismiss
  @State private var showsSource = false

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 0) {
        Text("Diagram")
          .font(.weave(.headline))
          .foregroundStyle(Color.weave.ink)
        Spacer()
        Button { showsSource.toggle() } label: {
          Image(systemName: showsSource ? "chart.bar.doc.horizontal" : "chevron.left.forwardslash.chevron.right")
            .frame(width: WeaveSize.minTap, height: WeaveSize.minTap)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(showsSource ? "Show diagram" : "Show source")
        Button { WeaveClipboard.copyAnnounced(source) } label: {
          Image(systemName: "doc.on.doc")
            .frame(width: WeaveSize.minTap, height: WeaveSize.minTap)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Copy diagram source")
        Button { dismiss() } label: {
          Image(systemName: "xmark")
            .font(.system(size: 17, weight: .semibold))
            .frame(width: WeaveSize.minTap, height: WeaveSize.minTap)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Close")
        .accessibilityIdentifier("mermaid.close")
      }
      .foregroundStyle(Color.weave.ink)
      .padding(.leading, WeaveSpacing.s4)
      .padding(.trailing, WeaveSpacing.s2)
      .padding(.vertical, WeaveSpacing.s2)
      Divider()
      if showsSource {
        ScrollView([.vertical, .horizontal]) {
          Text(source)
            .weaveFont(.code)
            .foregroundStyle(Color.weave.ink)
            .textSelection(.enabled)
            .fixedSize()
            .padding(WeaveSpacing.s4)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
      } else {
        MermaidSVGView(svg: diagram.svg, zoomable: true)
          .padding(WeaveSpacing.s2)
          .accessibilityLabel("Diagram, pinch to zoom")
          .accessibilityIdentifier("mermaid.fullscreen")
      }
    }
    .background(Color.weave.canvas.ignoresSafeArea())
  }
}
#endif
