import Foundation
import Testing
@testable import SWCWire

@Suite struct MachineIdentityWireTests {
  private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try WireCoding.decoder.decode(type, from: Data(json.utf8))
  }

  @Test func nicknameDecodesColorIconAndShort() throws {
    let entry = try decode(MachineNicknameEntry.self, #"{"name":"M4","updatedAt":"2026-11-01T00:00:00.000Z","color":"teal","icon":"mac-mini","short":"M4"}"#)
    #expect(entry == MachineNicknameEntry(name: "M4", updatedAt: "2026-11-01T00:00:00.000Z", color: "teal", icon: "mac-mini", short: "M4"))
  }

  @Test func olderServerSendsNameAndStampOnly() throws {
    let entry = try decode(MachineNicknameEntry.self, #"{"name":"M4","updatedAt":"2026-11-01T00:00:00.000Z"}"#)
    #expect(entry.color == nil && entry.icon == nil && entry.short == nil)
  }

  @Test func malformedIdentityFieldKeepsTheNickname() throws {
    let entry = try decode(MachineNicknameEntry.self, #"{"name":"M4","updatedAt":"2026-11-01T00:00:00.000Z","color":7,"icon":null}"#)
    #expect(entry.name == "M4")
    #expect(entry.color == nil && entry.icon == nil)
  }

  @Test func nicknameEncodesWhatItDecoded() throws {
    let json = #"{"name":"M4","updatedAt":"2026-11-01T00:00:00.000Z","color":"teal","icon":"mac-mini","short":"M4"}"#
    let entry = try decode(MachineNicknameEntry.self, json)
    let data = try JSONEncoder().encode(entry)
    let object = try #require(JSONSerialization.jsonObject(with: data) as? [String: String])
    #expect(object == ["name": "M4", "updatedAt": "2026-11-01T00:00:00.000Z", "color": "teal", "icon": "mac-mini", "short": "M4"])
    // A color this build cannot draw is still written back as it came.
    let future = try decode(MachineNicknameEntry.self, #"{"name":"M4","updatedAt":"x","color":"magenta"}"#)
    #expect(try decode(MachineNicknameEntry.self, String(decoding: JSONEncoder().encode(future), as: UTF8.self)).color == "magenta")
  }

  @Test func settingsCarryEveryMachinesIdentity() throws {
    let settings = try decode(ServerSettings.self, #"{"machineNicknames":{"env-a":{"name":"M4","updatedAt":"2026-11-01T00:00:00.000Z","color":"rose"},"env-b":{"name":7}}}"#)
    #expect(settings.machineNicknames.keys.sorted() == ["env-a"])
    #expect(settings.machineNicknames["env-a"]?.color == "rose")
  }

  @Test func activeWorkDecodesItsKind() throws {
    for kind in ActiveWorkKind.allCases {
      let work = try decode(ActiveWork.self, #"{"label":"npm test","startedAt":"2026-11-01T00:00:00.000Z","kind":"\#(kind.rawValue)"}"#)
      #expect(work.kind == kind)
    }
    #expect(ActiveWorkKind.allCases.map(\.rawValue) == ["command", "tool", "subagent", "thread", "task"])
  }

  @Test func activeWorkWithoutOrWithAnUnknownKindStillDecodes() throws {
    let older = try decode(ActiveWork.self, #"{"label":"npm test","startedAt":"2026-11-01T00:00:00.000Z"}"#)
    #expect(older.kind == nil && older.label == "npm test")
    let newer = try decode(ActiveWork.self, #"{"label":"npm test","startedAt":"2026-11-01T00:00:00.000Z","kind":"hologram","waitThreadId":"t1"}"#)
    #expect(newer.kind == nil && newer.waitThreadId == "t1")
  }

  @Test func phraseSaysTheKindInWords() {
    #expect(ActiveWork.phrase(label: "npm test", kind: .command) == "Running a command")
    #expect(ActiveWork.phrase(label: "Read", kind: .tool) == "Using a tool")
    #expect(ActiveWork.phrase(label: "Review the diff", kind: .subagent) == "Waiting on a subagent")
    #expect(ActiveWork.phrase(label: "another thread", kind: .thread) == "Waiting on another thread")
    #expect(ActiveWork.phrase(label: "a delegated task", kind: .task) == "Waiting on a delegated task")
    // The kind wins over a label that reads like another one.
    #expect(ActiveWork.phrase(label: "a tool", kind: .command) == "Running a command")
  }

  @Test func phraseGuessesTheKindFromAnOlderServersFixedLabels() {
    #expect(ActiveWork.phrase(label: "another thread", kind: nil) == "Waiting on another thread")
    #expect(ActiveWork.phrase(label: "a delegated task", kind: nil) == "Waiting on a delegated task")
    #expect(ActiveWork.phrase(label: "a subagent", kind: nil) == "Waiting on a subagent")
    #expect(ActiveWork.phrase(label: "a tool", kind: nil) == "Using a tool")
    #expect(ActiveWork.phrase(label: "npm test", kind: nil) == "Running a step")
    #expect(ActiveWork.phrase(label: nil, kind: nil) == "Running a step")
  }

  @Test func detailIsTheCommandNeverAFixedLabel() {
    let start = Date(timeIntervalSince1970: 0)
    #expect(ActiveWork(label: "npm test\n--watch", startedAt: start, kind: .command).detail == "npm test")
    #expect(ActiveWork(label: "a tool", startedAt: start, kind: .tool).detail == nil)
    #expect(ActiveWork(label: "", startedAt: start).detail == nil)
  }
}
