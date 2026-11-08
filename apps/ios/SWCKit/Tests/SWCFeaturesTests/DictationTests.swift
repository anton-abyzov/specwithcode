import Foundation
import SwiftUI
import Testing
@testable import SWCFeatures
@testable import Weave

@MainActor
@Suite("Dictation")
struct DictationTests {
  @Test func phrasesLandOneSpaceApart() {
    #expect(DictationText.insert("hello there", into: "") == "hello there")
    #expect(DictationText.insert("next", into: "Fix the build") == "Fix the build next")
    #expect(DictationText.insert("next", into: "Fix the build ") == "Fix the build next")
    #expect(DictationText.insert(", then ship", into: "Fix it") == "Fix it, then ship")
    #expect(DictationText.insert("  ", into: "Keep") == "Keep")
  }

  @Test func theLanguageSettingPicksTheLocale() {
    let system = Locale(identifier: "en-US")
    #expect(DictationText.locale("", system: system) == system)
    #expect(DictationText.locale("ru-RU", system: system).identifier == "ru-RU")
    #expect(DictationText.label("") == "System")
    #expect(DictationText.languages.count == 16)
  }

  @Test func partialWordsReplaceThemselvesAndFinalOnesStay() async throws {
    let engine = FakeSpeech()
    let dictation = SpeechDictation(makeEngine: { engine })
    var draft = "Status:"
    let binding = Binding(get: { draft }, set: { draft = $0 })
    dictation.start(language: "", draft: binding)
    try await engine.started()
    engine.emit(.partial("all"))
    engine.emit(.partial("all green"))
    #expect(draft == "Status: all green")
    engine.emit(.final("all green."))
    engine.emit(.partial("ship"))
    #expect(draft == "Status: all green. ship")
    #expect(dictation.phase == .listening)
    dictation.toggle(language: "", draft: binding)
    #expect(dictation.phase == .idle)
    #expect(engine.stopped)
    engine.emit(.partial("ignored"))
    #expect(draft == "Status: all green. ship")
  }

  @Test func aRefusalShowsWhyAndStops() async throws {
    let engine = FakeSpeech(failure: DictationError.microphoneDenied)
    let dictation = SpeechDictation(makeEngine: { engine })
    var draft = ""
    dictation.start(language: "", draft: Binding(get: { draft }, set: { draft = $0 }))
    for _ in 0..<50 where dictation.error == nil { await Task.yield() }
    #expect(dictation.error?.contains("Microphone") == true)
    #expect(dictation.phase == .idle)
  }

  @Test func quotesNestOnlySoDeep() {
    let line = String(repeating: ">", count: 5_000) + " deep"
    let blocks = MarkdownParser.parse(line)
    func depth(_ block: MarkdownBlock) -> Int {
      if case let .quote(inner) = block { return 1 + (inner.map(depth).max() ?? 0) }
      return 0
    }
    #expect((blocks.map(depth).max() ?? 0) <= 9)
  }

  @Test func aHugeLeadingTableCollapsesToText() {
    let table = MarkdownBlock.table(header: ["a", "b"], rows: (0..<2_000).map { ["row \($0)", String(repeating: "x", count: 40)] })
    let opening = MarkdownCollapse.opening([table], budget: MarkdownCollapse.budget)
    #expect(opening.cut)
    guard case let .paragraph(text)? = opening.blocks.first else { Issue.record("expected text"); return }
    #expect(text.count <= MarkdownCollapse.budget)
  }

  @Test func longUserMessagesCollapse() {
    #expect(MessageBubble.collapseThreshold == 1_200)
  }
}

@MainActor
private final class FakeSpeech: SpeechEngine {
  private var onEvent: (@MainActor (SpeechEvent) -> Void)?
  private let failure: Error?
  private(set) var stopped = false

  init(failure: Error? = nil) { self.failure = failure }

  func start(locale: Locale, onEvent: @escaping @MainActor (SpeechEvent) -> Void) async throws {
    if let failure { throw failure }
    self.onEvent = onEvent
  }

  func started() async throws {
    for _ in 0..<50 where onEvent == nil { await Task.yield() }
    try #require(onEvent != nil)
  }

  func emit(_ event: SpeechEvent) { onEvent?(event) }
  func stop() { stopped = true }
}
