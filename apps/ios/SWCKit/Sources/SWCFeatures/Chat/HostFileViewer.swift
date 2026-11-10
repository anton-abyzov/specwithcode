import SwiftUI
import SWCSync
import Weave
#if os(iOS)
import UIKit
import WebKit
#endif

/// A file a reply linked to, by its absolute path on the conversation's machine.
struct HostFileRoute: Identifiable, Hashable {
  let path: String
  var id: String { path }
  var name: String { (path as NSString).lastPathComponent }
}

/// Shows a file from the conversation's machine: pages, pictures and PDFs in a
/// web view with no access to the app's session, Markdown rendered, and other
/// text as monospaced text. The machine signs one URL for the file; nothing
/// is copied to the phone beyond what the view shows.
struct HostFileViewer: View {
  let file: HostFileRoute
  let target: ChatTarget

  @Environment(AppModel.self) private var model
  @Environment(\.dismiss) private var dismiss
  @State private var state: LoadState = .loading
  @State private var attempt = 0

  enum LoadState: Equatable {
    case loading
    case failed(String)
    case web(URL)
    case markdown(String)
    case text(String)
  }

  var body: some View {
    VStack(spacing: 0) {
      header
      Divider()
      content
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    .background(Color.weave.canvas)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("hostFile.viewer")
    .task(id: attempt) { await load() }
  }

  private var header: some View {
    HStack(spacing: WeaveSpacing.s2) {
      VStack(alignment: .leading, spacing: 2) {
        Text(file.name)
          .font(.weave(.headline))
          .foregroundStyle(Color.weave.ink)
          .lineLimit(1)
          .truncationMode(.middle)
        Text(file.path)
          .font(.weave(.caption))
          .foregroundStyle(Color.weave.muted)
          .lineLimit(1)
          .truncationMode(.head)
      }
      Spacer(minLength: 0)
      Button { WeaveClipboard.copyAnnounced(file.path) } label: {
        Image(systemName: "doc.on.doc")
          .frame(width: WeaveSize.minTap, height: WeaveSize.minTap)
          .contentShape(Rectangle())
      }
      .buttonStyle(PressableStyle())
      .accessibilityLabel("Copy path")
      Button { dismiss() } label: {
        Image(systemName: "xmark")
          .font(.system(size: 17, weight: .semibold))
          .frame(width: WeaveSize.minTap, height: WeaveSize.minTap)
          .contentShape(Rectangle())
      }
      .buttonStyle(PressableStyle())
      .accessibilityLabel("Close")
      .accessibilityIdentifier("hostFile.close")
    }
    .foregroundStyle(Color.weave.ink)
    .padding(.leading, WeaveSpacing.s4)
    .padding(.trailing, WeaveSpacing.s2)
    .padding(.vertical, WeaveSpacing.s2)
  }

  @ViewBuilder private var content: some View {
    switch state {
    case .loading:
      ProgressView().accessibilityLabel("Loading \(file.name)")
    case let .failed(message):
      VStack(spacing: WeaveSpacing.s3) {
        Image(systemName: "doc.questionmark")
          .font(.system(size: 32))
          .foregroundStyle(Color.weave.muted)
        Text(message)
          .font(.weave(.callout))
          .foregroundStyle(Color.weave.muted)
          .multilineTextAlignment(.center)
        Button("Try again") { attempt += 1 }
          .font(.weave(.callout))
      }
      .padding(WeaveSpacing.s6)
      .accessibilityIdentifier("hostFile.error")
    case let .web(url):
      HostFileWebView(url: url) { state = .failed($0) }
        .accessibilityIdentifier("hostFile.content")
    case let .markdown(text):
      ScrollView {
        MarkdownText(text)
          .padding(WeaveSpacing.s4)
      }
      .accessibilityIdentifier("hostFile.content")
    case let .text(text):
      ScrollView([.vertical, .horizontal]) {
        Text(text)
          .font(.weave(.code))
          .foregroundStyle(Color.weave.ink)
          .textSelection(.enabled)
          .fixedSize(horizontal: true, vertical: false)
          .padding(WeaveSpacing.s4)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
      .accessibilityIdentifier("hostFile.content")
    }
  }

  private func load() async {
    state = .loading
    guard let kind = HostFileLink.kind(of: file.path) else {
      state = .failed("This kind of file can't be shown here.")
      return
    }
    do {
      guard let url = try await model.engine.hostFileURL(path: file.path, for: target) else {
        state = .failed("This file is on a machine that isn't connected.")
        return
      }
      switch kind {
      case .page, .image, .pdf:
        state = .web(url)
      case .markdown, .text:
        let text = try await Self.fetchText(url)
        state = kind == .markdown ? .markdown(text) : .text(Self.readable(text, path: file.path))
      }
    } catch is CancellationError {
    } catch {
      state = .failed(Self.message(for: error))
    }
  }

  /// Text from the machine, at most 2 MB, over a session that keeps no cookies or cache.
  private static func fetchText(_ url: URL) async throws -> String {
    let session = URLSession(configuration: .ephemeral)
    defer { session.finishTasksAndInvalidate() }
    let limit = 2 * 1024 * 1024
    // One byte past the limit tells a cut file from one that just fits.
    var request = URLRequest(url: url)
    request.setValue("bytes=0-\(limit)", forHTTPHeaderField: "Range")
    let (data, response) = try await session.data(for: request)
    guard let http = response as? HTTPURLResponse else { throw HostFileError.missing }
    // An empty file has no byte 0 to send, so a range request for it is unsatisfiable.
    if http.statusCode == 416 { return "" }
    guard http.statusCode == 200 || http.statusCode == 206 else { throw HostFileError.missing }
    let text = String(decoding: data.prefix(limit), as: UTF8.self)
    return data.count > limit ? text + "\n\n… (showing the first 2 MB)" : text
  }

  /// JSON is pretty-printed when it parses; everything else is shown as written.
  static func readable(_ text: String, path: String) -> String {
    guard (path as NSString).pathExtension.lowercased() == "json",
          let data = text.data(using: .utf8),
          let object = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]),
          let pretty = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]),
          let out = String(data: pretty, encoding: .utf8) else { return text }
    return out
  }

  private static func message(for error: Error) -> String {
    if let error = error as? HostFileError { return error.errorDescription ?? "This file couldn't be opened." }
    return "This file couldn't be opened: \(error.localizedDescription)"
  }
}

enum HostFileError: LocalizedError {
  case missing
  var errorDescription: String? { "The file is missing on that machine, or it can't be shared." }
}

#if os(iOS)
/// A web view with its own throwaway data store and no script bridge. Links that
/// leave the file open in the system browser; the page cannot reach the app.
private struct HostFileWebView: UIViewRepresentable {
  let url: URL
  let onFailure: (String) -> Void

  func makeCoordinator() -> Coordinator { Coordinator(start: url, onFailure: onFailure) }

  func makeUIView(context: Context) -> WKWebView {
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
    configuration.allowsInlineMediaPlayback = true
    let view = WKWebView(frame: .zero, configuration: configuration)
    view.navigationDelegate = context.coordinator
    view.allowsBackForwardNavigationGestures = false
    view.isOpaque = false
    view.backgroundColor = .clear
    view.load(URLRequest(url: url))
    return view
  }

  func updateUIView(_ view: WKWebView, context: Context) {}

  final class Coordinator: NSObject, WKNavigationDelegate {
    private let start: URL
    private let onFailure: (String) -> Void

    init(start: URL, onFailure: @escaping (String) -> Void) {
      self.start = start
      self.onFailure = onFailure
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
      guard action.targetFrame?.isMainFrame != false, let url = action.request.url else { return .allow }
      if Self.sameDocument(url, start) { return .allow }
      if action.navigationType == .linkActivated, let scheme = url.scheme?.lowercased(), ["http", "https", "mailto", "tel"].contains(scheme), url.host != start.host {
        await UIApplication.shared.open(url)
      }
      return .cancel
    }

    /// The file itself, or a jump to an anchor within it.
    static func sameDocument(_ url: URL, _ start: URL) -> Bool {
      func withoutFragment(_ url: URL) -> URL? {
        var parts = URLComponents(url: url, resolvingAgainstBaseURL: false)
        parts?.fragment = nil
        return parts?.url
      }
      return withoutFragment(url) == withoutFragment(start)
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse) async -> WKNavigationResponsePolicy {
      if response.isForMainFrame, let http = response.response as? HTTPURLResponse, http.statusCode >= 400 {
        onFailure(HostFileError.missing.errorDescription ?? "")
        return .cancel
      }
      return .allow
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
      if (error as NSError).code != NSURLErrorCancelled { onFailure("This file couldn't be opened: \(error.localizedDescription)") }
    }
  }
}
#else
/// The Mac build of this package has no viewer of its own; the file opens in the browser.
private struct HostFileWebView: View {
  let url: URL
  let onFailure: (String) -> Void
  var body: some View { Link("Open \(url.lastPathComponent)", destination: url) }
}
#endif
