import Foundation
import SwiftUI

/// Where dictated words go and which language they are heard in, as on the
/// desktop: a phrase lands with one space between it and the draft, and one
/// language setting covers every chat on this phone.
nonisolated enum DictationText {
  /// The draft with `phrase` appended, one space apart, none before punctuation.
  static func insert(_ phrase: String, into draft: String) -> String {
    let phrase = phrase.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !phrase.isEmpty else { return draft }
    guard let last = draft.last, !last.isWhitespace else { return draft + phrase }
    if let first = phrase.first, ".,;:!?)".contains(first) { return draft + phrase }
    return draft + " " + phrase
  }

  /// `prefix`, the words being heard, then `suffix`, each one space apart:
  /// dictation that started with the cursor inside the draft.
  static func compose(_ prefix: String, _ heard: String, _ suffix: String) -> String {
    let left = insert(heard, into: prefix)
    guard let first = suffix.first, let last = left.last else { return left + suffix }
    if last.isWhitespace || first.isWhitespace || ".,;:!?)".contains(first) { return left + suffix }
    return left + " " + suffix
  }

  /// The draft split at `cursor` (characters from the start); the end when the
  /// cursor is unknown or outside the draft.
  static func split(_ draft: String, at cursor: Int?) -> (prefix: String, suffix: String) {
    guard let cursor, cursor >= 0, cursor < draft.count else { return (draft, "") }
    let index = draft.index(draft.startIndex, offsetBy: cursor)
    return (String(draft[..<index]), String(draft[index...]))
  }

  /// The cursor in characters from the start of `text`: the end of a
  /// selection, so dictation adds after selected words rather than over them.
  static func cursor(_ selection: TextSelection?, in text: String) -> Int? {
    guard let selection, case let .selection(range) = selection.indices else { return nil }
    let end = range.upperBound
    guard end >= text.startIndex, end <= text.endIndex else { return nil }
    return text.distance(from: text.startIndex, to: end)
  }

  /// Words compared without case or punctuation, as the recognizer revises them.
  static func words(_ text: String) -> [String] {
    text.lowercased().split { !isWordCharacter($0) }.map(String.init)
  }

  /// What `text` adds after `heard` when the recognizer repeats words it already
  /// reported (case and punctuation aside); nil when it does not start with
  /// them. By default a phrase of one or two words is never stripped: a new
  /// phrase can open with the same "Okay" by chance.
  static func remainder(of text: String, after heard: String, minimumWords: Int = 3) -> String? {
    let expected = words(heard)
    guard !expected.isEmpty, expected.count >= minimumWords else { return nil }
    var index = text.startIndex
    for word in expected {
      while index < text.endIndex, !isWordCharacter(text[index]) {
        index = text.index(after: index)
      }
      var end = index
      while end < text.endIndex, isWordCharacter(text[end]) {
        end = text.index(after: end)
      }
      guard text[index..<end].lowercased() == word else { return nil }
      index = end
    }
    // Punctuation after the repeated words closed the settled phrase, which
    // is already in the draft.
    let rest = text[index...].drop { $0.isWhitespace || $0.isPunctuation }
    return String(rest).trimmingCharacters(in: .whitespaces)
  }

  /// `text` without its first `count` words and the punctuation after them.
  static func dropWords(_ text: String, count: Int) -> String {
    var index = text.startIndex
    for _ in 0..<count {
      while index < text.endIndex, !isWordCharacter(text[index]) { index = text.index(after: index) }
      while index < text.endIndex, isWordCharacter(text[index]) { index = text.index(after: index) }
    }
    return String(text[index...].drop { $0.isWhitespace || $0.isPunctuation })
  }

  private static func isWordCharacter(_ character: Character) -> Bool {
    character.isLetter || character.isNumber || character == "'"
  }

  /// The recognizer began a new phrase instead of revising the one it was
  /// hearing. Apple's on-device recognizer marks the end of a phrase before it
  /// starts over (handled as a settled phrase); this catches a restart without
  /// that mark. When in doubt it says restart: writing a phrase twice can be
  /// fixed by hand, erasing what was said cannot. A revision keeps the opening
  /// word and most of the length ("twenty five dollars" to "$25" inside a
  /// longer phrase), or keeps the closing word ("Their is a cat" to "There's a cat").
  static func isRestart(from previous: String, to next: String) -> Bool {
    let before = words(previous), after = words(next)
    guard before.count >= 2, !after.isEmpty, after.count < before.count else { return false }
    if after.last == before.last { return false }
    return before.first != after.first || after.count * 2 <= before.count
  }

  /// The languages the desktop offers; "" follows the phone's language.
  static let languages: [(value: String, label: String)] = [
    ("", "System"),
    ("en-US", "English (US)"),
    ("en-GB", "English (UK)"),
    ("ru-RU", "Russian"),
    ("uk-UA", "Ukrainian"),
    ("de-DE", "German"),
    ("fr-FR", "French"),
    ("es-ES", "Spanish"),
    ("it-IT", "Italian"),
    ("pt-BR", "Portuguese (Brazil)"),
    ("pl-PL", "Polish"),
    ("nl-NL", "Dutch"),
    ("tr-TR", "Turkish"),
    ("ja-JP", "Japanese"),
    ("ko-KR", "Korean"),
    ("zh-CN", "Chinese (Simplified)"),
  ]

  static func label(_ value: String) -> String {
    languages.first { $0.value == value }?.label ?? value
  }

  static func locale(_ setting: String, system: Locale = .current) -> Locale {
    setting.isEmpty ? system : Locale(identifier: setting)
  }
}
