import SwiftUI

/// Where a Markdown image's bytes come from.
public nonisolated enum MarkdownImageSource: Hashable, Sendable {
  /// A picture on the web, loaded directly.
  case web(URL)
  /// A picture on the conversation's machine, by absolute path. The machine
  /// signs a URL for it; the path itself never reaches an image loader.
  case host(String)
}

/// Pictures in a reply: `![caption](/absolute/path)` and `![caption](https://…)`
/// as blocks of their own, and the one picture a reply names only by path.
public nonisolated enum MarkdownMedia {
  /// A piece of a paragraph once its images are lifted out.
  enum Piece: Hashable, Sendable {
    case text(String)
    case image(alt: String, source: MarkdownImageSource)
  }

  /// Formats the image view can draw. SVG opens in the file viewer instead.
  private static let drawable: Set<String> = ["png", "jpg", "jpeg", "gif", "webp", "avif", "heic"]

  private static let imagePattern = try! NSRegularExpression(pattern: #"!\[([^\]\n]*)\]\(\s*(<[^>\n]+>|[^)\s]+)(?:\s+"[^"\n]*")?\s*\)"#)
  private static let codePattern = try! NSRegularExpression(pattern: #"(`+)[^\n]*?[^`\n]\1(?!`)"#)
  private static let linkPattern = try! NSRegularExpression(pattern: #"\[(?:[^\]\\\n]|\\.)*\]\(\s*(<[^>\n]+>|[^)\s]+)[^)\n]*\)"#)
  private static let linkClosePattern = try! NSRegularExpression(pattern: #"\]\([^)\n]*\)"#)
  private static let htmlMediaPattern = try! NSRegularExpression(pattern: #"<(?:img|video|picture)\b"#, options: .caseInsensitive)

  /// The source an image target names, or nil when the app cannot show it:
  /// a relative path, another scheme, or a format it does not draw.
  public static func source(_ written: String) -> MarkdownImageSource? {
    var target = written.trimmingCharacters(in: .whitespaces)
    if target.hasPrefix("<"), target.hasSuffix(">") { target = String(target.dropFirst().dropLast()) }
    let lower = target.lowercased()
    if lower.hasPrefix("http://") || lower.hasPrefix("https://") {
      return URL(string: target).map(MarkdownImageSource.web)
    }
    return hostImagePath(target, decode: true).map(MarkdownImageSource.host)
  }

  /// An absolute path on the machine to a picture the image view can draw.
  static func hostImagePath(_ written: String, decode: Bool) -> String? {
    guard let path = HostFileLink.hostPath(written, decode: decode), HostFileLink.kind(of: path) == .image,
          drawable.contains((path as NSString).pathExtension.lowercased()) else { return nil }
    return path
  }

  /// A paragraph split around the images it embeds. An image the app cannot
  /// show, or one quoted as code, stays in the text as written.
  static func pieces(_ paragraph: String) -> [Piece] {
    guard paragraph.contains("![") else { return [.text(paragraph)] }
    let text = paragraph as NSString
    let whole = NSRange(location: 0, length: text.length)
    let code = codePattern.matches(in: paragraph, range: whole).map(\.range)
    var pieces: [Piece] = []
    var cursor = 0

    func appendText(upTo end: Int) {
      let chunk = text.substring(with: NSRange(location: cursor, length: max(0, end - cursor))).trimmingCharacters(in: .whitespacesAndNewlines)
      if !chunk.isEmpty { pieces.append(.text(chunk)) }
    }

    for match in imagePattern.matches(in: paragraph, range: whole) {
      guard match.range.location >= cursor,
            !code.contains(where: { NSIntersectionRange($0, match.range).length > 0 }),
            let source = source(text.substring(with: match.range(at: 2))) else { continue }
      var range = match.range
      // `[![alt](image)](link)`: the picture shows; its wrapper is not text.
      if range.location > 0, text.character(at: range.location - 1) == 0x5B /* [ */ {
        let rest = NSRange(location: NSMaxRange(range), length: text.length - NSMaxRange(range))
        if let close = linkClosePattern.firstMatch(in: paragraph, options: .anchored, range: rest) {
          range = NSRange(location: range.location - 1, length: NSMaxRange(close.range) - range.location + 1)
        }
      }
      appendText(upTo: range.location)
      pieces.append(.image(alt: text.substring(with: match.range(at: 1)), source: source))
      cursor = NSMaxRange(range)
    }
    appendText(upTo: text.length)
    return pieces
  }

  /// The first picture a reply names by absolute path, in a code span or a
  /// link, when the reply embeds no media of its own. Agents usually report a
  /// screenshot as a path in backticks, which shows no picture on a phone; the
  /// chat shows this one file as a thumbnail under the reply. Nil when the
  /// reply already embeds an image or video (what the author embedded wins),
  /// and nil when it names none. Fenced code is skipped: a path in a log or a
  /// script is not a result.
  public static func firstUnembeddedImage(in blocks: [MarkdownBlock]) -> String? {
    var texts: [String] = []
    guard collect(blocks, into: &texts) else { return nil }
    var first: String?
    for text in texts {
      guard text.contains("/") || text.contains("<") || text.contains("![") else { continue }
      let whole = NSRange(location: 0, length: (text as NSString).length)
      let code = codePattern.matches(in: text, range: whole).map(\.range)
      let inCode: (NSRange) -> Bool = { range in code.contains { NSIntersectionRange($0, range).length > 0 } }
      // An image left in the text, such as one with a relative source, is still the author's embed.
      if imagePattern.matches(in: text, range: whole).contains(where: { !inCode($0.range) }) { return nil }
      if htmlMediaPattern.matches(in: text, range: whole).contains(where: { !inCode($0.range) }) { return nil }
      guard first == nil else { continue }
      let nsText = text as NSString
      var found: [(Int, String)] = []
      for match in code {
        let span = nsText.substring(with: match).trimmingCharacters(in: CharacterSet(charactersIn: "`"))
        if let path = hostImagePath(span, decode: false) { found.append((match.location, path)) }
      }
      for match in linkPattern.matches(in: text, range: whole) where !inCode(match.range) {
        var target = nsText.substring(with: match.range(at: 1))
        if target.hasPrefix("<"), target.hasSuffix(">") { target = String(target.dropFirst().dropLast()) }
        if let path = hostImagePath(target, decode: true) { found.append((match.range.location, path)) }
      }
      first = found.min { $0.0 < $1.0 }?.1
    }
    return first
  }

  /// `firstUnembeddedImage` for a finished reply, remembered per source text:
  /// a view body runs on every layout pass.
  public static func fallbackImage(for markdown: String) -> String? {
    guard markdown.contains("/") else { return nil }
    let key = markdown as NSString
    if let hit = fallbackCache.object(forKey: key) { return hit.length == 0 ? nil : hit as String }
    let path = firstUnembeddedImage(in: MarkdownParser.cachedParse(markdown))
    fallbackCache.setObject((path ?? "") as NSString, forKey: key)
    return path
  }

  private nonisolated(unsafe) static let fallbackCache: NSCache<NSString, NSString> = {
    let cache = NSCache<NSString, NSString>()
    cache.countLimit = 400
    return cache
  }()

  /// Gathers the prose of `blocks` in order. False when a block is an embedded image.
  private static func collect(_ blocks: [MarkdownBlock], into texts: inout [String]) -> Bool {
    for block in blocks {
      switch block {
      case .image: return false
      case let .heading(_, text), let .paragraph(text): texts.append(text)
      case let .list(items): texts.append(contentsOf: items.map(\.text))
      case let .quote(inner): if !collect(inner, into: &texts) { return false }
      case let .table(header, rows): texts.append(contentsOf: header + rows.flatMap { $0 })
      case .code, .rule: continue
      }
    }
    return true
  }
}

/// How a chat loads and opens pictures on its machine. Set by the screen that
/// knows the conversation; without it a host picture reads as unavailable.
public nonisolated struct MarkdownImageLoader: Sendable {
  /// A signed URL for a picture by absolute path; `thumbnail` asks for a
  /// downscaled copy. Nil when the machine cannot serve it.
  public let url: @MainActor @Sendable (_ path: String, _ thumbnail: Bool) async -> URL?
  /// Opens the file itself in the viewer.
  public let open: @MainActor @Sendable (_ path: String) -> Void
  /// Changes with the connection, so a picture that failed loads after a reconnect.
  public let connection: String

  public init(connection: String, url: @escaping @MainActor @Sendable (String, Bool) async -> URL?, open: @escaping @MainActor @Sendable (String) -> Void) {
    self.connection = connection
    self.url = url
    self.open = open
  }
}

private nonisolated struct MarkdownImageLoaderKey: EnvironmentKey {
  static let defaultValue: MarkdownImageLoader? = nil
}

public extension EnvironmentValues {
  var markdownImageLoader: MarkdownImageLoader? {
    get { self[MarkdownImageLoaderKey.self] }
    set { self[MarkdownImageLoaderKey.self] = newValue }
  }
}

/// One picture in a reply. A web picture loads directly; a host picture loads
/// through a URL its machine signs. A tap opens the file itself.
struct MarkdownImageView: View {
  let alt: String
  let source: MarkdownImageSource
  /// The reply only named this file: load a downscaled copy, keep it small,
  /// and show nothing at all when the machine cannot serve it.
  var isFallback = false

  @Environment(\.markdownImageLoader) private var loader
  @Environment(\.openURL) private var openURL
  @State private var url: URL?
  @State private var failed = false

  private var maxHeight: CGFloat { isFallback ? 220 : 420 }

  var body: some View {
    if failed, isFallback {
      EmptyView()
    } else {
      VStack(alignment: .leading, spacing: WeaveSpacing.s1) {
        Button(action: open) { picture }
          .buttonStyle(.plain)
          .disabled(failed || url == nil)
          .accessibilityLabel(alt.isEmpty ? "Image" : "Image, \(alt)")
          .accessibilityHint(failed ? "" : "Opens the image")
          .accessibilityIdentifier(isFallback ? "markdown.mediaFallback" : "markdown.image")
        if !alt.isEmpty, !isFallback {
          Text(alt)
            .weaveFont(.caption)
            .foregroundStyle(Color.weave.muted)
        }
      }
      .task(id: "\(source)|\(loader?.connection ?? "")") { await load() }
    }
  }

  @ViewBuilder private var picture: some View {
    if failed {
      Label("Image unavailable", systemImage: "photo")
        .font(.weave(.callout))
        .foregroundStyle(Color.weave.muted)
        .padding(WeaveSpacing.s3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.weave.sunken, in: RoundedRectangle(cornerRadius: WeaveRadius.md, style: .continuous))
    } else if let url {
      AsyncImage(url: url) { phase in
        switch phase {
        case let .success(image):
          image.resizable().scaledToFit()
            .clipShape(RoundedRectangle(cornerRadius: WeaveRadius.md, style: .continuous))
        case .failure:
          placeholder.onAppear { failed = true }
        default:
          placeholder.overlay { ProgressView() }
        }
      }
      .frame(maxWidth: 520, maxHeight: maxHeight, alignment: .leading)
    } else {
      placeholder.overlay { ProgressView() }
    }
  }

  private var placeholder: some View {
    RoundedRectangle(cornerRadius: WeaveRadius.md, style: .continuous)
      .fill(Color.weave.sunken)
      .frame(maxWidth: 520)
      .frame(height: isFallback ? 140 : 180)
  }

  private func open() {
    switch source {
    case let .web(link): openURL(link)
    case let .host(path): loader?.open(path)
    }
  }

  private func load() async {
    switch source {
    case let .web(link):
      url = link
    case let .host(path):
      guard let loader else {
        failed = true
        return
      }
      url = nil
      failed = false
      let signed = await loader.url(path, isFallback)
      guard !Task.isCancelled else { return }
      url = signed
      failed = signed == nil
    }
  }
}
