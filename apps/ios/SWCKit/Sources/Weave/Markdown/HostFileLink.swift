import Foundation

/// A file on the conversation's machine that a reply links to, such as
/// `[cue-sheet.html](/Users/me/cue-sheet.html)` or a backticked absolute path.
/// The app opens it in its own viewer, fetched from that machine, and never
/// hands the path to the system.
public nonisolated enum HostFileLink {
  /// The internal scheme a link carries between the renderer and the chat.
  static let scheme = "swc-file"

  public enum Kind: Equatable, Sendable {
    case page, markdown, text, image, pdf
  }

  private static let kinds: [String: Kind] = [
    "html": .page, "htm": .page, "svg": .image,
    "md": .markdown, "markdown": .markdown,
    "txt": .text, "log": .text, "json": .text, "jsonl": .text, "csv": .text, "tsv": .text,
    "yaml": .text, "yml": .text, "xml": .text, "toml": .text,
    "png": .image, "jpg": .image, "jpeg": .image, "gif": .image, "webp": .image, "avif": .image,
    "pdf": .pdf,
  ]

  /// What the viewer does with a path, or nil when it cannot show it.
  public static func kind(of path: String) -> Kind? {
    let name = (path as NSString).lastPathComponent
    let ext = (name as NSString).pathExtension.lowercased()
    return ext.isEmpty ? nil : kinds[ext]
  }

  /// An absolute host path the viewer can show, from a written path or a `file://` URL.
  public static func hostPath(_ written: String) -> String? {
    let trimmed = written.trimmingCharacters(in: .whitespacesAndNewlines)
    var path: String
    if trimmed.lowercased().hasPrefix("file://") {
      guard let url = URL(string: trimmed), url.host == nil || url.host == "" || url.host == "localhost" else { return nil }
      path = url.path
    } else {
      path = trimmed.removingPercentEncoding ?? trimmed
    }
    // A trailing `:12` or `#L12` names a line; the file is what opens.
    if let hash = path.firstIndex(of: "#") { path = String(path[..<hash]) }
    if let range = path.range(of: #":\d+(:\d+)?$"#, options: .regularExpression) { path.removeSubrange(range) }
    guard path.hasPrefix("/"), !path.hasPrefix("//"), path.count > 1,
          !path.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) || CharacterSet.newlines.contains($0) }),
          !path.split(separator: "/").contains(".."),
          kind(of: path) != nil else { return nil }
    return path
  }

  /// The internal link for a host path.
  public static func url(for path: String) -> URL? {
    var parts = URLComponents()
    parts.scheme = scheme
    parts.path = path
    return parts.url
  }

  /// The host path an internal link names, or nil for any other URL.
  public static func path(_ url: URL) -> String? {
    guard url.scheme?.lowercased() == scheme,
          let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
          parts.host == nil || parts.host == "" else { return nil }
    return hostPath(parts.path)
  }

  /// The internal link for a Markdown link target, when it names a host file.
  static func link(forTarget url: URL) -> URL? {
    if url.scheme == nil || url.scheme?.lowercased() == "file" {
      let written = url.scheme == nil ? url.relativeString : url.absoluteString
      return hostPath(written).flatMap(Self.url(for:))
    }
    return nil
  }
}
