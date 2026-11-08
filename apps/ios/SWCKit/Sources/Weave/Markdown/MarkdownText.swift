import SwiftUI

/// Renders an assistant reply: block structure from `MarkdownParser`, inline
/// styling from `AttributedString(markdown:)`. Links use the tint (iris) and
/// open for web, mail and phone addresses; thread links use the host callback. Long replies can collapse
/// behind "Show more".
public struct MarkdownText: View {
  let markdown: String
  let collapsible: Bool
  let collapsedHeight: CGFloat
  let onOpenLink: ((URL) -> Void)?
  let streaming: Bool

  @State private var expanded = false
  @State private var fullHeight: CGFloat = 0

  /// - Parameters:
  ///   - collapsible: Clips replies taller than `collapsedHeight` with a fade
  ///     and a "Show more" button.
  ///   - streaming: The text is still arriving. Each partial reply is parsed
  ///     once and not cached, so it cannot push finished replies out.
  public init(_ markdown: String, collapsible: Bool = false, collapsedHeight: CGFloat = 420, streaming: Bool = false, onOpenLink: ((URL) -> Void)? = nil) {
    self.streaming = streaming
    self.markdown = markdown
    self.collapsible = collapsible
    self.collapsedHeight = collapsedHeight
    self.onOpenLink = onOpenLink
  }

  /// How far above "Show more" a collapsed reply starts to fade.
  static let fadeHeight: CGFloat = 64

  /// A collapsed reply lays out only its opening, not thousands of points it
  /// would then clip: a coordinator's transcript is mostly long replies.
  private var parsed: [MarkdownBlock] { streaming ? MarkdownParser.parse(markdown) : MarkdownParser.cachedParse(markdown) }

  public var body: some View {
    let all = parsed
    let opening = collapsible && !expanded ? MarkdownCollapse.opening(all, budget: MarkdownCollapse.budget) : (blocks: all, cut: false)
    let blocks = opening.blocks
    let isClipped = collapsible && !expanded && (opening.cut || fullHeight > collapsedHeight + 80)
    VStack(alignment: .leading, spacing: isClipped ? 0 : WeaveSpacing.s2) {
      content(blocks)
        .fixedSize(horizontal: false, vertical: true)
        // Only a collapsible reply needs its height. Whole points only: a
        // sub-point change after a resize must not start another layout pass.
        .onGeometryChange(for: CGFloat.self) { collapsible ? $0.size.height.rounded() : 0 } action: { height in
          if fullHeight != height { fullHeight = height }
        }
        .frame(maxHeight: isClipped ? collapsedHeight : nil, alignment: .top)
        .clipped()
        .mask {
          if isClipped {
            CollapseFade(height: Self.fadeHeight)
          } else {
            Rectangle()
          }
        }
      if collapsible, opening.cut || fullHeight > collapsedHeight + 80 {
        Button(expanded ? "Show less" : "Show more") {
          // No animation: animating thousands of points of selectable text
          // stalls a phone for many seconds.
          var change = Transaction()
          change.disablesAnimations = true
          withTransaction(change) { expanded.toggle() }
        }
        .font(.weave(.callout))
        .foregroundStyle(Color.weave.muted)
        .buttonStyle(.plain)
        .frame(minHeight: WeaveSize.minTap)
        .contentShape(Rectangle())
      }
    }
  }

  private func content(_ blocks: [MarkdownBlock]) -> some View {
    VStack(alignment: .leading, spacing: WeaveSpacing.s3) {
      ForEach(blocks.indices, id: \.self) { index in
        MarkdownBlockView(block: blocks[index], isFirst: index == 0)
          .equatable()
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .textSelection(.enabled)
    // Second guard behind the parser: nothing in a reply can open the app's
    // pairing links or launch arbitrary apps. Thread links stay inside this view.
    .environment(\.openURL, OpenURLAction { url in
      if MarkdownThreadLink.threadId(url) != nil {
        guard let onOpenLink else { return .discarded }
        onOpenLink(url)
        return .handled
      }
      return MarkdownInline.isOpenable(url) ? .systemAction : .discarded
    })
  }
}

/// A mask that keeps the top of a collapsed reply and fades out its last
/// `height` points. The bottom stretch is fully clear, so a line cut by the
/// clip edge never shows.
private struct CollapseFade: View {
  let height: CGFloat

  var body: some View {
    VStack(spacing: 0) {
      Rectangle()
      LinearGradient(
        stops: [
          .init(color: .black, location: 0),
          .init(color: .black.opacity(0.55), location: 0.45),
          .init(color: .black.opacity(0.2), location: 0.8),
          .init(color: .clear, location: 1),
        ],
        startPoint: .top, endPoint: .bottom
      )
      .frame(height: height - 14)
      Color.clear.frame(height: 14)
    }
  }
}

struct MarkdownBlockView: View, Equatable {
  let block: MarkdownBlock
  let isFirst: Bool

  @Environment(\.dynamicTypeSize) private var dynamicTypeSize

  static func == (lhs: Self, rhs: Self) -> Bool {
    lhs.block == rhs.block && lhs.isFirst == rhs.isFirst
  }

  var body: some View {
    switch block {
    case let .heading(level, text):
      Text(MarkdownInline.render(text, dynamicTypeSize: dynamicTypeSize))
        .weaveFont(level == 1 ? .title : .headline)
        .foregroundStyle(Color.weave.ink)
        .padding(.top, isFirst ? 0 : WeaveSpacing.s2)
        .accessibilityAddTraits(.isHeader)
    case let .paragraph(text):
      Text(MarkdownInline.render(text, dynamicTypeSize: dynamicTypeSize))
        .weaveFont(.body)
        .foregroundStyle(Color.weave.ink)
    case let .list(items):
      MarkdownListView(items: items)
    case let .quote(blocks):
      HStack(alignment: .top, spacing: WeaveSpacing.s3) {
        RoundedRectangle(cornerRadius: 1.5)
          .fill(Color.weave.line)
          .frame(width: 3)
        VStack(alignment: .leading, spacing: WeaveSpacing.s3) {
          ForEach(blocks.indices, id: \.self) { index in
            MarkdownBlockView(block: blocks[index], isFirst: index == 0)
          }
        }
        .foregroundStyle(Color.weave.muted)
      }
      .fixedSize(horizontal: false, vertical: true)
    case let .code(language, text):
      MarkdownCodeBlock(language: language, code: text)
    case let .table(header, rows):
      MarkdownTableView(header: header, rows: rows)
    case .rule:
      WeaveDivider()
        .padding(.vertical, WeaveSpacing.s1)
    }
  }
}

struct MarkdownListView: View {
  let items: [MarkdownListItem]

  @Environment(\.dynamicTypeSize) private var dynamicTypeSize

  var body: some View {
    VStack(alignment: .leading, spacing: WeaveSpacing.s2) {
      ForEach(items.indices, id: \.self) { index in
        let item = items[index]
        HStack(alignment: .firstTextBaseline, spacing: WeaveSpacing.s2) {
          marker(item)
            .frame(minWidth: markerWidth, alignment: .trailing)
          Text(MarkdownInline.render(item.text, dynamicTypeSize: dynamicTypeSize))
            .weaveFont(.body)
            .foregroundStyle(Color.weave.ink)
            .strikethrough(item.marker == .task(done: true), color: Color.weave.muted)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.leading, CGFloat(item.level) * 20)
      }
    }
  }

  private var markerWidth: CGFloat {
    let largest = items.compactMap { if case let .number(n) = $0.marker { n } else { nil } }.max() ?? 0
    return largest >= 100 ? 34 : largest >= 10 ? 26 : 18
  }

  @ViewBuilder private func marker(_ item: MarkdownListItem) -> some View {
    switch item.marker {
    case .bullet:
      Text(item.level == 0 ? "•" : "◦")
        .weaveFont(.body)
        .foregroundStyle(Color.weave.muted)
        .accessibilityHidden(true)
    case let .number(n):
      Text("\(n).")
        .weaveFont(.body)
        .monospacedDigit()
        .foregroundStyle(Color.weave.muted)
    case let .task(done):
      Image(systemName: done ? "checkmark.square.fill" : "square")
        .font(.system(size: 15))
        .foregroundStyle(done ? Color.weave.iris : Color.weave.control)
        .accessibilityLabel(done ? "Done" : "Not done")
    }
  }
}

struct MarkdownCodeBlock: View {
  let language: String?
  let code: String

  @State private var copied = false

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack {
        Text(language ?? "Code")
          .font(.weave(.caption))
          .foregroundStyle(Color.weave.muted)
        Spacer()
        Button {
          WeaveClipboard.copyAnnounced(code)
          copied = true
        } label: {
          Image(systemName: copied ? "checkmark" : "doc.on.doc")
            .font(.system(size: 13))
            .foregroundStyle(copied ? Color.weave.pass : Color.weave.muted)
            .frame(width: WeaveSize.minTap, height: WeaveSize.minTap)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Copy code")
        .task(id: copied) {
          guard copied else { return }
          try? await Task.sleep(for: .seconds(2))
          copied = false
        }
      }
      .padding(.leading, WeaveSpacing.s3)
      ScrollView(.horizontal, showsIndicators: false) {
        Text(code)
          .weaveFont(.code)
          .foregroundStyle(Color.weave.ink)
          .fixedSize(horizontal: true, vertical: true)
          .padding(.horizontal, WeaveSpacing.s3)
          .padding(.bottom, WeaveSpacing.s3)
      }
    }
    .background(Color.weave.sunken, in: RoundedRectangle(cornerRadius: WeaveRadius.md, style: .continuous))
  }
}

struct MarkdownTableView: View {
  let header: [String]
  let rows: [[String]]
  @ScaledMetric(relativeTo: .callout) private var columnWidth: CGFloat = 154

  @Environment(\.dynamicTypeSize) private var dynamicTypeSize

  var body: some View {
    ScrollView(.horizontal, showsIndicators: true) {
      Grid(alignment: .leading, horizontalSpacing: WeaveSpacing.s4, verticalSpacing: WeaveSpacing.s2) {
        GridRow {
          ForEach(header.indices, id: \.self) { column in
            Text(MarkdownInline.render(header[column], dynamicTypeSize: dynamicTypeSize))
              .font(.weave(.callout, weight: .semibold))
              .foregroundStyle(Color.weave.ink)
              .frame(width: columnWidth, alignment: .leading)
              .fixedSize(horizontal: false, vertical: true)
          }
        }
        WeaveDivider().gridCellUnsizedAxes(.horizontal)
        ForEach(rows.indices, id: \.self) { row in
          GridRow {
            ForEach(rows[row].indices, id: \.self) { column in
              Text(MarkdownInline.render(rows[row][column], dynamicTypeSize: dynamicTypeSize))
                .font(.weave(.callout))
                .foregroundStyle(Color.weave.ink)
                .frame(width: columnWidth, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
            }
          }
        }
      }
      .padding(WeaveSpacing.s3)
    }
    .background(Color.weave.panel, in: RoundedRectangle(cornerRadius: WeaveRadius.md, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: WeaveRadius.md, style: .continuous).strokeBorder(Color.weave.line, lineWidth: WeaveSize.hairline))
  }
}

/// Inline Markdown to AttributedString, with inline code set in mono on the
/// sunken color. Results are cached because streaming re-renders often; the
/// cache is keyed by Dynamic Type size because inline code carries its font.
enum MarkdownInline {
  private struct Key: Hashable {
    let text: String
    let size: DynamicTypeSize
  }

  private static var cache: [Key: AttributedString] = [:]
  private static let cacheLimit = 600

  /// Schemes a tapped link may open. Everything else, including the app's own
  /// specwithcode: scheme, renders as plain text.
  static let openableSchemes: Set<String> = ["http", "https", "mailto", "tel"]

  static func isOpenable(_ url: URL) -> Bool {
    guard let scheme = url.scheme?.lowercased() else { return false }
    return openableSchemes.contains(scheme)
  }

  static func render(_ text: String, dynamicTypeSize: DynamicTypeSize) -> AttributedString {
    let key = Key(text: text, size: dynamicTypeSize)
    if let hit = cache[key] { return hit }
    let out = parse(text, dynamicTypeSize: dynamicTypeSize)
    if cache.count >= cacheLimit { cache.removeAll(keepingCapacity: true) }
    cache[key] = out
    return out
  }

  private static func parse(_ text: String, dynamicTypeSize: DynamicTypeSize) -> AttributedString {
    let options = AttributedString.MarkdownParsingOptions(
      allowsExtendedAttributes: false,
      interpretedSyntax: .inlineOnlyPreservingWhitespace,
      failurePolicy: .returnPartiallyParsedIfPossible
    )
    guard var attributed = try? AttributedString(markdown: text, options: options) else {
      return AttributedString(text)
    }
    let codeFont = WeaveFont.code.font(dynamicTypeSize: dynamicTypeSize)
    for run in attributed.runs where run.inlinePresentationIntent?.contains(.code) == true {
      attributed[run.range].swiftUI.font = codeFont
      attributed[run.range].swiftUI.backgroundColor = .weave.sunken
    }
    let blocked = attributed.runs.compactMap { run -> Range<AttributedString.Index>? in
      guard let url = run.link else { return nil }
      return isOpenable(url) || MarkdownThreadLink.threadId(url) != nil ? nil : run.range
    }
    for range in blocked { attributed[range].link = nil }
    // Preserve tappable bare web addresses in user messages too.
    let plain = String(attributed.characters)
    if let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) {
      for match in detector.matches(in: plain, range: NSRange(plain.startIndex..., in: plain)) {
        guard let url = match.url, isOpenable(url),
              let range = Range(match.range, in: plain),
              let lower = AttributedString.Index(range.lowerBound, within: attributed),
              let upper = AttributedString.Index(range.upperBound, within: attributed),
              attributed[lower..<upper].runs.allSatisfy({ $0.link == nil && $0.inlinePresentationIntent?.contains(.code) != true })
        else { continue }
        attributed[lower..<upper].link = url
      }
    }
    return attributed
  }
}

#Preview("Light") {
  ScrollView { MarkdownText(MarkdownSample.reply, collapsible: true).padding() }
    .background(Color.weave.canvas)
    .environment(\.colorScheme, .light)
}

#Preview("Dark") {
  ScrollView { MarkdownText(MarkdownSample.reply).padding() }
    .background(Color.weave.canvas)
    .environment(\.colorScheme, .dark)
}

enum MarkdownSample {
  static let reply = """
  ## Release status

  The **3.0.24** release is blocked on one check. Here is what I found:

  1. The `release.yml` workflow failed at **Publish to npm**.
  2. The token in `NPM_TOKEN` expired on Oct 12.
     - Rotating it fixes the publish step.
     - The docs deploy is unaffected.
  3. Everything else passed. See [the run](https://github.com/anton-abyzov/specweave/actions).

  > Tokens for vskill tags still use the repository secret.

  ```bash
  gh secret set NPM_TOKEN --repo anton-abyzov/vskill
  bash scripts/release/release.sh ship vskill
  ```

  | Check | Result |
  |---|---|
  | Unit tests | Passed |
  | Publish | Failed |

  - [x] Find the failing step
  - [ ] Rotate the token

  ---

  Want me to re-run the workflow once the secret is updated?
  """
}

/// The opening of a long reply: whole blocks up to a character budget, the
/// last one shortened when it alone runs past it.
public nonisolated enum MarkdownCollapse {
  /// Enough text to fill a collapsed reply (420 points) at any width.
  public static let budget = 1_600

  public static func opening(_ blocks: [MarkdownBlock], budget: Int) -> (blocks: [MarkdownBlock], cut: Bool) {
    var kept: [MarkdownBlock] = []
    var used = 0
    for (index, block) in blocks.enumerated() {
      let size = length(block)
      if used + size <= budget {
        kept.append(block)
        used += size
        continue
      }
      if let short = shortened(block, to: budget - used) {
        kept.append(short)
      } else if kept.isEmpty {
        // A huge table, quote or list leads the reply: show its text, cut,
        // rather than laying all of it out to clip it.
        kept.append(.paragraph(cutText(plainText(blocks[index]), to: budget)))
      }
      return (kept, true)
    }
    return (kept, false)
  }

  static func length(_ block: MarkdownBlock) -> Int {
    switch block {
    case let .heading(_, text), let .paragraph(text), let .code(_, text): text.count
    case let .list(items): items.reduce(0) { $0 + $1.text.count }
    case let .quote(blocks): blocks.reduce(0) { $0 + length($1) }
    case let .table(header, rows): (header + rows.flatMap { $0 }).reduce(0) { $0 + $1.count }
    case .rule: 1
    }
  }

  static func plainText(_ block: MarkdownBlock) -> String {
    switch block {
    case let .heading(_, text), let .paragraph(text), let .code(_, text): text
    case let .list(items): items.map(\.text).joined(separator: "\n")
    case let .quote(blocks): blocks.map(plainText).joined(separator: "\n")
    case let .table(header, rows): ([header] + rows).map { $0.joined(separator: " | ") }.joined(separator: "\n")
    case .rule: ""
    }
  }

  static func cutText(_ text: String, to room: Int) -> String {
    let head = text.prefix(max(0, room))
    guard head.endIndex < text.endIndex else { return String(head) }
    let end = head.lastIndex(of: "\n") ?? head.lastIndex(of: " ") ?? head.endIndex
    return String(head[..<end])
  }

  /// A paragraph or code block cut at a line or word boundary, or nil when
  /// too little room is left to be worth showing.
  static func shortened(_ block: MarkdownBlock, to room: Int) -> MarkdownBlock? {
    guard room >= 200 else { return nil }
    func cut(_ text: String) -> String { cutText(text, to: room) }
    switch block {
    case let .paragraph(text): return .paragraph(cut(text))
    case let .code(language, text): return .code(language: language, text: cut(text))
    case let .list(items):
      var room = room
      let shown = items.prefix { item in
        room -= item.text.count
        return room >= 0
      }
      return shown.isEmpty ? nil : .list(Array(shown))
    default: return nil
    }
  }
}
