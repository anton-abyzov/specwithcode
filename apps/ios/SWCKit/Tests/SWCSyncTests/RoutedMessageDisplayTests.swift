import Foundation
import Testing
import SWCWire
@testable import SWCSync

/// Mirrors `packages/shared/src/routedMessage.test.ts`, and the display rules of
/// `apps/web/src/studio/projectCoordinatorMessageDisplay.ts`.
@Suite("Routed message display")
struct RoutedMessageDisplayTests {
  /// `routedMessageText` in the TypeScript: what the server stores.
  static func routedText(title: String = "Aide", threadId: String = "project-coordinator:aide", messageId: String = "m:1", note: String? = nil, words: String) -> String {
    func oneLine(_ text: String, _ max: Int) -> String {
      let flat = text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
      return flat.count > max ? String(flat.prefix(max - 1)) + "…" : flat
    }
    let shown = oneLine(title, 120).replacingOccurrences(of: "\"", with: "'")
    let flatNote = note.map { oneLine($0, 500) }.flatMap { $0.isEmpty ? nil : $0 }
    let noteText = flatNote.map { " Assistant note: \($0)" } ?? ""
    return "Routed from personal assistant \"\(shown.isEmpty ? "Assistant" : shown)\" (thread \(threadId), message \(messageId)).\(noteText) The text after this line is the user's own request.\n\n" + words
  }

  @Test func roundTripsTheUsersWordsUnchanged() throws {
    let words = "Audit EasyChamp's signup flow.\n\nKeep the \"beta\" label."
    let parsed = try #require(RoutedMessageDisplay.parseRoutedMessage(Self.routedText(words: words)))
    #expect(parsed == .init(assistantTitle: "Aide", threadId: "project-coordinator:aide", messageId: "m:1", note: nil, words: words))
  }

  @Test func keepsTheAssistantsNoteOnOneBoundedLine() throws {
    let parsed = try #require(RoutedMessageDisplay.parseRoutedMessage(Self.routedText(note: "Only the\nEasyChamp part.  ", words: "Do both")))
    #expect(parsed.note == "Only the EasyChamp part.")
    #expect(parsed.words == "Do both")
    let long = try #require(RoutedMessageDisplay.parseRoutedMessage(Self.routedText(note: String(repeating: "x", count: 900), words: "w")))
    #expect(long.note?.count == 500)
  }

  @Test func cannotBeBrokenByQuotesInTheAssistantsName() throws {
    let parsed = try #require(RoutedMessageDisplay.parseRoutedMessage(Self.routedText(title: "My \"Aide\"", words: "w")))
    #expect(parsed.assistantTitle == "My 'Aide'")
  }

  @Test func ignoresTextWithoutTheHeaderIncludingAQuote() {
    #expect(RoutedMessageDisplay.parseRoutedMessage("Just do it") == nil)
    #expect(RoutedMessageDisplay.parseRoutedMessage("Look: \(Self.routedText(words: "nested"))") == nil)
  }

  // MARK: - Replies from another machine

  let names = ["env-m1": "M1"]
  func label(_ id: String) -> String { names[id] ?? id }

  @Test func threadReplyShowsTitleAndMachineName() {
    let text = "Regarding thread thr_42 on machine env-m1 (Fix login):\n\nShip it"
    #expect(RoutedMessageDisplay.routedThreadReplyDisplayText(text, machineLabel: label) == "Regarding Fix login on M1:\n\nShip it")
  }

  @Test func threadReplyHidesAnUnnamedMachineId() {
    let text = "Regarding thread thr_42 on machine 1f3a9c2e-77aa-4b2c (  ):\n\nShip it"
    #expect(RoutedMessageDisplay.routedThreadReplyDisplayText(text, machineLabel: label) == "Regarding another thread on another machine:\n\nShip it")
  }

  @Test func personsOwnRegardingLineIsLeftAlone() {
    let text = "Regarding thread x on machine y (z):\n\nmy words"
    #expect(RoutedMessageDisplay.routedThreadReplyDisplayText(text, machineLabel: label) == text)
    #expect(RoutedMessageDisplay.routedThreadReplyDisplayText("Plain text", machineLabel: label) == "Plain text")
  }

  @Test func threadReplyParses() throws {
    let reply = try #require(RoutedMessageDisplay.parseRoutedThreadReply("Regarding thread thr_1 on machine env-m1 (A (b) c):\n\nwords\n\nmore"))
    #expect(reply == .init(threadId: "thr_1", environmentId: "env-m1", title: "A (b) c", words: "words\n\nmore"))
    #expect(RoutedMessageDisplay.parseRoutedThreadReply("Hi. Regarding thread thr_1 on machine env-m1 (A):\n\nw") == nil)
  }

  // MARK: - User rows

  @Test func routedRequestShowsOnlyTheWordsWhenTheSenderMatches() {
    let stored = Self.routedText(words: "Audit signup")
    let shown = RoutedMessageDisplay.text(stored, messageId: "coordinator-send:proj_1:abc", createdBy: .user, senderThreadId: "project-coordinator:aide", machineLabel: nil)
    #expect(shown == "Audit signup")
    // Another sender, or no coordinator-send id: the text is not the assistant's.
    #expect(RoutedMessageDisplay.text(stored, messageId: "coordinator-send:proj_1:abc", createdBy: .user, senderThreadId: "thr_other", machineLabel: nil) == stored)
    #expect(RoutedMessageDisplay.text(stored, messageId: "msg_1", createdBy: .user, senderThreadId: "project-coordinator:aide", machineLabel: nil) == stored)
    #expect(RoutedMessageDisplay.text(stored, messageId: "coordinator-send:proj_1:abc", createdBy: .agent, senderThreadId: "project-coordinator:aide", machineLabel: nil) == stored)
  }

  @Test func workerFollowUpShowsTheWords() {
    let tail = ". Review that thread and decide whether to reuse it or route elsewhere.\n\n"
    let id = "coordinator-send:proj_1:m9"
    let current = "User follow-up from selected worker thr_w, message \(id)\(tail)Use the old API"
    let older = "User follow-up from selected worker thr_w\(tail)Use the old API"
    #expect(RoutedMessageDisplay.text(current, messageId: id, createdBy: .user, senderThreadId: "thr_w", machineLabel: nil) == "Use the old API")
    #expect(RoutedMessageDisplay.text(older, messageId: id, createdBy: .user, senderThreadId: "thr_w", machineLabel: nil) == "Use the old API")
    #expect(RoutedMessageDisplay.text(older, messageId: id, createdBy: .user, senderThreadId: "thr_other", machineLabel: nil) == older)
    #expect(RoutedMessageDisplay.text(older, messageId: "coordinator-send:", createdBy: .user, senderThreadId: "thr_w", machineLabel: nil) == older)
  }

  @Test func mapperRewritesUserRowsButNotTheStoredText() {
    let stored = "Regarding thread thr_42 on machine env-m1 (Fix login):\n\nShip it"
    var message = TurnItem.UserMessage(messageId: "msg_1", text: stored)
    message.senderThreadId = nil
    let item = TurnItem(id: "ti_u", threadId: "thr_c", ordinal: 1, status: .completed, updatedAt: Date(timeIntervalSince1970: 0), content: .userMessage(message))
    #expect(TranscriptMapper.kind(for: item, environmentId: "env", machineLabel: label) == .user(text: "Regarding Fix login on M1:\n\nShip it"))
    // Without a resolver the row is the stored text.
    #expect(TranscriptMapper.kind(for: item, environmentId: "env") == .user(text: stored))
    guard case let .userMessage(kept) = item.content else { return }
    #expect(kept.text == stored)
  }

  @Test func queuedRowsShowTheWords() throws {
    struct Snapshot: Decodable { let projection: ThreadProjection }
    var projection = try TestData.decode(Snapshot.self, FixtureJSON.threadSnapshot).projection
    var run = projection.runs[0]
    run.id = "run_2"
    run.ordinal = 2
    run.status = .queued
    run.userMessageId = "coordinator-send:proj_1:q"
    run.startedAt = nil
    projection.runs.append(run)
    var queued = projection.messages[0]
    queued.id = "coordinator-send:proj_1:q"
    queued.runId = run.id
    queued.createdBy = .user
    queued.senderThreadId = "project-coordinator:aide"
    queued.text = Self.routedText(words: "Then deploy")
    projection.messages.append(queued)
    let rows = TranscriptMapper.rows(for: projection, environmentId: "env", machineLabel: label)
    #expect(rows.last == TranscriptRow(id: "queued:run_2", kind: .user(text: "Then deploy", state: .queued)))
  }
}
