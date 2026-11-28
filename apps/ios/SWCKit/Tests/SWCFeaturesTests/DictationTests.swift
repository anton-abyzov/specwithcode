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

  /// Apple's recognizer starts its transcript over after a pause; the words
  /// said before the pause must stay (the iPhone erased them).
  @Test func aPauseNeverErasesWhatWasSaid() async throws {
    let (engine, dictation, draft) = try await listening("Notes:")
    engine.emit(.partial("I want to"))
    engine.emit(.partial("I want to fix the build"))
    engine.emit(.partial("and"))
    engine.emit(.partial("and then ship it"))
    #expect(draft() == "Notes: I want to fix the build and then ship it")
    engine.emit(.partial("Okay"))
    #expect(draft() == "Notes: I want to fix the build and then ship it Okay")
    engine.emit(.final("Okay."))
    engine.emit(.partial("Okay so next"))
    #expect(draft() == "Notes: I want to fix the build and then ship it Okay. Okay so next")
    engine.emit(.partial("Okay so next I want to"))
    engine.emit(.partial("I think"))
    #expect(draft() == "Notes: I want to fix the build and then ship it Okay. Okay so next I want to I think")
    dictation.stop()
  }

  @Test func aSettledPhraseStaysWhenTheNextStartsEmpty() async throws {
    let (engine, _, draft) = try await listening("")
    engine.emit(.partial("Fix the build"))
    engine.emit(.final("Fix the build."))
    engine.emit(.partial("Then"))
    engine.emit(.partial("Then ship"))
    #expect(draft() == "Fix the build. Then ship")
    engine.emit(.final("Then ship."))
    engine.emit(.final("Then ship."))
    #expect(draft() == "Fix the build. Then ship.")
  }

  /// Some recognizers report the whole session in every result.
  @Test func aSettledPhraseIsNotRepeatedWhenTheRecognizerRepeatsIt() async throws {
    let (engine, _, draft) = try await listening("")
    engine.emit(.final("Fix the build."))
    engine.emit(.partial("Fix the build. Then"))
    engine.emit(.partial("Fix the build. Then ship"))
    #expect(draft() == "Fix the build. Then ship")
    engine.emit(.final("Fix the build. Then ship."))
    #expect(draft() == "Fix the build. Then ship.")
  }

  @Test func wordsGoInAtTheCursor() async throws {
    let (engine, _, draft) = try await listening("Fix later", cursor: 3)
    engine.emit(.partial("the"))
    engine.emit(.partial("the build"))
    #expect(draft() == "Fix the build later")
    engine.emit(.final("the build"))
    engine.emit(.partial("now"))
    #expect(draft() == "Fix the build now later")
  }

  @Test func anEditWhileListeningIsKept() async throws {
    var text = "Hi"
    let binding = Binding(get: { text }, set: { text = $0 })
    let engine = FakeSpeech()
    let dictation = SpeechDictation(makeEngine: { engine })
    dictation.start(language: "", draft: binding)
    try await engine.started()
    engine.emit(.partial("hello"))
    #expect(text == "Hi hello")
    text = "Hi hello, typed by hand"
    engine.emit(.partial("hello there"))
    #expect(text == "Hi hello, typed by hand there")
    text = ""
    engine.emit(.partial("hello there again"))
    #expect(text == "again")
  }

  @Test func theCursorIsTheEndOfASelection() {
    let text = "one two three"
    let range = text.index(text.startIndex, offsetBy: 4)..<text.index(text.startIndex, offsetBy: 7)
    #expect(DictationText.cursor(TextSelection(range: range), in: text) == 7)
    #expect(DictationText.cursor(nil, in: text) == nil)
    #expect(DictationText.split(text, at: 7) == ("one two", " three"))
    #expect(DictationText.split(text, at: 99) == (text, ""))
    #expect(DictationText.compose("one", "two", "three") == "one two three")
    #expect(DictationText.compose("one", "two", ", three") == "one two, three")
  }

  @Test func aRevisionIsNotARestart() {
    #expect(!DictationText.isRestart(from: "for the record", to: "4 the record"))
    #expect(!DictationText.isRestart(from: "I want", to: "I want to"))
    #expect(!DictationText.isRestart(from: "hey", to: "hay"))
    #expect(!DictationText.isRestart(from: "I want to fix the build", to: "I want to fix that"))
    #expect(DictationText.isRestart(from: "fix the build", to: "then"))
    #expect(DictationText.isRestart(from: "I want to fix it", to: "I think"))
    #expect(DictationText.remainder(of: "Fix the build. Then", after: "fix the build") == "Then")
    #expect(DictationText.remainder(of: "Fix it", after: "fix the build") == nil)
    #expect(DictationText.remainder(of: "Okay so next", after: "Okay.") == nil)
  }

  private func listening(_ initial: String, cursor: Int? = nil) async throws -> (FakeSpeech, SpeechDictation, () -> String) {
    final class Box { var text = "" }
    let box = Box()
    box.text = initial
    let engine = FakeSpeech()
    let dictation = SpeechDictation(makeEngine: { engine })
    dictation.start(language: "", draft: Binding(get: { box.text }, set: { box.text = $0 }), cursor: cursor)
    try await engine.started()
    return (engine, dictation, { box.text })
  }

  @Test func aForgottenMicStopsAfterSilence() async throws {
    let engine = FakeSpeech()
    let dictation = SpeechDictation(silenceLimit: .milliseconds(150), makeEngine: { engine })
    var draft = ""
    dictation.start(language: "", draft: Binding(get: { draft }, set: { draft = $0 }))
    try await engine.started()
    engine.emit(.partial("still talking"))
    #expect(dictation.phase == .listening)
    for _ in 0..<100 where dictation.phase != .idle { try await Task.sleep(for: .milliseconds(20)) }
    #expect(dictation.phase == .idle)
    #expect(engine.stopped)
    #expect(draft == "still talking")
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
