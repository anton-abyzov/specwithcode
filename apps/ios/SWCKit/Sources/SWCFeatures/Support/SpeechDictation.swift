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
/// there unsent, as with desktop dictation.
@MainActor
@Observable
final class SpeechDictation {
  enum Phase: Equatable { case idle, starting, listening }

  private(set) var phase: Phase = .idle
  private(set) var error: String?
  @ObservationIgnored private let makeEngine: @MainActor () -> SpeechEngine
  @ObservationIgnored private var engine: SpeechEngine?
  /// The draft before the words being heard now; partial results replace
  /// only what follows it.
  @ObservationIgnored private var base: String?

  init(makeEngine: @escaping @MainActor () -> SpeechEngine = { SpeechDictation.systemEngine() }) {
    self.makeEngine = makeEngine
  }

  var isActive: Bool { phase != .idle }

  func toggle(language: String, draft: Binding<String>) {
    isActive ? stop() : start(language: language, draft: draft)
  }

  func start(language: String, draft: Binding<String>) {
    guard phase == .idle else { return }
    error = nil
    phase = .starting
    base = draft.wrappedValue
    let engine = makeEngine()
    self.engine = engine
    Task {
      do {
        try await engine.start(locale: DictationText.locale(language)) { [weak self] event in
          self?.handle(event, draft: draft)
        }
        if self.engine === engine, phase == .starting { phase = .listening }
      } catch {
        if self.engine === engine { fail(error.localizedDescription) }
      }
    }
  }

  func stop() {
    engine?.stop()
    engine = nil
    base = nil
    phase = .idle
  }

  private func handle(_ event: SpeechEvent, draft: Binding<String>) {
    guard let base else { return }
    switch event {
    case let .partial(text):
      if phase == .starting { phase = .listening }
      draft.wrappedValue = DictationText.insert(text, into: base)
    case let .final(text):
      let settled = DictationText.insert(text, into: base)
      draft.wrappedValue = settled
      self.base = settled
    case let .failed(message):
      fail(message)
    }
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
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var task: SFSpeechRecognitionTask?
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

    let request = SFSpeechAudioBufferRecognitionRequest()
    request.shouldReportPartialResults = true
    request.addsPunctuation = true
    request.taskHint = .dictation
    request.contextualStrings = ["SpecWeave", "SpecWithCode", "coordinator", "increment"]
    if recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }
    self.request = request

    // With no input (a call holds the mic, or the route just changed) the
    // format has no channels, and a tap with it raises an exception.
    let input = audio.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0 else {
      stop()
      throw DictationError.unavailable
    }
    Self.installTap(on: input, format: format, feeding: request)
    tapInstalled = true
    audio.prepare()
    do {
      try audio.start()
    } catch {
      stop()
      throw error
    }
    task = Self.recognitionTask(recognizer, request: request, onEvent: onEvent)
  }

  func stop() {
    if audio.isRunning { audio.stop() }
    if tapInstalled {
      audio.inputNode.removeTap(onBus: 0)
      tapInstalled = false
    }
    request?.endAudio()
    task?.finish()
    request = nil
    task = nil
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }

  /// Runs on the audio thread.
  private nonisolated static func installTap(on input: AVAudioInputNode, format: AVAudioFormat, feeding request: SFSpeechAudioBufferRecognitionRequest) {
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
      request.append(buffer)
    }
  }

  /// The handler runs on the recognizer's queue and hops to the main actor.
  private nonisolated static func recognitionTask(_ recognizer: SFSpeechRecognizer, request: SFSpeechAudioBufferRecognitionRequest, onEvent: @escaping @MainActor (SpeechEvent) -> Void) -> SFSpeechRecognitionTask {
    recognizer.recognitionTask(with: request) { result, error in
      let text = result?.bestTranscription.formattedString
      let isFinal = result?.isFinal ?? false
      // Cancelled by stop (216, 301) or no speech heard (1110): not failures.
      let failure = error.flatMap { [216, 301, 1110].contains(($0 as NSError).code) ? nil : $0.localizedDescription }
      Task { @MainActor in
        if let text { onEvent(isFinal ? .final(text) : .partial(text)) }
        if let failure { onEvent(.failed(failure)) }
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
#endif
