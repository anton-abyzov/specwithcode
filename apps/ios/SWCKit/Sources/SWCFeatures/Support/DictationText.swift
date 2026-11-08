import Foundation

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
