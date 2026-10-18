import Foundation
import Testing
import SWCWire

/// A newer server must never break decoding: unknown statuses, kinds and types,
/// explicit nulls and extra keys all decode.
@Suite("Tolerance")
struct ToleranceTests {
  static let base = #""id":"ti_x","threadId":"thr_1","runId":null,"nodeId":null,"providerThreadId":null,"providerTurnId":null,"nativeItemRef":null,"parentItemId":null,"ordinal":4,"title":null,"startedAt":null,"completedAt":null,"updatedAt":"2026-10-18T06:00:05.000Z""#

  @Test func unknownStatuses() throws {
    let item = try decodeJSON(TurnItem.self, #"{\#(Self.base),"status":"paused_by_moon","type":"reasoning","text":"t","streaming":false}"#)
    #expect(item.status.rawValue == "paused_by_moon")
    #expect(item.status.known == nil)
    #expect(!item.isInFlight)

    var thread = try Fixture.json("threadShell.min.json").objectValue ?? [:]
    thread["status"] = .string("hibernating")
    let shell = try JSONValue.object(thread).decode(ThreadShell.self)
    #expect(shell.status == ThreadStatus(rawValue: "hibernating"))
    #expect(!shell.status.isWorking)
    #expect(try encodeToJSON(shell)["status"] == .string("hibernating"))

    #expect(try decodeJSON(RunStatus.self, #""teleporting""#).known == nil)
    #expect(try decodeJSON(RuntimeMode.self, #""yolo""#).rawValue == "yolo")
    #expect(try decodeJSON(WorkspaceKind.self, #""team""#) != .code)
  }

  @Test func unknownTurnItemType() throws {
    let json = #"{\#(Self.base),"status":"completed","type":"hologram","beam":{"power":9}}"#
    let item = try decodeJSON(TurnItem.self, json)
    #expect(item.isUnknown)
    #expect(item.type == "hologram")
    #expect(item.id == "ti_x")
    #expect(item.ordinal == 4)
    guard case let .unknown(_, raw) = item.content else {
      Issue.record("Expected unknown content")
      return
    }
    #expect(raw["beam"]?["power"]?.intValue == 9)
    #expect(try encodeToJSON(item) == decodeJSON(JSONValue.self, json))

    // Even a bare unknown item decodes.
    let bare = try decodeJSON(TurnItem.self, #"{"type":"sparkle"}"#)
    #expect(bare.isUnknown && bare.id.isEmpty)
  }

  @Test func knownTurnItemMustDecodeInFull() {
    #expect(throws: DecodingError.self) {
      try decodeJSON(TurnItem.self, #"{\#(Self.base),"status":"completed","type":"command_execution"}"#)
    }
  }

  @Test func unknownTurnItemInProjection() throws {
    var projection = try Fixture.json("threadProjection.json").objectValue ?? [:]
    let unknownItem = try decodeJSON(JSONValue.self, #"{\#(Self.base),"status":"completed","type":"hologram"}"#)
    projection["turnItems"] = .array((projection["turnItems"]?.arrayValue ?? []) + [unknownItem])
    projection["visibleTurnItems"] = .array((projection["visibleTurnItems"]?.arrayValue ?? []) + [.object([
      "position": .number(1), "visibility": .string("synthetic"), "sourceThreadId": .string("thr_1"),
      "sourceItemId": .string("ti_x"), "item": unknownItem,
    ])])
    projection["futureArray"] = .array([.object(["anything": .bool(true)])])
    let decoded = try JSONValue.object(projection).decode(ThreadProjection.self)
    #expect(decoded.turnItems.count == 2)
    #expect(decoded.visibleTurnItems.count == 2)
    #expect(decoded.renderableTurnItems.count == 1)
  }

  @Test func nullOptionals() throws {
    // Optional keys sent as null decode as nil, and defaults fill missing arrays.
    let shell = try decodeJSON(ThreadShell.self, #"""
    {"id":"thr_n","projectId":"p","title":"T","providerInstanceId":"codex","modelSelection":{"instanceId":"codex","model":"gpt-6"},
     "runtimeMode":"auto","interactionMode":null,"branch":null,"worktreePath":null,"lineage":{"parentThreadId":null,"relationshipToParent":null,"rootThreadId":"thr_n"},
     "forkedFrom":null,"activeProviderThreadId":null,"latestRunId":null,"activeRunId":null,"status":"idle","pendingRuntimeRequest":null,
     "latestVisibleMessage":null,"latestUserMessageAt":null,"hasActionableProposedPlan":false,"pendingBackgroundTasks":null,
     "providerInstanceHistory":null,"planProgress":null,"goal":null,"activeWork":null,"lastVisitedAt":null,"pinnedAt":null,
     "titleRegeneration":null,"limitRecovery":null,"itemCount":0,"visibleItemCount":0,"createdAt":"2026-10-18T06:00:00.000Z",
     "updatedAt":"2026-10-18T06:00:00.000Z","archivedAt":null,"settledOverride":null,"settledAt":null,"deletedAt":null}
    """#)
    #expect(shell.interactionMode == .default)
    #expect(shell.pendingBackgroundTasks.isEmpty)
    #expect(shell.providerInstanceHistory.isEmpty)
    #expect(shell.forkedFrom == nil && shell.limitRecovery == nil)
    #expect(shell.createdBy == .user)

    let project = try decodeJSON(ProjectShell.self, #"""
    {"id":"p","title":"P","workspaceRoot":"/w","repositoryIdentity":null,"defaultModelSelection":null,"defaultThreadEnvMode":null,
     "faviconPath":null,"projectIcon":null,"scripts":[],"createdAt":"2026-10-01T00:00:00Z","updatedAt":"2026-10-01T00:00:00Z",
     "workspaceSettings":{"revision":1,"coordinatorThreadId":null,"coordinatorModelSelection":null,"environment":null}}
    """#)
    #expect(project.projectIcon == nil)
    #expect(project.workspaceSettings?.kind == .code)
    #expect(project.workspaceSettings?.environment == ProjectEnvironment())
    #expect(project.coordinatorThreadId == "project-coordinator:p")

    let descriptor = try decodeJSON(EnvironmentDescriptor.self, #"{"environmentId":"e","label":"Mac","platform":{"os":"darwin","arch":"arm64"},"serverVersion":null,"capabilities":null}"#)
    #expect(descriptor.orchestrationProtocolVersion == nil)
    #expect(descriptor.compatibility == .serverTooOld(1))
    #expect(descriptor.platform.displayName == "macOS · arm64")
  }

  @Test func extraKeys() throws {
    let message = try decodeJSON(ConversationMessage.self, #"""
    {"id":"m","threadId":"t","runId":null,"nodeId":null,"role":"assistant","text":"hi","attachments":[],"streaming":false,
     "createdAt":"2026-10-18T06:00:00.000Z","updatedAt":"2026-10-18T06:00:00.000Z","createdBy":"agent","creationSource":"provider",
     "reactions":[{"emoji":"x"}],"futureFlag":true}
    """#)
    #expect(message.role == .assistant)
    #expect(message.createdBy == .agent)

    let settings = try decodeJSON(ServerSettings.self, #"{"defaultRuntimeMode":"auto","brandNewSetting":{"deep":[1,2,3]},"providerInstances":{"codex":{"driver":"codex","enabled":true,"apiKeyRef":"x"},"bad":5}}"#)
    #expect(settings.defaultRuntimeMode == .auto)
    #expect(settings.providerInstances.keys.sorted() == ["codex"])

    let item = try decodeJSON(TurnItem.self, #"{\#(Self.base),"status":"completed","type":"system_notice","message":"Hi","severity":"loud"}"#)
    guard case let .systemNotice(notice) = item.content else {
      Issue.record("Expected a system notice")
      return
    }
    #expect(notice.message == "Hi")
  }

  @Test func legacyModelSelection() throws {
    let legacy = try decodeJSON(ModelSelection.self, #"{"provider":"codex","model":"gpt-6","options":{"reasoningEffort":" high ","fastMode":true,"empty":""}}"#)
    #expect(legacy.instanceId == "codex")
    #expect(legacy.option("reasoningEffort") == .string("high"))
    #expect(legacy.option("fastMode") == .bool(true))
    #expect(legacy.option("empty") == nil)
    let encoded = try encodeToJSON(legacy)
    #expect(encoded["provider"] == nil)
    #expect(encoded["instanceId"] == .string("codex"))
    #expect(encoded["options"]?.arrayValue?.count == 2)

    #expect(throws: DecodingError.self) { try decodeJSON(ModelSelection.self, #"{"model":"x"}"#) }
  }

  @Test func unknownProjectIcon() throws {
    let icon = try decodeJSON(ProjectIconOverride.self, #"{"kind":"photo","url":"https://example.com/a.png"}"#)
    guard case let .unknown(raw) = icon else {
      Issue.record("Expected unknown icon")
      return
    }
    #expect(raw["url"]?.stringValue == "https://example.com/a.png")
    #expect(try encodeToJSON(icon) == raw)

    // Older servers sent monograms as lucide icons carrying the text.
    let legacy = try decodeJSON(ProjectIconOverride.self, #"{"kind":"lucide","name":"type","color":"teal","monogramText":"SW"}"#)
    #expect(legacy == .monogram(text: "SW", color: "teal"))
  }

  @Test func unknownShellKind() throws {
    let item = try decodeJSON(ShellStreamItem.self, #"{"kind":"machine.renamed","sequence":77,"name":"M5"}"#)
    #expect(item.kind == "machine.renamed")
    #expect(item.sequence == 77)
    if case .unknown = item {} else { Issue.record("Expected unknown") }
  }

  @Test func unknownThreadStreamItems() throws {
    let event = try decodeJSON(ThreadStreamItem.self, #"""
    {"kind":"event","sequence":300,"event":{"id":"ev","threadId":"thr_1","occurredAt":"2026-10-18T06:00:00.000Z","type":"thread.teleported","payload":{"to":"mars"}}}
    """#)
    guard case let .event(sequence, domainEvent) = event else {
      Issue.record("Expected an event")
      return
    }
    #expect(sequence == 300)
    #expect(domainEvent.isUnknown)
    #expect(domainEvent.type == "thread.teleported")

    // A turn-item.updated with an unknown item type is skipped like an unknown event.
    let item = try decodeJSON(ThreadStreamItem.self, #"""
    {"kind":"event","sequence":301,"event":{"id":"ev2","threadId":"thr_1","occurredAt":"2026-10-18T06:00:00.000Z","type":"turn-item.updated","payload":{\#(Self.base),"status":"completed","type":"hologram"}}}
    """#)
    if case let .event(_, e) = item { #expect(e.isUnknown) } else { Issue.record("Expected an event") }

    let kind = try decodeJSON(ThreadStreamItem.self, #"{"kind":"history-page","sequence":5}"#)
    #expect(kind.sequence == 5)
    if case .unknown = kind {} else { Issue.record("Expected unknown") }

    // A known event type with a malformed payload still fails.
    #expect(throws: DecodingError.self) {
      try decodeJSON(ThreadStreamItem.self, #"{"kind":"event","sequence":1,"event":{"id":"e","threadId":"t","occurredAt":"2026-10-18T06:00:00.000Z","type":"run.updated","payload":{"id":"r"}}}"#)
    }
  }

  @Test func forwardCompatibleArrays() throws {
    let config = try decodeJSON(ServerConfig.self, #"""
    {"environment":{"environmentId":"e","label":"Mac","platform":{"os":"darwin","arch":"arm64"},"orchestrationProtocolVersion":2,"capabilities":{"threadPinning":true,"fileAttachments":{"maxUploadBytes":1024}}},
     "directEndpoints":[{"kind":"lan","httpBaseUrl":"http://10.0.0.2:8431"},{"kind":7}],
     "providers":[{"instanceId":"codex","driver":"codex","enabled":true,"installed":true,"status":"ready","models":[{"slug":"gpt-6","name":"GPT-6"},{"bad":true}]},{"nope":1}]}
    """#)
    #expect(config.directEndpoints.count == 1)
    #expect(config.providers.count == 1)
    #expect(config.provider("codex")?.models.count == 1)
    #expect(config.provider("codex")?.modelName("gpt-6") == "GPT-6")
    #expect(config.environment.capabilities.threadPinning)
    #expect(config.environment.capabilities.maxUploadBytes == 1024)
    #expect(config.environment.compatibility == .compatible)
  }

  @Test func unknownBackgroundAndNotificationKinds() throws {
    let task = try decodeJSON(PendingBackgroundTask.self, #"{"taskId":"t1"}"#)
    #expect(task.kind == .backgroundTask)
    let future = try decodeJSON(PendingBackgroundTask.self, #"{"taskId":"t2","kind":"cron"}"#)
    #expect(future.kind.rawValue == "cron")

    let command = try decodeJSON(NotificationSource.self, #"{"kind":"background_command"}"#)
    #expect(command.isCommand && command.normalizedKind == "command")
    let other = try decodeJSON(NotificationSource.self, #"{"kind":"satellite"}"#)
    #expect(other.normalizedKind == "background_task")
  }

  @Test func unknownCapabilityAndStrategy() throws {
    let request = try decodeJSON(RuntimeRequest.self, #"{"id":"r","nodeId":"n","kind":"telepathy","status":"pending","responseCapability":{"type":"carrier_pigeon"},"createdAt":"2026-10-18T06:00:00.000Z","resolvedAt":null}"#)
    #expect(request.kind.rawValue == "telepathy")
    #expect(!request.responseCapability.canRespond)

    let strategy = try decodeJSON(WorkspaceStrategy.self, #"{"type":"container","image":"node"}"#)
    if case .unknown = strategy {} else { Issue.record("Expected unknown strategy") }

    let plan = try decodeJSON(PlanArtifact.self, #"{"id":"p","threadId":"t","runId":null,"nodeId":"n","status":"draft","kind":"mindmap","nodes":[]}"#)
    #expect(plan.kind == "mindmap")
  }

  @Test func datesRoundTripWithMilliseconds() throws {
    let date = try #require(WireCoding.parseDate("2026-10-18T06:00:05.123Z"))
    let event = try decodeJSON(DomainEvent.self, #"{"id":"e","threadId":"t","occurredAt":"2026-10-18T06:00:05.123Z","type":"future.thing"}"#)
    #expect(event.occurredAt == date)
    #expect(try encodeToJSON(event)["occurredAt"] == .string("2026-10-18T06:00:05.123Z"))
    #expect(event.payload == .unknown(.null))
  }
}
