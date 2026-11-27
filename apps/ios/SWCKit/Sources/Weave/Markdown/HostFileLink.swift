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
    /// Comma- or tab-separated values, shown as a table.
    case sheet
    /// An Excalidraw scene, drawn natively.
    case whiteboard
  }

  private static let kinds: [String: Kind] = [
    "html": .page, "htm": .page, "svg": .image,
    "md": .markdown, "markdown": .markdown,
    "txt": .text, "log": .text, "json": .text, "jsonl": .text, "csv": .sheet, "tsv": .sheet, "excalidraw": .whiteboard,
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
  /// `decode` is for link targets, which arrive percent-encoded; a backticked path
  /// or an already decoded URL path is taken literally.
  public static func hostPath(_ written: String, decode: Bool = true) -> String? {
    let trimmed = written.trimmingCharacters(in: .whitespacesAndNewlines)
    var path: String
    if trimmed.lowercased().hasPrefix("file://") {
      guard let url = URL(string: trimmed), url.host == nil || url.host == "" || url.host == "localhost" else { return nil }
      path = url.path
    } else {
      path = decode ? (trimmed.removingPercentEncoding ?? trimmed) : trimmed
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

  private static let inlineLink = try! NSRegularExpression(pattern: #"(\]\()([^)\s]+)((?:\s+"[^"]*")?\))"#)
  private static let fence = try! NSRegularExpression(pattern: #"\A[ \t]{0,3}(`{3,}|~{3,})"#)

  /// A file's Markdown with its relative links (`../spec.md`, `notes.md`)
  /// made absolute against the file's own folder, the way a document viewer
  /// follows them, so a report's links open the file they name. Links with a
  /// scheme, absolute paths, anchors and anything in a code fence stay as
  /// written; so does a target that climbs above the root.
  public static func resolvingRelativeLinks(_ markdown: String, from documentPath: String) -> String {
    guard documentPath.hasPrefix("/"), markdown.contains("](") else { return markdown }
    let folder = (documentPath as NSString).deletingLastPathComponent
    var fenceMarker: String?
    var lines: [String] = []
    for line in markdown.components(separatedBy: "\n") {
      let ns = line as NSString
      if let match = fence.firstMatch(in: line, range: NSRange(location: 0, length: ns.length)) {
        let marker = ns.substring(with: match.range(at: 1))
        if let open = fenceMarker {
          if marker.first == open.first, marker.count >= open.count { fenceMarker = nil }
        } else {
          fenceMarker = marker
        }
        lines.append(line)
        continue
      }
      guard fenceMarker == nil, line.contains("](") else {
        lines.append(line)
        continue
      }
      var rewritten = line
      for match in inlineLink.matches(in: line, range: NSRange(location: 0, length: ns.length)).reversed() {
        let target = ns.substring(with: match.range(at: 2))
        guard let absolute = absoluteTarget(target, folder: folder),
              let range = Range(match.range(at: 2), in: rewritten) else { continue }
        rewritten.replaceSubrange(range, with: absolute)
      }
      lines.append(rewritten)
    }
    return lines.joined(separator: "\n")
  }

  private static func absoluteTarget(_ target: String, folder: String) -> String? {
    if target.hasPrefix("/") || target.hasPrefix("#") || target.hasPrefix("<") { return nil }
    if target.range(of: #"\A[A-Za-z][A-Za-z0-9+.-]*:"#, options: .regularExpression) != nil { return nil }
    var path = target
    var suffix = ""
    if let hash = path.firstIndex(of: "#") {
      suffix = String(path[hash...])
      path = String(path[..<hash])
    }
    guard !path.isEmpty, kind(of: path.removingPercentEncoding ?? path) != nil else { return nil }
    var parts = folder.split(separator: "/").map(String.init)
    for component in path.split(separator: "/", omittingEmptySubsequences: true) {
      switch component {
      case ".": continue
      case "..":
        guard !parts.isEmpty else { return nil }
        parts.removeLast()
      default: parts.append(String(component))
      }
    }
    let encodedFolderParts = parts.map { part in
      // Folder names arrive literal and target names percent-encoded; encode
      // only what would end the link.
      part.replacingOccurrences(of: " ", with: "%20").replacingOccurrences(of: "(", with: "%28").replacingOccurrences(of: ")", with: "%29")
    }
    return "/" + encodedFolderParts.joined(separator: "/") + suffix
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
    return hostPath(parts.path, decode: false)
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
