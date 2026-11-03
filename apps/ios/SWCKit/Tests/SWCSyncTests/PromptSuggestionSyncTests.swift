import Foundation
import Testing
import SWCWire
@testable import SWCSync

@Suite struct PromptSuggestionSyncTests {
  static let suggestion = PromptSuggestion(text: "Run the tests", source: "generated")

  /// The fixture thread with run_1 completed and its next prompt suggested.
  static func suggestedState() throws -> (state: ThreadState, sequence: Int, event: DomainEvent, run: Run) {
    var state = try TestData.threadState()
    let (_, template) = try TestData.event(3)
    var run = try #require(state.projection?.runs.first { $0.id == "run_1" })
    run.status = .completed
    var event = template
    event.type = "run.updated"
    event.payload = .run(run)
    state.apply(.event(sequence: 300, event: event))
    var suggested = template
    suggested.type = "run.prompt-suggested"
    suggested.payload = .promptSuggestion(RunPromptSuggestion(runId: "run_1", promptSuggestion: suggestion))
    let changed = state.apply(.event(sequence: 301, event: suggested))
    #expect(changed)
    return (state, 301, event, run)
  }

  @Test func promptSuggestedSetsTheRun() throws {
    let (state, _, _, _) = try Self.suggestedState()
    let projection = try #require(state.projection)
    #expect(projection.runs.first { $0.id == "run_1" }?.promptSuggestion == Self.suggestion)
    #expect(TranscriptMapper.promptSuggestion(projection) == "Run the tests")
  }

  @Test func theSettingHidesSuggestionsItExcludes() throws {
    let (state, _, _, _) = try Self.suggestedState()
    let projection = try #require(state.projection)
    #expect(TranscriptMapper.promptSuggestion(projection, mode: "all") == "Run the tests")
    #expect(TranscriptMapper.promptSuggestion(projection, mode: "native") == nil)
    #expect(TranscriptMapper.promptSuggestion(projection, mode: "off") == nil)
  }

  @Test func settingsDecodePromptSuggestions() throws {
    let decode = { (json: String) in try JSONDecoder().decode(ServerSettings.self, from: Data(json.utf8)) }
    #expect(try decode(#"{"promptSuggestions":"native"}"#).promptSuggestions == "native")
    #expect(try decode("{}").promptSuggestions == "all")
  }

  @Test func runUpdatedKeepsTheSuggestion() throws {
    var (state, sequence, event, run) = try Self.suggestedState()
    run.completedAt = TestData.date("2026-10-18T06:30:00.000Z")
    run.promptSuggestion = nil
    event.payload = .run(run)
    state.apply(.event(sequence: sequence + 1, event: event))
    let projection = try #require(state.projection)
    #expect(projection.runs.first { $0.id == "run_1" }?.completedAt == run.completedAt)
    #expect(projection.runs.first { $0.id == "run_1" }?.promptSuggestion == Self.suggestion)
  }

  @Test func suggestionForAnUnknownRunIsIgnored() throws {
    var state = try TestData.threadState()
    var (_, event) = try TestData.event(3)
    event.type = "run.prompt-suggested"
    event.payload = .promptSuggestion(RunPromptSuggestion(runId: "run_missing", promptSuggestion: Self.suggestion))
    let changed = state.apply(.event(sequence: 300, event: event))
    #expect(!changed)
  }

  @Test func noSuggestionWhileTheLatestRunWorks() throws {
    var (state, sequence, event, run) = try Self.suggestedState()
    var projection = try #require(state.projection)
    #expect(TranscriptMapper.promptSuggestion(projection) != nil)

    // A newer run that is still running hides the old suggestion.
    var next = run
    next.id = "run_9"
    next.ordinal = run.ordinal + 10
    next.status = .running
    next.promptSuggestion = nil
    event.type = "run.created"
    event.payload = .run(next)
    state.apply(.event(sequence: sequence + 1, event: event))
    projection = try #require(state.projection)
    #expect(TranscriptMapper.promptSuggestion(projection) == nil)

    // The latest run running again also hides it.
    var again = run
    again.status = .running
    again.ordinal = next.ordinal + 1
    event.type = "run.updated"
    event.payload = .run(again)
    state.apply(.event(sequence: sequence + 2, event: event))
    projection = try #require(state.projection)
    #expect(projection.runs.first { $0.id == "run_1" }?.promptSuggestion == Self.suggestion)
    #expect(TranscriptMapper.promptSuggestion(projection) == nil)
  }

  @Test func blankSuggestionIsNotOffered() throws {
    var (state, sequence, event, _) = try Self.suggestedState()
    event.type = "run.prompt-suggested"
    event.payload = .promptSuggestion(RunPromptSuggestion(runId: "run_1", promptSuggestion: PromptSuggestion(text: "  ", source: "provider")))
    state.apply(.event(sequence: sequence + 1, event: event))
    #expect(TranscriptMapper.promptSuggestion(try #require(state.projection)) == nil)
  }
}

extension LiveEngineTests {
  @Test func chatSessionPromptSuggestionFollowsTheLatestRun() async throws {
    let h = try await harness()
    #expect(await loaded(h))
    let target = ChatTarget.thread(ThreadRef(environmentId: env, threadId: "thr_1"))
    let session = h.model.session(for: target)
    h.engine.open(session)
    #expect(await until { session.isLoaded && session.isRunning })
    #expect(session.promptSuggestion == nil)

    let streamId = try #require(h.machine.requests("orchestration.subscribeThread").last?["id"]?.intValue)
    let socket = try #require(h.connector.connections.values.last)
    let (_, template) = try TestData.event(3)
    var run = try #require(TestData.threadState().projection?.runs.first { $0.id == "run_1" })
    func push(_ sequence: Int, _ type: String, _ payload: DomainEvent.Payload) throws {
      var event = template
      event.id = "ev_\(sequence)"
      event.type = type
      event.payload = payload
      let json = String(decoding: try WireCoding.encoder.encode(ThreadStreamItem.event(sequence: sequence, event: event)), as: UTF8.self)
      socket.push(FakeMachine.chunk(streamId, json))
    }

    // Suggested while the run still works: nothing shows yet.
    try push(300, "run.prompt-suggested", .promptSuggestion(RunPromptSuggestion(runId: "run_1", promptSuggestion: PromptSuggestionSyncTests.suggestion)))
    run.status = .completed
    try push(301, "run.updated", .run(run))
    #expect(await until { !session.isRunning && session.promptSuggestion == "Run the tests" })

    // A new prompt runs: the suggestion goes away.
    var next = run
    next.id = "run_9"
    next.ordinal = run.ordinal + 10
    next.status = .running
    try push(302, "run.created", .run(next))
    #expect(await until { session.isRunning && session.promptSuggestion == nil })
    h.engine.close(session)
  }
}
