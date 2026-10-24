// studio-voice: on-device speech helper for SpecWithCode voice calls (macOS).
//
// Protocol: one JSON object per line on stdin, one JSON reply per line on stdout.
//   {"id":1,"op":"status"}                          -> {"id":1,"ok":true,"speech":"authorized|denied|restricted|notDetermined","engine":"analyzer|recognizer"}
//   {"id":2,"op":"authorize"}                       -> same shape as status, after the system prompt
//   {"id":5,"op":"prepare","locale":"en-US"}       -> {"id":5,"ok":true} (loads the speech model)
//   {"id":3,"op":"transcribe","path":"/x.wav","locale":"en-US"} -> {"id":3,"ok":true,"text":"..."}
//   {"id":4,"op":"speak","text":"...","path":"/y.wav","voice":"<identifier>"}  -> {"id":4,"ok":true}
// Audio never leaves the Mac: transcription and speech run on-device.

import AVFoundation
import Foundation
import Speech

struct Request: Decodable {
  let id: Int
  let op: String
  let path: String?
  let locale: String?
  let text: String?
  let voice: String?
  let rate: Float?
}

struct HelperError: Error {
  let message: String
}

let output = FileHandle.standardOutput
let outputLock = NSLock()

func reply(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
  outputLock.lock()
  output.write(data)
  output.write(Data([0x0A]))
  outputLock.unlock()
}

func speechStatusName(_ status: SFSpeechRecognizerAuthorizationStatus) -> String {
  switch status {
  case .authorized: return "authorized"
  case .denied: return "denied"
  case .restricted: return "restricted"
  case .notDetermined: return "notDetermined"
  @unknown default: return "denied"
  }
}

func engineName() -> String {
  if #available(macOS 26.0, *) { return "analyzer" }
  return "recognizer"
}

func requestSpeechAuthorization() async -> SFSpeechRecognizerAuthorizationStatus {
  let current = SFSpeechRecognizer.authorizationStatus()
  if current != .notDetermined { return current }
  return await withCheckedContinuation { continuation in
    SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
  }
}

@available(macOS 26.0, *)
func transcribeWithAnalyzer(url: URL, localeId: String) async throws -> String {
  let requested = Locale(identifier: localeId)
  guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: requested) else {
    throw HelperError(message: "unsupported-locale")
  }
  let transcriber = SpeechTranscriber(
    locale: locale, transcriptionOptions: [], reportingOptions: [], attributeOptions: [])
  if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
    try await request.downloadAndInstall()
  }
  let analyzer = SpeechAnalyzer(modules: [transcriber])
  let collector = Task { () throws -> String in
    var text = ""
    for try await result in transcriber.results where result.isFinal {
      text += String(result.text.characters)
    }
    return text
  }
  let file = try AVAudioFile(forReading: url)
  if let last = try await analyzer.analyzeSequence(from: file) {
    try await analyzer.finalizeAndFinish(through: last)
  } else {
    await analyzer.cancelAndFinishNow()
  }
  return try await collector.value.trimmingCharacters(in: .whitespacesAndNewlines)
}

/// Loads the speech model ahead of the first utterance so the first answer is not slow.
@available(macOS 26.0, *)
func prepareAnalyzer(localeId: String) async throws {
  guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: localeId))
  else { throw HelperError(message: "unsupported-locale") }
  let transcriber = SpeechTranscriber(
    locale: locale, transcriptionOptions: [], reportingOptions: [], attributeOptions: [])
  if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
    try await request.downloadAndInstall()
  }
  let analyzer = SpeechAnalyzer(modules: [transcriber])
  let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber])
  try await analyzer.prepareToAnalyze(in: format)
  await analyzer.cancelAndFinishNow()
}

func transcribeWithRecognizer(url: URL, localeId: String) async throws -> String {
  guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeId)),
    recognizer.isAvailable
  else {
    throw HelperError(message: "unsupported-locale")
  }
  let request = SFSpeechURLRecognitionRequest(url: url)
  request.shouldReportPartialResults = false
  guard recognizer.supportsOnDeviceRecognition else {
    throw HelperError(message: "local-recognition-unavailable")
  }
  request.requiresOnDeviceRecognition = true
  return try await withCheckedThrowingContinuation { continuation in
    var finished = false
    recognizer.recognitionTask(with: request) { result, error in
      if finished { return }
      if let error {
        finished = true
        // "No speech detected" is an empty utterance, not a failure.
        let nsError = error as NSError
        if nsError.domain == "kAFAssistantErrorDomain" && nsError.code == 1110 {
          continuation.resume(returning: "")
        } else {
          continuation.resume(throwing: error)
        }
        return
      }
      if let result, result.isFinal {
        finished = true
        continuation.resume(returning: result.bestTranscription.formattedString)
      }
    }
  }
}

func transcribe(path: String, localeId: String) async throws -> String {
  let url = URL(fileURLWithPath: path)
  if #available(macOS 26.0, *) {
    return try await transcribeWithAnalyzer(url: url, localeId: localeId)
  }
  let status = await requestSpeechAuthorization()
  guard status == .authorized else { throw HelperError(message: "speech-not-authorized") }
  return try await transcribeWithRecognizer(url: url, localeId: localeId)
}

/// The highest-quality installed voice for the language; novelty and Personal Voice are skipped.
func bestVoice(language: String) -> AVSpeechSynthesisVoice? {
  let prefix = String(language.prefix(2))
  let candidates = AVSpeechSynthesisVoice.speechVoices().filter {
    $0.language == language || $0.language.hasPrefix(prefix + "-")
  }.filter { voice in
    if #available(macOS 14.0, *) {
      return voice.voiceTraits.isDisjoint(with: [.isNoveltyVoice, .isPersonalVoice])
    }
    return true
  }
  let ranked = candidates.sorted { left, right in
    if left.quality != right.quality { return left.quality.rawValue > right.quality.rawValue }
    if (left.language == language) != (right.language == language) { return left.language == language }
    func naturalRank(_ voice: AVSpeechSynthesisVoice) -> Int {
      if voice.identifier.contains("siri.natural") { return 3 }
      if voice.identifier.contains("com.apple.voice.") && !voice.identifier.contains("super-compact") { return 2 }
      if voice.identifier.contains("com.apple.voice.") { return 1 }
      return 0
    }
    if naturalRank(left) != naturalRank(right) { return naturalRank(left) > naturalRank(right) }
    return left.name < right.name
  }
  return ranked.first ?? AVSpeechSynthesisVoice(language: language)
}

final class SpeechWriter: NSObject, AVSpeechSynthesizerDelegate {
  private let synthesizer = AVSpeechSynthesizer()
  private var file: AVAudioFile?
  private var continuation: CheckedContinuation<Void, Error>?
  private var writeError: Error?

  func write(text: String, voice: String?, rate: Float?, to url: URL) async throws {
    let utterance = AVSpeechUtterance(string: text)
    if let voice, let selected = AVSpeechSynthesisVoice(identifier: voice) {
      utterance.voice = selected
    } else {
      utterance.voice = bestVoice(language: AVSpeechSynthesisVoice.currentLanguageCode())
    }
    // A slightly calmer conversational pace, without altering pitch or the recorded waveform.
    utterance.rate = min(0.6, max(0.35, rate ?? 0.47))
    utterance.preUtteranceDelay = 0.08
    utterance.postUtteranceDelay = 0.12
    try? FileManager.default.removeItem(at: url)
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      self.continuation = continuation
      synthesizer.write(utterance) { [weak self] buffer in
        guard let self else { return }
        guard let pcm = buffer as? AVAudioPCMBuffer else { return }
        if pcm.frameLength == 0 {
          self.finish()
          return
        }
        do {
          if self.file == nil {
            self.file = try AVAudioFile(
              forWriting: url, settings: pcm.format.settings, commonFormat: pcm.format.commonFormat,
              interleaved: pcm.format.isInterleaved)
          }
          try self.file?.write(from: pcm)
        } catch {
          self.writeError = error
          self.finish()
        }
      }
    }
  }

  private func finish() {
    guard let continuation else { return }
    self.continuation = nil
    file = nil
    if let writeError {
      continuation.resume(throwing: writeError)
    } else {
      continuation.resume()
    }
  }
}

func handle(_ request: Request) async {
  do {
    switch request.op {
    case "status":
      reply([
        "id": request.id, "ok": true,
        "speech": speechStatusName(SFSpeechRecognizer.authorizationStatus()),
        "engine": engineName(),
      ])
    case "voices":
      let voices = AVSpeechSynthesisVoice.speechVoices().filter { voice in
        if #available(macOS 14.0, *) { return voice.voiceTraits.isDisjoint(with: [.isNoveltyVoice, .isPersonalVoice]) }
        return true
      }.map { voice -> [String: Any] in
        ["id": voice.identifier, "name": voice.name, "language": voice.language, "quality": voice.quality.rawValue]
      }
      reply(["id": request.id, "ok": true, "voices": voices])
    case "authorize":
      let status = await requestSpeechAuthorization()
      reply(["id": request.id, "ok": true, "speech": speechStatusName(status), "engine": engineName()])
    case "prepare":
      if #available(macOS 26.0, *) {
        try await prepareAnalyzer(localeId: request.locale ?? Locale.current.identifier)
      } else {
        let status = await requestSpeechAuthorization()
        guard status == .authorized else { throw HelperError(message: "speech-not-authorized") }
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: request.locale ?? Locale.current.identifier)),
          recognizer.isAvailable else { throw HelperError(message: "unsupported-locale") }
        guard recognizer.supportsOnDeviceRecognition else {
          throw HelperError(message: "local-recognition-unavailable")
        }
      }
      reply(["id": request.id, "ok": true])
    case "transcribe":
      guard let path = request.path else { throw HelperError(message: "missing-path") }
      let text = try await transcribe(path: path, localeId: request.locale ?? Locale.current.identifier)
      reply(["id": request.id, "ok": true, "text": text])
    case "speak":
      guard let path = request.path, let text = request.text else {
        throw HelperError(message: "missing-text")
      }
      try await SpeechWriter().write(text: text, voice: request.voice, rate: request.rate, to: URL(fileURLWithPath: path))
      reply(["id": request.id, "ok": true])
    default:
      throw HelperError(message: "unknown-op")
    }
  } catch let error as HelperError {
    reply(["id": request.id, "ok": false, "error": error.message])
  } catch {
    reply(["id": request.id, "ok": false, "error": error.localizedDescription])
  }
}

let decoder = JSONDecoder()
Task.detached {
  while let line = readLine(strippingNewline: true) {
    guard let data = line.data(using: .utf8), !line.isEmpty else { continue }
    guard let request = try? decoder.decode(Request.self, from: data) else {
      reply(["id": -1, "ok": false, "error": "bad-request"])
      continue
    }
    // Requests run in order: one utterance at a time keeps the model warm and memory flat.
    await handle(request)
  }
  exit(0)
}
RunLoop.main.run()
