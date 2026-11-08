import Testing
@testable import SWCFeatures
@testable import Weave
import SWCSync

@Suite("Transcript window")
struct TranscriptWindowTests {
  private func rows(_ count: Int) -> [TranscriptRow] {
    (0..<count).map { TranscriptRow(id: "r\($0)", kind: .assistant(markdown: "Reply \($0)", streaming: false)) }
  }

  @Test func aLongTranscriptShowsOnlyItsNewestRows() {
    let all = rows(3_000)
    let window = TranscriptWindow.shown(all, limit: TranscriptWindow.step)
    #expect(window.rows.count == TranscriptWindow.step)
    #expect(window.hidden == 3_000 - TranscriptWindow.step)
    #expect(window.rows.last?.id == "r2999")
  }

  @Test func aShortTranscriptShowsEverything() {
    let window = TranscriptWindow.shown(rows(40), limit: TranscriptWindow.step)
    #expect(window.rows.count == 40)
    #expect(window.hidden == 0)
  }

  @Test func scrollingToAnEarlierRowWidensTheWindow() {
    let all = rows(1_000)
    #expect(TranscriptWindow.limit(revealing: "r100", in: all, current: 150) == 900)
    #expect(TranscriptWindow.limit(revealing: "r990", in: all, current: 150) == 150)
    #expect(TranscriptWindow.limit(revealing: "missing", in: all, current: 150) == 150)
  }

  @Test func aCollapsedReplyKeepsOnlyItsOpening() {
    let blocks = (0..<60).map { MarkdownBlock.paragraph(String(repeating: "word ", count: 40) + "\($0)") }
    let opening = MarkdownCollapse.opening(blocks, budget: MarkdownCollapse.budget)
    #expect(opening.cut)
    #expect(opening.blocks.count < 10)
    #expect(opening.blocks.reduce(0) { $0 + MarkdownCollapse.length($1) } <= MarkdownCollapse.budget)
  }

  @Test func oneHugeBlockIsShortenedAtAWordBreak() {
    let huge = MarkdownBlock.code(language: "swift", text: (0..<2_000).map { "line \($0)" }.joined(separator: "\n"))
    let opening = MarkdownCollapse.opening([huge], budget: MarkdownCollapse.budget)
    #expect(opening.cut)
    guard case let .code(_, text) = opening.blocks.first else { Issue.record("expected code"); return }
    #expect(text.count <= MarkdownCollapse.budget)
    #expect(text.hasSuffix("line \(text.split(separator: "\n").count - 1)"))
  }

  @Test func aReplyWithinTheBudgetIsWhole() {
    let blocks: [MarkdownBlock] = [.heading(level: 2, text: "Done"), .paragraph("Short."), .rule]
    let opening = MarkdownCollapse.opening(blocks, budget: MarkdownCollapse.budget)
    #expect(!opening.cut)
    #expect(opening.blocks == blocks)
  }
}
