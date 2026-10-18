import Foundation
import Testing
import SWCWire

/// Each command and input is built from Swift values and must encode to exactly the
/// JSON the server's codec produced: same keys, no nulls for omitted keys.
@Suite("Command encoding")
struct CommandEncodeTests {
  static let model = ModelSelection(instanceId: "claudeAgent", model: "claude-opus-5-5")

  /// The commands of `commands.json`, in file order.
  static let commands: [OrchestrationCommand] = [
    .messageDispatch(MessageDispatchCommand(commandId: "c1", threadId: "thr_1", messageId: "m1", text: "hello", dispatchMode: .startImmediately)),
    .messageDispatch(MessageDispatchCommand(commandId: "c1b", threadId: "thr_1", messageId: "m1b", text: "hello", dispatchMode: .startImmediately, deliveryIntent: .auto)),
    .messageDispatch(MessageDispatchCommand(commandId: "c1c", threadId: "thr_1", messageId: "m1c", text: "later", dispatchMode: .queueAfterActive)),
    .runInterrupt(RunInterruptCommand(commandId: "c2", threadId: "thr_1", runId: "run_1")),
    .threadMetadataUpdate(ThreadMetadataUpdateCommand(commandId: "c3", threadId: "thr_1", title: "New title")),
    .threadPin(commandId: "c4", threadId: "thr_1"),
    .threadUnpin(commandId: "c5", threadId: "thr_1"),
    .threadSettle(commandId: "c6", threadId: "thr_1", note: "Merged in #12"),
    .threadUnsettle(commandId: "c7", threadId: "thr_1"),
    .threadArchive(commandId: "c8", threadId: "thr_1"),
    .threadUnarchive(commandId: "c9", threadId: "thr_1"),
    .threadDelete(commandId: "c10", threadId: "thr_1"),
    .threadVisit(commandId: "c11", threadId: "thr_1", visitedAt: "2026-10-18T06:00:05.000Z"),
    .threadMarkUnread(commandId: "c12", threadId: "thr_1"),
    .threadSettle(commandId: "c13", threadId: "thr_1", settledAt: WireCoding.parseDate("2026-10-18T06:00:05.000Z")),
  ]

  @Test func commandsFixture() throws {
    let expected = try #require(try Fixture.json("commands.json").arrayValue)
    #expect(expected.count == Self.commands.count)
    for (command, json) in zip(Self.commands, expected) {
      let encoded = try encodeToJSON(command)
      #expect(encoded == json, "\(command.type) \(command.commandId)")
      #expect(command.type == json["type"]?.stringValue)
      #expect(command.commandId == json["commandId"]?.stringValue)
      #expect(command.threadId == json["threadId"]?.stringValue)
      // Decoding the server's JSON gives the same Swift value back.
      #expect(try json.decode(OrchestrationCommand.self) == command)
    }
  }

  @Test func visitWithDate() throws {
    let date = try #require(WireCoding.parseDate("2026-10-18T06:00:05.000Z"))
    let command = OrchestrationCommand.visit(commandId: "c11", threadId: "thr_1", at: date)
    #expect(command == .threadVisit(commandId: "c11", threadId: "thr_1", visitedAt: "2026-10-18T06:00:05.000Z"))
  }

  /// Swift values for the `rpcPayloads.json` inputs, keyed like the fixture.
  static func payloads() throws -> [(String, JSONValue)] {
    [
      ("command.steer", try encodeToJSON(OrchestrationCommand.messageDispatch(
        MessageDispatchCommand(commandId: "c30", threadId: "thr_1", messageId: "m30", text: "Also check logout", dispatchMode: .steerActive(targetRunId: "run_2"))))),
      ("command.respondApproval", try encodeToJSON(OrchestrationCommand.runtimeRequestRespond(
        RuntimeRequestRespondCommand(commandId: "c31", threadId: "thr_1", requestId: "req_1", decision: .acceptForSession)))),
      ("command.respondAnswers", try encodeToJSON(OrchestrationCommand.runtimeRequestRespond(
        RuntimeRequestRespondCommand(commandId: "c32", threadId: "thr_1", requestId: "req_2", answers: ["q1": .text("Postgres"), "q2": .choices(["a", "b"])])))),
      ("command.renameRegenerate", try encodeToJSON(OrchestrationCommand.threadMetadataUpdate(
        ThreadMetadataUpdateCommand(commandId: "c33", threadId: "thr_1", regenerateTitle: true)))),
      ("command.pinOrdered", try encodeToJSON(OrchestrationCommand.threadPin(commandId: "c34", threadId: "thr_1", orderKey: "a1"))),
      ("command.interruptReason", try encodeToJSON(OrchestrationCommand.runInterrupt(
        RunInterruptCommand(commandId: "c35", threadId: "thr_1", runId: "run_2", reason: "Stopped from phone")))),
      ("launchThread.root", try encodeToJSON(ThreadLaunchInput(
        commandId: "c40", projectId: "proj_1", title: "Investigate flaky test", modelSelection: model, runtimeMode: .auto,
        initialMessage: InitialMessage(messageId: "m40", text: "Why does the auth test flake?"), generateTitle: true))),
      ("launchThread.worktree", try encodeToJSON(ThreadLaunchInput(
        commandId: "c41", projectId: "proj_1", title: "New branch", modelSelection: model, runtimeMode: .approvalRequired,
        interactionMode: .plan, workspaceStrategy: .worktree(baseRef: "main", branch: "feat/x", startFromOrigin: true),
        threadId: "thr_new", creationSource: nil))),
      ("coordinatorSend", try encodeToJSON(CoordinatorSendInput(projectId: "proj_1", commandId: "c50", prompt: "Plan the release"))),
      ("coordinatorStart", try encodeToJSON(CoordinatorStartInput(projectId: "proj_1", commandId: "c51"))),
      ("workspaceRead", try encodeToJSON(WorkspaceReadInput(projectId: "proj_1"))),
      ("projectUpdate.rename", try encodeToJSON(ProjectUpdateCommand(commandId: "c60", projectId: "proj_1", title: "SpecWeave 2"))),
      ("projectUpdate.workspace", try encodeToJSON(ProjectUpdateCommand(
        commandId: "c61", projectId: "proj_1",
        workspaceSettings: WorkspacePatch(expectedRevision: 3, goal: "Ship", instructions: "Small PRs", coordinatorModelSelection: .null, paused: true, archived: false)))),
      ("projectUpdate.icon", try encodeToJSON(ProjectUpdateCommand(commandId: "c62", projectId: "proj_1", projectIcon: .value(.emoji("\u{1F9EA}"))))),
      ("projectUpdate.clearIcon", try encodeToJSON(ProjectUpdateCommand(commandId: "c63", projectId: "proj_1", projectIcon: .null))),
      ("createNew", try encodeToJSON(CreateNewProjectInput(name: "Aide", kind: .personal))),
      ("updateSettings.mode", try encodeToJSON(UpdateServerSettingsInput(patch: ServerSettingsPatch(defaultRuntimeMode: .auto, defaultModelSelection: .value(model))))),
      ("updateSettings.clearModel", try encodeToJSON(UpdateServerSettingsInput(patch: ServerSettingsPatch(defaultModelSelection: .null)))),
      ("subscribeShell.resume", try encodeToJSON(SubscribeShellInput(afterSequence: 42))),
      ("subscribeThread", try encodeToJSON(SubscribeThreadInput(threadId: "thr_1", acceptBoundedSnapshot: true))),
      ("dispatchResult", try encodeToJSON(DispatchResult(sequence: 7))),
    ]
  }

  @Test func rpcPayloadsFixture() throws {
    let expected = try #require(try Fixture.json("rpcPayloads.json").objectValue)
    let built = try Self.payloads()
    for (key, encoded) in built {
      let json = try #require(expected[key], "Fixture has no \(key)")
      #expect(encoded == json, "\(key)")
    }
    // Every input in the fixture has a Swift counterpart; the rest are results.
    let results: Set<String> = ["coordinatorResult", "workspaceReadResult", "project", "createNewResult"]
    #expect(Set(built.map(\.0)).union(results) == Set(expected.keys))
  }

  @Test func payloadsDecodeBack() throws {
    let expected = try #require(try Fixture.json("rpcPayloads.json").objectValue)
    func round<T: Codable & Equatable>(_ type: T.Type, _ key: String) throws {
      let json = try #require(expected[key])
      let value = try json.decode(T.self)
      #expect(try encodeToJSON(value) == json, "\(key)")
    }
    try round(OrchestrationCommand.self, "command.steer")
    try round(OrchestrationCommand.self, "command.respondAnswers")
    try round(ThreadLaunchInput.self, "launchThread.root")
    try round(ThreadLaunchInput.self, "launchThread.worktree")
    try round(ProjectUpdateCommand.self, "projectUpdate.workspace")
    try round(ProjectUpdateCommand.self, "projectUpdate.clearIcon")
    try round(UpdateServerSettingsInput.self, "updateSettings.clearModel")
    try round(SubscribeThreadInput.self, "subscribeThread")
  }

  @Test func requestFrames() throws {
    let frame = try RpcClientMessage.request(id: 7, method: .subscribeShell, payload: SubscribeShellInput())
    let expected: JSONValue = .object([
      "_tag": .string("Request"), "id": .number(7), "tag": .string("orchestration.subscribeShell"),
      "payload": .object(["requestCompletionMarker": .bool(true)]), "headers": .array([]),
    ])
    #expect(try encodeToJSON(frame) == expected)

    let empty = RpcClientMessage.request(id: 1, method: .serverProbe)
    #expect(try encodeToJSON(empty)["payload"] == .object([:]))
    #expect(try encodeToJSON(EmptyInput()) == .object([:]))

    let dispatch = try RpcClientMessage.request(id: 3, method: .dispatchCommand, payload: Self.commands[0])
    #expect(try encodeToJSON(dispatch)["payload"]?["dispatchMode"]?["type"] == .string("start_immediately"))
  }

  @Test func methodNames() {
    #expect(RpcMethod.allCases.count == 17)
    #expect(RpcMethod.subscribeShell.rawValue == "orchestration.subscribeShell")
    #expect(RpcMethod.projectsMutate.rawValue == "projects.mutate")
    #expect(RpcMethod.createNewProject.rawValue == "projects.createNew")
    #expect(RpcMethod.subscribeThread.isStream && !RpcMethod.dispatchCommand.isStream)
  }

  @Test func dispatchModes() throws {
    let modes: [(DispatchMode, String)] = [
      (.startImmediately, #"{"type":"start_immediately"}"#),
      (.queueAfterActive, #"{"type":"queue_after_active"}"#),
      (.steerActive(targetRunId: "r"), #"{"targetRunId":"r","type":"steer_active"}"#),
      (.restartActive(targetRunId: "r"), #"{"targetRunId":"r","type":"restart_active"}"#),
      (.deferStart(), #"{"type":"defer_start"}"#),
    ]
    for (mode, json) in modes {
      #expect(try encodeToJSON(mode) == decodeJSON(JSONValue.self, json))
      #expect(try decodeJSON(DispatchMode.self, json) == mode)
    }
  }

  @Test func patchesOmitNilKeys() throws {
    #expect(try encodeToJSON(ServerSettingsPatch()) == .object([:]))
    #expect(ServerSettingsPatch().isEmpty)
    #expect(try encodeToJSON(WorkspacePatch(expectedRevision: 1)) == .object(["expectedRevision": .number(1)]))
    #expect(try encodeToJSON(ThreadMetadataUpdateCommand(commandId: "c", threadId: "t", branch: .null)) == decodeJSON(
      JSONValue.self, #"{"type":"thread.metadata.update","commandId":"c","threadId":"t","branch":null}"#))
  }
}
