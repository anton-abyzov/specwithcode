import Foundation
import Testing
import SWCWire

@Suite("PromptSuggestion wire")
struct PromptSuggestionWireTests {
  static let run = #""id":"run_1","threadId":"thr_1","ordinal":1,"providerInstanceId":"claudeAgent","modelSelection":{"instanceId":"claudeAgent","model":"claude-opus-5-5"},"userMessageId":"msg_1","status":"completed","requestedAt":"2026-10-18T06:11:00.000Z""#

  @Test func runWithoutSuggestion() throws {
    let run = try decodeJSON(Run.self, "{\(Self.run)}")
    #expect(run.promptSuggestion == nil)
    #expect(try encodeToJSON(run)["promptSuggestion"] == nil)
  }

  @Test func runWithSuggestion() throws {
    let run = try decodeJSON(Run.self, #"{\#(Self.run),"promptSuggestion":{"text":"Open a PR","source":"provider"}}"#)
    #expect(run.promptSuggestion == PromptSuggestion(text: "Open a PR", source: "provider"))
    let round = try encodeToJSON(run)
    #expect(round["promptSuggestion"]?["text"] == .string("Open a PR"))
    #expect(round["promptSuggestion"]?["source"] == .string("provider"))
  }

  @Test func malformedSuggestionKeepsTheRun() throws {
    let run = try decodeJSON(Run.self, #"{\#(Self.run),"promptSuggestion":{"text":7}}"#)
    #expect(run.id == "run_1")
    #expect(run.promptSuggestion == nil)
  }

  @Test func promptSuggestedEvent() throws {
    let json = #"{"id":"ev_ps","threadId":"thr_1","runId":"run_1","occurredAt":"2026-10-18T06:20:00.000Z","type":"run.prompt-suggested","payload":{"runId":"run_1","promptSuggestion":{"text":"Run the tests","source":"generated"}}}"#
    let event = try decodeJSON(DomainEvent.self, json)
    #expect(DomainEvent.typedEventTypes.contains("run.prompt-suggested"))
    #expect(!event.isUnknown)
    guard case let .promptSuggestion(payload) = event.payload else {
      Issue.record("Expected a prompt suggestion payload")
      return
    }
    #expect(payload == RunPromptSuggestion(runId: "run_1", promptSuggestion: PromptSuggestion(text: "Run the tests", source: "generated")))
    #expect(try encodeToJSON(event) == decodeJSON(JSONValue.self, json))
  }

  @Test func malformedPromptSuggestedEventFails() {
    #expect(throws: DecodingError.self) {
      try decodeJSON(DomainEvent.self, #"{"id":"ev_ps","threadId":"thr_1","occurredAt":"2026-10-18T06:20:00.000Z","type":"run.prompt-suggested","payload":{"runId":"run_1"}}"#)
    }
  }
}
