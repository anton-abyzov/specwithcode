import Foundation
import Observation
import SwiftUI
#if os(iOS)
import AVFoundation
import Speech
#endif

/// What the recognizer reports: words so far, then the settled phrase.
nonisolated enum SpeechEvent: Sendable, Equatable {
  case partial(String)
  case final(String)
  case failed(String)
}

/// Turns speech into text. The app uses Apple's recognizer, on the phone when
/// the language allows; tests use a fake.
@MainActor
protocol SpeechEngine: AnyObject {
  func start(locale: Locale, onEvent: @escaping @MainActor (SpeechEvent) -> Void) async throws
  func stop()
}

/// The composer's mic. Words appear in the draft as they are heard and stay
/// there unsent, as with desktop dictation. New words go in at the cursor (the
/// end when it is unknown) and never replace anything already in the draft:
/// not the text typed before, not words said before a pause, not edits made
/// while listening. A forgotten mic turns itself off after `silenceLimit`
/// without new words.
@MainActor
@Observable
final class SpeechDictation {
  enum Phase: Equatable { case idle, starting, listening }

  private(set) var phase: Phase = .idle
  private(set) var error: String?
  @ObservationIgnored private let makeEngine: @MainActor () -> SpeechEngine
  @ObservationIgnored private var engine: SpeechEngine?
  /// The draft before and after the words being heard now; partial results
  /// replace only the phrase between them.
  @ObservationIgnored private var prefix: String?
  @ObservationIgnored private var suffix = ""
  /// The phrase being heard, as written into the draft.
  @ObservationIgnored private var heard = ""
  /// The recognizer's last partial result, as it sent it.
  @ObservationIgnored private var lastPartial = ""
  /// What the recognizer had settled when it last finished a phrase.
  @ObservationIgnored private var settled = ""
  /// Whether the recognizer repeats `settled` at the start of its later
  /// results (server recognition does; on-device recognition starts over).
  /// Decided by the first result after a phrase settles.
  @ObservationIgnored private var repeatsSettled: Bool?
  /// Words at the start of later results that are already in the draft: the
  /// phrase being heard when the person edited the draft.
  @ObservationIgnored private var skipWords = 0
  /// Where the words went when the mic last stopped, so dictating in parts
  /// continues there even when the field's cursor was not moved by them.
  @ObservationIgnored private var resume: (draft: String, cursor: Int?, caret: Int)?
  @ObservationIgnored private var startCursor: Int?
  /// Counts mic sessions; results carry the one they belong to.
  @ObservationIgnored private var session = 0
  /// The draft as dictation last wrote it; anything else means the person
  /// edited it, and the edit wins.
  @ObservationIgnored private var written: String?
  @ObservationIgnored private let silenceLimit: Duration
  @ObservationIgnored private var silenceTimer: Task<Void, Never>?

  init(
    silenceLimit: Duration = .seconds(60),
    makeEngine: @escaping @MainActor () -> SpeechEngine = { SpeechDictation.systemEngine() }
  ) {
    self.silenceLimit = silenceLimit
    self.makeEngine = makeEngine
  }

  var isActive: Bool { phase != .idle }

  /// - Parameter cursor: Where the words go, in characters from the start of
  ///   the draft; nil puts them at the end.
  func toggle(language: String, draft: Binding<String>, cursor: Int? = nil) {
    isActive ? stop() : start(language: language, draft: draft, cursor: cursor)
  }

  func start(language: String, draft: Binding<String>, cursor: Int? = nil) {
    guard phase == .idle else { return }
    error = nil
    phase = .starting
    var at = cursor
    if let resume, resume.draft == draft.wrappedValue, resume.cursor == cursor { at = resume.caret }
    startCursor = cursor
    (prefix, suffix) = DictationText.split(draft.wrappedValue, at: at)
    heard = ""
    lastPartial = ""
    settled = ""
    repeatsSettled = nil
    skipWords = 0
    written = draft.wrappedValue
    let engine = makeEngine()
    self.engine = engine
    session += 1
    let current = session
    Task {
      do {
        try await engine.start(locale: DictationText.locale(language)) { [weak self] event in
          // A stopped session's last result must not land in the next one.
          // A counter, not the engine's address: a new engine often reuses it.
          guard let self, self.session == current, self.engine != nil else { return }
          self.handle(event, draft: draft)
        }
        if self.engine === engine, phase == .starting { phase = .listening }
        if self.engine === engine { restartSilenceTimer() }
      } catch {
        if self.engine === engine { fail(error.localizedDescription) }
      }
    }
  }

  func stop() {
    if let prefix, let written {
      resume = (written, startCursor, DictationText.insert(heard, into: prefix).count)
    }
    silenceTimer?.cancel()
    silenceTimer = nil
    engine?.stop()
    engine = nil
    prefix = nil
    suffix = ""
    heard = ""
    written = nil
    phase = .idle
  }

  /// Every new word pushes the automatic stop back.
  private func restartSilenceTimer() {
    silenceTimer?.cancel()
    guard let current = engine else { return }
    let session = ObjectIdentifier(current)
    let limit = silenceLimit
    silenceTimer = Task { @MainActor [weak self] in
      try? await Task.sleep(for: limit)
      guard !Task.isCancelled, let self, let engine = self.engine, ObjectIdentifier(engine) == session else { return }
      self.stop()
    }
  }

  private func handle(_ event: SpeechEvent, draft: Binding<String>) {
    guard var prefix else { return }
    if case .failed = event {} else { restartSilenceTimer() }
    // Typed, pasted or keyboard-dictated while listening: keep the draft as it
    // is now and add later words at its end. The phrase being heard is in it.
    if let written, draft.wrappedValue != written {
      prefix = draft.wrappedValue
      suffix = ""
      heard = ""
      if !lastPartial.isEmpty { skipWords = DictationText.words(lastPartial).count }
      lastPartial = ""
    }
    switch event {
    case let .partial(text):
      if phase == .starting { phase = .listening }
      // The recognizer started over after a pause: what it heard before stays.
      if DictationText.isRestart(from: lastPartial, to: text) {
        prefix = DictationText.insert(heard, into: prefix)
        settled = ""
        repeatsSettled = nil
        skipWords = 0
      }
      lastPartial = text
      heard = newWords(in: text)
    case let .final(text):
      // A metadata-bearing result and the final callback can settle the same text.
      if lastPartial.isEmpty, text == settled { break }
      prefix = DictationText.insert(newWords(in: text), into: prefix)
      settled = text
      repeatsSettled = nil
      skipWords = 0
      lastPartial = ""
      heard = ""
    case let .failed(message):
      fail(message)
      return
    }
    self.prefix = prefix
    let next = DictationText.compose(prefix, heard, suffix)
    written = next
    draft.wrappedValue = next
  }

  /// The words of a result that are not in the draft yet.
  private func newWords(in text: String) -> String {
    if skipWords > 0 { return DictationText.dropWords(text, count: skipWords) }
    guard !settled.isEmpty else { return text }
    if repeatsSettled == nil {
      repeatsSettled = DictationText.remainder(of: text, after: settled, minimumWords: 1) != nil
        && DictationText.words(text).count > DictationText.words(settled).count
    }
    guard repeatsSettled == true else { return text }
    return DictationText.remainder(of: text, after: settled, minimumWords: 1)
      ?? DictationText.dropWords(text, count: DictationText.words(settled).count)
  }

  private func fail(_ message: String) {
    stop()
    error = message
  }

  func clearError() { error = nil }

  static func systemEngine() -> SpeechEngine {
    #if os(iOS)
    AppleSpeechEngine()
    #else
    UnavailableSpeechEngine()
    #endif
  }
}

/// Builds that have no microphone path.
@MainActor
final class UnavailableSpeechEngine: SpeechEngine {
  func start(locale: Locale, onEvent: @escaping @MainActor (SpeechEvent) -> Void) async throws {
    throw DictationError.unavailable
  }
  func stop() {}
}

nonisolated enum DictationError: LocalizedError {
  case speechDenied, microphoneDenied, unavailable, language(String)

  var errorDescription: String? {
    switch self {
    case .speechDenied: "Speech recognition is off for SpecWithCode. Turn it on in Settings > Privacy & Security > Speech Recognition."
    case .microphoneDenied: "The microphone is off for SpecWithCode. Turn it on in Settings > Privacy & Security > Microphone."
    case .unavailable: "Dictation is not available on this device."
    case let .language(name): "Dictation in \(name) is not available on this iPhone. Pick another language in Settings."
    }
  }
}

#if os(iOS)
/// Apple's recognizer fed from the microphone. Recognition stays on the phone
/// when the language supports it, so no audio leaves it.
///
/// The system calls the authorization handler, the audio tap and the
/// recognition handler on its own queues. The package isolates code to the
/// main actor by default, and a closure made there would trap the moment the
/// system called it off the main thread (build 38 crashed right after Allow),
/// so those closures are made in the nonisolated helpers below.
@MainActor
final class AppleSpeechEngine: SpeechEngine {
  private let audio = AVAudioEngine()
  private let feed = RecognitionFeed()
  private var recognizer: SFSpeechRecognizer?
  private var task: SFSpeechRecognitionTask?
  private var onEvent: (@MainActor (SpeechEvent) -> Void)?
  private var tapInstalled = false

  func start(locale: Locale, onEvent: @escaping @MainActor (SpeechEvent) -> Void) async throws {
    guard await Self.speechAllowed() else { throw DictationError.speechDenied }
    guard await AVAudioApplication.requestRecordPermission() else { throw DictationError.microphoneDenied }
    guard let recognizer = SFSpeechRecognizer(locale: locale) ?? SFSpeechRecognizer(), recognizer.isAvailable else {
      throw DictationError.language(locale.localizedString(forIdentifier: locale.identifier) ?? locale.identifier)
    }
    let session = AVAudioSession.sharedInstance()
    try session.setCategory(.record, mode: .measurement, options: .duckOthers)
    try session.setActive(true, options: .notifyOthersOnDeactivation)
    self.recognizer = recognizer
    self.onEvent = onEvent

    // With no input (a call holds the mic, or the route just changed) the
    // format has no channels, and a tap with it raises an exception.
    let input = audio.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0 else {
      stop()
      throw DictationError.unavailable
    }
    beginTask()
    Self.installTap(on: input, format: format, feeding: feed)
    tapInstalled = true
    audio.prepare()
    do {
      try audio.start()
    } catch {
      stop()
      throw error
    }
  }

  /// A recognition task per stretch of speech. Apple's recognizer may end the
  /// task after a pause or a minute; the mic keeps listening into a new one.
  private func beginTask() {
    guard let recognizer, let onEvent else { return }
    let request = SFSpeechAudioBufferRecognitionRequest()
    request.shouldReportPartialResults = true
    request.addsPunctuation = true
    request.taskHint = .dictation
    request.contextualStrings = ["SpecWeave", "SpecWithCode", "coordinator", "increment"]
    if recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }
    feed.request = request
    task = Self.recognitionTask(recognizer, request: request, onEvent: onEvent) { [weak self] in
      guard let self, self.task != nil, self.feed.request === request else { return }
      self.task = nil
      self.beginTask()
    }
  }

  func stop() {
    if audio.isRunning { audio.stop() }
    if tapInstalled {
      audio.inputNode.removeTap(onBus: 0)
      tapInstalled = false
    }
    feed.request?.endAudio()
    feed.request = nil
    task?.finish()
    task = nil
    recognizer = nil
    onEvent = nil
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }

  /// Runs on the audio thread.
  private nonisolated static func installTap(on input: AVAudioInputNode, format: AVAudioFormat, feeding feed: RecognitionFeed) {
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
      feed.request?.append(buffer)
    }
  }

  /// The handler runs on the recognizer's queue and hops to the main actor.
  /// A phrase is settled when the recognizer says the utterance ended (it
  /// starts its next transcript empty) as well as when the task finishes.
  private nonisolated static func recognitionTask(
    _ recognizer: SFSpeechRecognizer,
    request: SFSpeechAudioBufferRecognitionRequest,
    onEvent: @escaping @MainActor (SpeechEvent) -> Void,
    onEnded: @escaping @MainActor () -> Void
  ) -> SFSpeechRecognitionTask {
    recognizer.recognitionTask(with: request) { result, error in
      let text = result?.bestTranscription.formattedString
      let taskEnded = (result?.isFinal ?? false) || (error.map { ($0 as NSError).code == 1110 } ?? false)
      let settled = (result?.isFinal ?? false) || result?.speechRecognitionMetadata != nil
      // Cancelled by stop (216, 301) or no speech heard (1110): not failures.
      let failure = error.flatMap { [216, 301, 1110].contains(($0 as NSError).code) ? nil : $0.localizedDescription }
      Task { @MainActor in
        if let text { onEvent(settled ? .final(text) : .partial(text)) }
        if let failure { onEvent(.failed(failure)) } else if taskEnded { onEnded() }
      }
    }
  }

  /// The system answers on a queue of its own.
  private nonisolated static func speechAllowed() async -> Bool {
    switch SFSpeechRecognizer.authorizationStatus() {
    case .authorized: return true
    case .notDetermined:
      return await withCheckedContinuation { done in
        SFSpeechRecognizer.requestAuthorization { done.resume(returning: $0 == .authorized) }
      }
    default: return false
    }
  }
}

/// The request the audio tap feeds; swapped when a new recognition task starts.
nonisolated final class RecognitionFeed: @unchecked Sendable {
  private let lock = NSLock()
  private var current: SFSpeechAudioBufferRecognitionRequest?
  var request: SFSpeechAudioBufferRecognitionRequest? {
    get { lock.withLock { current } }
    set { lock.withLock { current = newValue } }
  }
}
#endif
