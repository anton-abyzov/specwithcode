import Foundation

/// One frontmatter key as a document viewer shows it: a label and either a
/// Markdown value or a list of chips.
public nonisolated struct MarkdownProperty: Hashable, Sendable {
  public enum Value: Hashable, Sendable {
    case text(String)
    case chips([String])
  }

  public var label: String
  public var value: Value

  public init(label: String, value: Value) {
    self.label = label
    self.value = value
  }
}

/// A Markdown file laid out as a page: its title, its frontmatter as
/// properties, then the body as written. A port of `markdownDocument` in
/// `packages/shared/src/reportDocument.ts`, so a report reads the same on the
/// phone as on the desktop.
public nonisolated struct MarkdownDocument: Hashable, Sendable {
  /// Plain text; nil when the file names itself nowhere.
  public var title: String?
  public var properties: [MarkdownProperty]
  /// Markdown: everything after the frontmatter and the opening `# title`.
  public var body: String

  public init(title: String?, properties: [MarkdownProperty], body: String) {
    self.title = title
    self.properties = properties
    self.body = body
  }

  /// A file as its own page: frontmatter files as `parse` reads them, and a
  /// file with none takes its opening `# heading` as the title, the way the
  /// desktop's `markdownOpeningTitle` does, so plain notes get the same title.
  public static func page(_ text: String) -> MarkdownDocument {
    let document = parse(text)
    guard !document.hasFrontmatter, document.body == text else { return document }
    let body = withoutLeadingBlankLines(normalized(text))
    guard let opening = openingHeading(body) else { return document }
    let title = headingText(opening.text)
    guard !title.isEmpty else { return document }
    return MarkdownDocument(title: title, properties: [], body: withoutLeadingBlankLines(String(body.dropFirst(opening.length))))
  }

  /// True when the file opened with frontmatter this view understood.
  public var hasFrontmatter: Bool { title != nil || !properties.isEmpty }

  // MARK: Parsing

  private static let frontmatter = try! NSRegularExpression(pattern: #"\A---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|\z)"#)
  private static let keyLine = try! NSRegularExpression(pattern: #"\A[A-Za-z_][\w -]{0,40}:(?:[ \t]|\z)"#)
  private static let fieldKey = try! NSRegularExpression(pattern: #"\A([A-Za-z][\w -]{0,40}):(?:[ \t]+(.*))?\z"#)
  private static let listItem = try! NSRegularExpression(pattern: #"\A\s*-\s+(.+)\z"#)
  private static let openingTitle = try! NSRegularExpression(pattern: #"\A#[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*(?:\n|\z)"#)
  /// Longer than any heading; a line past this is not one a reader takes as a title.
  static let openingLineLimit = 400

  /// Splits `text` the way the desktop's document view does. Flat frontmatter
  /// becomes properties and the title, the opening `# heading` becomes the
  /// title rather than a second one, and the body is never restructured.
  /// Frontmatter too rich for a table stays visible as a YAML block. A file
  /// with no frontmatter, or one that opens with a `---` rule around prose,
  /// comes back as written.
  public static func parse(_ text: String) -> MarkdownDocument {
    let source = normalized(text)
    let ns = source as NSString
    guard let match = frontmatter.firstMatch(in: source, range: NSRange(location: 0, length: ns.length)) else {
      return MarkdownDocument(title: nil, properties: [], body: text)
    }
    let inner = ns.substring(with: match.range(at: 1))
    let firstLine = inner.split(separator: "\n", omittingEmptySubsequences: false).first.map(String.init) ?? ""
    // Frontmatter starts with a key on the line after `---`; anything else is a rule.
    guard matches(keyLine, firstLine) else {
      return MarkdownDocument(title: nil, properties: [], body: text)
    }
    let rest = withoutLeadingBlankLines(ns.substring(from: match.range.upperBound))
    guard let fields = fields(inner), !fields.isEmpty else {
      return MarkdownDocument(title: nil, properties: [], body: "~~~~yaml\n\(inner)\n~~~~\n\n\(rest)")
    }
    var body = rest
    var title: String?
    if case let .text(named)? = fields.first(where: { $0.label == "Title" })?.value {
      let plain = headingText(named)
      if !plain.isEmpty { title = plain }
    }
    if let opening = openingHeading(body) {
      let heading = headingText(opening.text)
      if title == nil || heading.lowercased() == title?.lowercased() {
        title = heading
        body = withoutLeadingBlankLines(String(body.dropFirst(opening.length)))
      }
    }
    let properties = shaped(fields.filter { field in
      if field.label == "Title", case .text = field.value { return false }
      return true
    })
    return MarkdownDocument(title: title, properties: properties, body: body)
  }

  /// Flat `key: value` lines, `key: [a, b]` and `key:` followed by `- item`
  /// lines. Nil when any line is something else (nested maps, block scalars),
  /// so rich frontmatter is shown as written.
  static func fields(_ inner: String) -> [MarkdownProperty]? {
    var keyed: [(key: String, text: String?, list: [String]?)] = []
    for line in inner.split(separator: "\n", omittingEmptySubsequences: false).map(String.init) {
      if line.trimmingCharacters(in: .whitespaces).isEmpty { continue }
      if let item = capture(listItem, line, group: 1), let last = keyed.last, last.list != nil {
        keyed[keyed.count - 1].list?.append(unquoted(item))
        continue
      }
      guard let key = capture(fieldKey, line, group: 1) else { return nil }
      let raw = (capture(fieldKey, line, group: 2) ?? "").trimmingCharacters(in: .whitespaces)
      if raw.hasPrefix("|") || raw.hasPrefix(">") { return nil }
      if raw.isEmpty {
        keyed.append((key.trimmingCharacters(in: .whitespaces), nil, []))
      } else if raw.hasPrefix("["), raw.hasSuffix("]") {
        let items = raw.dropFirst().dropLast().split(separator: ",").map { unquoted(String($0)) }.filter { !$0.isEmpty }
        keyed.append((key.trimmingCharacters(in: .whitespaces), nil, items))
      } else {
        keyed.append((key.trimmingCharacters(in: .whitespaces), unquoted(raw), nil))
      }
    }
    return keyed.compactMap { entry in
      let label = humanized(entry.key)
      if let text = entry.text, !text.isEmpty { return MarkdownProperty(label: label, value: .text(text)) }
      if let list = entry.list, !list.isEmpty { return MarkdownProperty(label: label, value: .chips(list)) }
      return nil
    }
  }

  /// A heading's text as written, minus the Markdown around it: links, code
  /// spans, emphasis that wraps words, and escapes.
  public static func headingText(_ markdown: String) -> String {
    let collapsed = markdown.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
    if markdown.count > openingLineLimit { return collapsed }
    var text = markdown
    text = text.replacingOccurrences(of: #"!?\[([^\]]*)\]\([^)]*\)"#, with: "$1", options: .regularExpression)
    text = text.replacingOccurrences(of: #"`([^`]+)`"#, with: "$1", options: .regularExpression)
    text = text.replacingOccurrences(of: #"(^|[\s(])(\*\*|__)(?=\S)(.+?)(?<=\S)\2(?=$|[\s).,:;!?])"#, with: "$1$3", options: .regularExpression)
    text = text.replacingOccurrences(of: #"(^|[\s(])([*_])(?=\S)(.+?)(?<=\S)\2(?=$|[\s).,:;!?])"#, with: "$1$3", options: .regularExpression)
    text = text.replacingOccurrences(of: #"\\([\\`*_{}\[\]()#+\-.!<>])"#, with: "$1", options: .regularExpression)
    return text.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
  }

  // MARK: Property values

  /// The property table as the desktop shows it (`frontmatterProperties` in
  /// `reportDocument.ts`): ISO dates in words, and a thread ID with its title
  /// as one link to the thread instead of a raw ID row and a title row.
  static func shaped(_ fields: [MarkdownProperty], locale: Locale = .current, timeZone: TimeZone = .current) -> [MarkdownProperty] {
    let threadIndex = fields.firstIndex { field in
      guard field.label == "Thread", case let .text(id) = field.value else { return false }
      return isThreadId(id)
    }
    let titleIndex = threadIndex == nil ? nil : fields.firstIndex { field in
      guard field.label == "Thread title", case .text = field.value else { return false }
      return true
    }
    var shaped: [MarkdownProperty] = []
    for (index, field) in fields.enumerated() {
      if index == titleIndex { continue }
      if index == threadIndex, case let .text(id) = field.value {
        var title = ""
        if let titleIndex, case let .text(named) = fields[titleIndex].value { title = named }
        shaped.append(MarkdownProperty(label: field.label, value: .text(threadLink(id: id.trimmingCharacters(in: .whitespaces), title: title))))
        continue
      }
      if case let .text(text) = field.value {
        shaped.append(MarkdownProperty(label: field.label, value: .text(readableDate(text, locale: locale, timeZone: timeZone))))
      } else {
        shaped.append(field)
      }
    }
    return shaped
  }

  /// One token, no spaces or Markdown: `thread:delegated-task:…` or a UUID.
  static func isThreadId(_ text: String) -> Bool {
    let trimmed = text.trimmingCharacters(in: .whitespaces)
    return trimmed.count >= 6 && trimmed.rangeOfCharacter(from: CharacterSet(charactersIn: " \t[]()<>`*")) == nil
  }

  /// `[title](studio://thread/<id>)` with the ID encoded the way the desktop's
  /// `formatStudioThreadHref` does, so `MarkdownThreadLink.route` reads it back.
  static func threadLink(id: String, title: String) -> String {
    var allowed = CharacterSet.alphanumerics
    allowed.insert(charactersIn: "-_.~")
    let encoded = id.addingPercentEncoding(withAllowedCharacters: allowed) ?? id
    let label = title.replacingOccurrences(of: #"[\[\]\\\r\n\t]"#, with: " ", options: .regularExpression)
      .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
      .trimmingCharacters(in: .whitespaces)
    return "[\(label.isEmpty ? "Open thread" : label)](studio://thread/\(encoded))"
  }

  private static let isoDay = try! NSRegularExpression(pattern: #"\A(\d{4})-(\d{2})-(\d{2})\z"#)
  private static let isoTimestamp = try! NSRegularExpression(pattern: #"\A\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})\z"#, options: [.caseInsensitive])

  /// An ISO date or timestamp in words, `November 24, 2026` or `November 24,
  /// 2026 at 4:16 PM`; anything else comes back unchanged. A bare date names
  /// a day, so no zone moves it.
  static func readableDate(_ value: String, locale: Locale = .current, timeZone: TimeZone = .current) -> String {
    let trimmed = value.trimmingCharacters(in: .whitespaces)
    let utc = TimeZone(identifier: "UTC")!
    if let year = capture(isoDay, trimmed, group: 1).flatMap(Int.init),
       let month = capture(isoDay, trimmed, group: 2).flatMap(Int.init),
       let day = capture(isoDay, trimmed, group: 3).flatMap(Int.init) {
      var calendar = Calendar(identifier: .gregorian)
      calendar.timeZone = utc
      let components = DateComponents(year: year, month: month, day: day)
      guard components.isValidDate(in: calendar), let date = calendar.date(from: components) else { return value }
      let formatter = DateFormatter()
      formatter.locale = locale
      formatter.timeZone = utc
      formatter.dateStyle = .long
      formatter.timeStyle = .none
      return formatter.string(from: date)
    }
    guard matches(isoTimestamp, trimmed) else { return value }
    let parser = ISO8601DateFormatter()
    let normalized = trimmed.replacingOccurrences(of: " ", with: "T")
    parser.formatOptions = normalized.contains(".") ? [.withInternetDateTime, .withFractionalSeconds] : [.withInternetDateTime]
    guard let date = parser.date(from: normalized) else { return value }
    let formatter = DateFormatter()
    formatter.locale = locale
    formatter.timeZone = timeZone
    formatter.dateStyle = .long
    formatter.timeStyle = .short
    return formatter.string(from: date)
  }

  // MARK: Helpers

  /// `threadTitle`, `saved_at` and `head-sha` read as "Thread title", "Saved at"
  /// and "Head sha". An all-caps key such as `URL` stays as written.
  static func humanized(_ key: String) -> String {
    var words: [String] = []
    var current = ""
    let characters = Array(key)
    for (index, character) in characters.enumerated() {
      if character == "-" || character == "_" || character == " " {
        if !current.isEmpty { words.append(current) }
        current = ""
        continue
      }
      let previous = index > 0 ? characters[index - 1] : nil
      if character.isUppercase, let previous, previous.isLowercase || previous.isNumber, !current.isEmpty {
        words.append(current)
        current = ""
      }
      current.append(character)
    }
    if !current.isEmpty { words.append(current) }
    return words.enumerated().map { index, word in
      if word.count > 1, word.allSatisfy({ $0.isUppercase || $0.isNumber }) { return word }
      return index == 0 ? word.prefix(1).uppercased() + word.dropFirst().lowercased() : word.lowercased()
    }.joined(separator: " ")
  }

  private static func normalized(_ text: String) -> String {
    var source = text
    if source.unicodeScalars.contains("\r") {
      source = source.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
    }
    if source.hasPrefix("\u{FEFF}") { source.removeFirst() }
    return source.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private static func withoutLeadingBlankLines(_ markdown: String) -> String {
    markdown.replacingOccurrences(of: #"\A(?:[ \t]*\n)+"#, with: "", options: .regularExpression)
  }

  private static func openingHeading(_ body: String) -> (text: String, length: Int)? {
    let firstLine = body.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? body
    guard firstLine.count <= openingLineLimit else { return nil }
    let ns = body as NSString
    let lineRange = NSRange(location: 0, length: min(ns.length, (firstLine as NSString).length + (ns.length > (firstLine as NSString).length ? 1 : 0)))
    guard let match = openingTitle.firstMatch(in: body, range: lineRange) else { return nil }
    return (ns.substring(with: match.range(at: 1)), (ns.substring(with: match.range) as String).count)
  }

  private static func unquoted(_ value: String) -> String {
    let trimmed = value.trimmingCharacters(in: .whitespaces)
    guard trimmed.count >= 2, let first = trimmed.first, first == "\"" || first == "'", trimmed.last == first else { return trimmed }
    return String(trimmed.dropFirst().dropLast())
  }

  private static func matches(_ regex: NSRegularExpression, _ text: String) -> Bool {
    regex.firstMatch(in: text, range: NSRange(location: 0, length: (text as NSString).length)) != nil
  }

  private static func capture(_ regex: NSRegularExpression, _ text: String, group: Int) -> String? {
    let ns = text as NSString
    guard let match = regex.firstMatch(in: text, range: NSRange(location: 0, length: ns.length)),
          match.range(at: group).location != NSNotFound else { return nil }
    return ns.substring(with: match.range(at: group))
  }
}
