import Foundation

// A small block-level Markdown parser for assistant replies. It splits text
// into headings, paragraphs, lists, quotes, fenced code, tables and rules;
// inline syntax inside each block is left for AttributedString to render.
// Unclosed fences (a reply still streaming) become code blocks with what has
// arrived so far.

public nonisolated enum MarkdownBlock: Hashable, Sendable {
  case heading(level: Int, text: String)
  case paragraph(String)
  case list([MarkdownListItem])
  case quote([MarkdownBlock])
  case code(language: String?, text: String)
  case table(header: [String], rows: [[String]])
  case rule
}

public nonisolated struct MarkdownListItem: Hashable, Sendable {
  public enum Marker: Hashable, Sendable {
    case bullet
    case number(Int)
    case task(done: Bool)
  }

  /// Inline Markdown. Continuation lines are joined with newlines.
  public var text: String
  /// Nesting depth, 0 for top-level items.
  public var level: Int
  public var marker: Marker

  public init(text: String, level: Int, marker: Marker) {
    self.text = text
    self.level = level
    self.marker = marker
  }
}

public nonisolated enum MarkdownParser {
  public static func parse(_ source: String) -> [MarkdownBlock] {
    let normalized = source.unicodeScalars.contains("\r") ? source.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n") : source
    let lines = normalized.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
    var parser = Parser(lines: lines)
    return parser.parseBlocks()
  }

  private struct Parser {
    let lines: [String]
    var i = 0

    init(lines: [String]) { self.lines = lines }

    mutating func parseBlocks() -> [MarkdownBlock] {
      var blocks: [MarkdownBlock] = []
      var paragraph: [String] = []

      func flushParagraph() {
        if !paragraph.isEmpty {
          blocks.append(.paragraph(paragraph.joined(separator: "\n")))
          paragraph.removeAll()
        }
      }

      while i < lines.count {
        let line = lines[i]
        let trimmed = line.trimmingCharacters(in: .whitespaces)

        if trimmed.isEmpty {
          flushParagraph()
          i += 1
          continue
        }

        // Setext headings underline a paragraph line.
        if !paragraph.isEmpty, leadingSpaces(line) < 4, isSetextUnderline(trimmed) {
          let level = trimmed.hasPrefix("=") ? 1 : 2
          blocks.append(.heading(level: level, text: paragraph.joined(separator: " ")))
          paragraph.removeAll()
          i += 1
          continue
        }

        if let fence = fenceOpening(line) {
          flushParagraph()
          blocks.append(parseFence(fence))
          continue
        }
        if let heading = atxHeading(trimmed, indent: leadingSpaces(line)) {
          flushParagraph()
          blocks.append(heading)
          i += 1
          continue
        }
        if isRule(trimmed, indent: leadingSpaces(line)) {
          flushParagraph()
          blocks.append(.rule)
          i += 1
          continue
        }
        if trimmed.hasPrefix(">") {
          flushParagraph()
          blocks.append(parseQuote())
          continue
        }
        if listItem(line) != nil {
          flushParagraph()
          blocks.append(parseList())
          continue
        }
        if let table = parseTable() {
          flushParagraph()
          blocks.append(table)
          continue
        }

        paragraph.append(trimmed)
        i += 1
      }
      flushParagraph()
      return blocks
    }

    // MARK: Fenced code

    struct Fence {
      let char: Character
      let length: Int
      let indent: Int
      let language: String?
    }

    func fenceOpening(_ line: String) -> Fence? {
      // Fences may be indented when they sit inside a list item.
      let indent = leadingSpaces(line)
      guard indent < 12 else { return nil }
      let rest = line.drop(while: { $0 == " " || $0 == "\t" })
      guard let first = rest.first, first == "`" || first == "~" else { return nil }
      let run = rest.prefix(while: { $0 == first }).count
      guard run >= 3 else { return nil }
      let info = rest.dropFirst(run).trimmingCharacters(in: .whitespaces)
      if first == "`", info.contains("`") { return nil }
      let language = info.split(separator: " ").first.map(String.init)
      return Fence(char: first, length: run, indent: indent, language: language?.isEmpty == false ? language : nil)
    }

    mutating func parseFence(_ fence: Fence) -> MarkdownBlock {
      i += 1
      var body: [String] = []
      while i < lines.count {
        let line = lines[i]
        let rest = line.drop(while: { $0 == " " || $0 == "\t" })
        let run = rest.prefix(while: { $0 == fence.char }).count
        if run >= fence.length, rest.dropFirst(run).allSatisfy({ $0 == " " || $0 == "\t" }) {
          i += 1
          break
        }
        body.append(removeIndent(line, upTo: fence.indent))
        i += 1
      }
      return .code(language: fence.language, text: body.joined(separator: "\n"))
    }

    // MARK: Headings and rules

    func atxHeading(_ trimmed: String, indent: Int) -> MarkdownBlock? {
      guard indent < 4, trimmed.hasPrefix("#") else { return nil }
      let level = trimmed.prefix(while: { $0 == "#" }).count
      guard (1...6).contains(level) else { return nil }
      let after = trimmed.dropFirst(level)
      guard after.isEmpty || after.first == " " || after.first == "\t" else { return nil }
      var text = after.trimmingCharacters(in: .whitespaces)
      // Optional closing run of #.
      if text.allSatisfy({ $0 == "#" }) {
        text = ""
      } else if let range = text.range(of: #"\s+#+$"#, options: .regularExpression) {
        text.removeSubrange(range)
      }
      return .heading(level: level, text: text)
    }

    func isRule(_ trimmed: String, indent: Int) -> Bool {
      guard indent < 4, let first = trimmed.first, first == "-" || first == "*" || first == "_" else { return false }
      var count = 0
      for c in trimmed {
        if c == first { count += 1 } else if c != " " && c != "\t" { return false }
      }
      return count >= 3
    }

    func isSetextUnderline(_ trimmed: String) -> Bool {
      guard let first = trimmed.first, first == "=" || first == "-" else { return false }
      return trimmed.allSatisfy { $0 == first } && (first == "=" || trimmed.count >= 2)
    }

    // MARK: Quotes

    mutating func parseQuote() -> MarkdownBlock {
      var inner: [String] = []
      while i < lines.count {
        let trimmed = lines[i].trimmingCharacters(in: .whitespaces)
        guard trimmed.hasPrefix(">") else { break }
        var rest = trimmed.dropFirst()
        if rest.first == " " { rest = rest.dropFirst() }
        inner.append(String(rest))
        i += 1
      }
      var nested = Parser(lines: inner)
      return .quote(nested.parseBlocks())
    }

    // MARK: Lists

    struct ListLine {
      let indent: Int
      let contentIndent: Int
      let marker: MarkdownListItem.Marker
      let text: String
    }

    func listItem(_ line: String) -> ListLine? {
      let indent = leadingSpaces(line)
      let rest = Substring(line).drop(while: { $0 == " " || $0 == "\t" })
      guard let first = rest.first else { return nil }
      var marker: MarkdownListItem.Marker
      var after: Substring
      if first == "-" || first == "*" || first == "+" {
        after = rest.dropFirst()
        marker = .bullet
      } else if first.isNumber {
        let digits = rest.prefix(while: { $0.isNumber })
        guard digits.count <= 9, let n = Int(digits) else { return nil }
        let tail = rest.dropFirst(digits.count)
        guard let delimiter = tail.first, delimiter == "." || delimiter == ")" else { return nil }
        after = tail.dropFirst()
        marker = .number(n)
      } else {
        return nil
      }
      guard after.isEmpty || after.first == " " || after.first == "\t" else { return nil }
      // "---" and "***" are rules, not items.
      if marker == .bullet, isRule(String(rest), indent: indent) { return nil }
      var text = after.trimmingCharacters(in: .whitespaces)
      if text.hasPrefix("[ ] ") || text == "[ ]" {
        marker = .task(done: false)
        text = String(text.dropFirst(3)).trimmingCharacters(in: .whitespaces)
      } else if text.hasPrefix("[x] ") || text.hasPrefix("[X] ") || text == "[x]" || text == "[X]" {
        marker = .task(done: true)
        text = String(text.dropFirst(3)).trimmingCharacters(in: .whitespaces)
      }
      let markerWidth = line.count - indent - after.count
      return ListLine(indent: indent, contentIndent: indent + markerWidth + 1, marker: marker, text: text)
    }

    mutating func parseList() -> MarkdownBlock {
      var items: [MarkdownListItem] = []
      // Indents of open nesting levels, outermost first.
      var levels: [Int] = []
      var afterBlank = false

      while i < lines.count {
        let line = lines[i]
        let trimmed = line.trimmingCharacters(in: .whitespaces)

        if let item = listItem(line) {
          while let last = levels.last, item.indent < last { levels.removeLast() }
          // Two or more extra spaces open a nested level.
          if levels.isEmpty || item.indent >= (levels.last ?? 0) + 2 { levels.append(item.indent) }
          items.append(MarkdownListItem(text: item.text, level: min(levels.count - 1, 6), marker: item.marker))
          afterBlank = false
          i += 1
          continue
        }

        if trimmed.isEmpty {
          // A blank line ends the list unless an item or an indented
          // continuation follows.
          var j = i + 1
          while j < lines.count, lines[j].trimmingCharacters(in: .whitespaces).isEmpty { j += 1 }
          guard j < lines.count else { i = j; break }
          if listItem(lines[j]) != nil || (leadingSpaces(lines[j]) >= 2 && !items.isEmpty && fenceOpening(lines[j]) == nil) {
            afterBlank = true
            i = j
            continue
          }
          break
        }

        // A new block ends the list; any other line continues the last item.
        if fenceOpening(line) != nil || trimmed.hasPrefix(">") || atxHeading(trimmed, indent: leadingSpaces(line)) != nil
          || isRule(trimmed, indent: leadingSpaces(line)) || items.isEmpty
          || (i + 1 < lines.count && line.contains("|") && isTableSeparator(lines[i + 1])) {
          break
        }
        items[items.count - 1].text += (afterBlank ? "\n\n" : "\n") + trimmed
        afterBlank = false
        i += 1
      }
      return .list(items)
    }

    // MARK: Tables

    mutating func parseTable() -> MarkdownBlock? {
      guard i + 1 < lines.count, lines[i].contains("|"), isTableSeparator(lines[i + 1]) else { return nil }
      let header = cells(lines[i])
      guard !header.isEmpty else { return nil }
      i += 2
      var rows: [[String]] = []
      while i < lines.count {
        let line = lines[i]
        guard line.contains("|"), !line.trimmingCharacters(in: .whitespaces).isEmpty else { break }
        var row = cells(line)
        if row.count < header.count { row += Array(repeating: "", count: header.count - row.count) }
        rows.append(Array(row.prefix(header.count)))
        i += 1
      }
      return .table(header: header, rows: rows)
    }

    func isTableSeparator(_ line: String) -> Bool {
      let parts = cells(line)
      guard !parts.isEmpty, line.contains("-") else { return false }
      return parts.allSatisfy { cell in
        let c = cell.trimmingCharacters(in: .whitespaces)
        return !c.isEmpty && c.allSatisfy { $0 == "-" || $0 == ":" } && c.contains("-")
      }
    }

    func cells(_ line: String) -> [String] {
      var s = line.trimmingCharacters(in: .whitespaces)
      if s.hasPrefix("|") { s.removeFirst() }
      if s.hasSuffix("|"), !s.hasSuffix("\\|") { s.removeLast() }
      var out: [String] = []
      var current = ""
      var escaped = false
      for c in s {
        if escaped { current.append(c); escaped = false; continue }
        if c == "\\" { escaped = true; current.append(c); continue }
        if c == "|" { out.append(current.trimmingCharacters(in: .whitespaces)); current = "" } else { current.append(c) }
      }
      out.append(current.trimmingCharacters(in: .whitespaces))
      return out
    }

    // MARK: Helpers

    func leadingSpaces(_ line: String) -> Int {
      var n = 0
      for c in line {
        if c == " " { n += 1 } else if c == "\t" { n += 4 } else { break }
      }
      return n
    }

    func removeIndent(_ line: String, upTo count: Int) -> String {
      guard count > 0 else { return line }
      var removed = 0
      var index = line.startIndex
      while index < line.endIndex, removed < count, line[index] == " " {
        removed += 1
        index = line.index(after: index)
      }
      return String(line[index...])
    }
  }
}
