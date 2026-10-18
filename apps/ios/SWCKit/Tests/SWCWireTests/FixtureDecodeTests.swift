import Foundation
import Testing
import SWCWire

@Suite("Fixture decoding")
struct FixtureDecodeTests {
  @Test func projectShell() throws {
    let project = try Fixture.decode(ProjectShell.self, "projectShell.json")
    #expect(project.id == "proj_1")
    #expect(project.kind == .code)
    #expect(project.workspaceSettings?.revision == 3)
    #expect(project.coordinatorThreadId == "project-coordinator:proj_1")
    #expect(project.defaultModelSelection == nil)
    #expect(project.createdDate == WireCoding.parseDate("2026-10-01T00:00:00.000Z"))
  }

  @Test func serverSettingsDefault() throws {
    let settings = try Fixture.decode(ServerSettings.self, "serverSettings.default.json")
    #expect(settings.defaultRuntimeMode == .approvalRequired)
    #expect(settings.defaultModelSelection == nil)
    #expect(settings.textGenerationModelSelection?.instanceId == "codex")
    #expect(settings.textGenerationModelSelection?.option("reasoningEffort") == .string("low"))
    #expect(settings.sidebarProjectOrder == SidebarProjectOrder(pinned: [], unpinned: []))
    #expect(settings.providerInstances.isEmpty)
  }

  @Test func shellStreamSnapshot() throws {
    let item = try Fixture.decode(ShellStreamItem.self, "shellStreamItem.snapshot.json")
    guard case let .snapshot(snapshot, roots) = item else {
      Issue.record("Expected a snapshot, got \(item.kind)")
      return
    }
    #expect(roots == nil)
    #expect(item.sequence == 42)
    #expect(snapshot.threads.count == 1)
    #expect(snapshot.projects.first?.title == "SpecWeave")
    let thread = try #require(snapshot.threads.first)
    #expect(thread.status == .idle)
    #expect(!thread.isWorking)
    #expect(thread.lastVisitedAt == nil)
    #expect(!thread.isUnread)
  }

  @Test func threadShellMin() throws {
    let thread = try Fixture.decode(ThreadShell.self, "threadShell.min.json")
    #expect(thread.id == "thr_1")
    #expect(thread.createdBy == .user)
    #expect(thread.creationSource == .mobile)
    #expect(thread.runtimeMode == .fullAccess)
    #expect(thread.interactionMode == .default)
    #expect(thread.lineage.rootThreadId == "thr_1")
    #expect(thread.pendingBackgroundTasks.isEmpty)
    #expect(thread.updatedAt == WireCoding.parseDate("2026-10-18T04:00:01.500Z"))
    #expect(WireCoding.formatDate(thread.updatedAt) == "2026-10-18T04:00:01.500Z")
    #expect(!thread.isPinned && !thread.isSettled && !thread.isArchived)
  }

  @Test func threadProjection() throws {
    let projection = try Fixture.decode(ThreadProjection.self, "threadProjection.json")
    #expect(projection.thread.id == "thr_1")
    #expect(projection.thread.lastVisitedAt == nil)
    #expect(projection.runs.count == 1)
    #expect(projection.activeRun?.id == "run_1")
    #expect(projection.latestRun?.status == .running)
    #expect(projection.messages.first?.role == .user)
    let plan = try #require(projection.plans.first)
    guard case let .todoList(steps, _) = plan.content else {
      Issue.record("Expected a todo list plan")
      return
    }
    #expect(steps.first?.status == .running)
    #expect(projection.turnItems.count == 1)
    let row = try #require(projection.visibleTurnItems.first)
    #expect(row.visibility == .local)
    guard case let .commandExecution(command) = row.item.content else {
      Issue.record("Expected a command item, got \(row.item.type)")
      return
    }
    #expect(command.input == "ls")
    #expect(command.output == "a\nb")
    #expect(command.exitCode == 0)
  }

  @Test func threadStreamSnapshot() throws {
    let item = try Fixture.decode(ThreadStreamItem.self, "threadStreamItem.snapshot.json")
    guard case let .snapshot(snapshot) = item else {
      Issue.record("Expected a snapshot")
      return
    }
    #expect(item.sequence == 99)
    #expect(snapshot.projection.thread.id == "thr_1")
  }

  @Test func turnItems() throws {
    let raw = try #require(try Fixture.json("turnItems.json").arrayValue)
    let items = try Fixture.decode([TurnItem].self, "turnItems.json")
    #expect(items.count == raw.count)
    let typed = items.filter { !$0.isUnknown }
    #expect(Set(typed.map(\.type)) == TurnItem.knownTypes)
    #expect(items.filter(\.isUnknown).map(\.type) == ["checkpoint", "run_interrupt_request"])

    for (item, json) in zip(items, raw) {
      #expect(item.id == json["id"]?.stringValue)
      #expect(item.type == json["type"]?.stringValue)
      // Typed items keep every member the server sent; unknown ones re-encode verbatim.
      let encoded = try encodeToJSON(item)
      if item.isUnknown {
        #expect(encoded == json)
      } else {
        #expect(stripNulls(encoded) == stripNulls(json), "Round trip of \(item.type)")
      }
    }
  }

  @Test func turnItemPayloads() throws {
    let items = Dictionary(uniqueKeysWithValues: try Fixture.decode([TurnItem].self, "turnItems.json").map { ($0.type, $0) })

    if case let .userMessage(m)? = items["user_message"]?.content {
      #expect(m.inputIntent == .turnStart)
      #expect(m.creationSource == .mobile)
      #expect(m.text == "Fix the login bug")
    } else { Issue.record("user_message") }

    if case let .assistantMessage(m)? = items["assistant_message"]?.content {
      #expect(m.streaming)
      #expect(items["assistant_message"]?.completedAt == nil)
      #expect(items["assistant_message"]?.isInFlight == true)
    } else { Issue.record("assistant_message") }

    if case let .todoList(list)? = items["todo_list"]?.content {
      #expect(list.steps.map(\.status) == [.completed, .running, .pending])
      #expect(list.steps.first?.durationMs == 1200)
      #expect(list.steps[1].durationAnchorAt == "2026-10-18T06:00:04Z")
      #expect(list.completedCount == 1)
    } else { Issue.record("todo_list") }

    if case let .commandExecution(c)? = items["command_execution"]?.content {
      #expect(c.outputOmitted == true)
      #expect(c.exitCode == 1)
      #expect(items["command_execution"]?.status == .failed)
    } else { Issue.record("command_execution") }

    if case let .fileChange(f)? = items["file_change"]?.content {
      #expect(f.additions == 12 && f.deletions == 3)
      #expect(f.changes?.first?.operation == "update")
    } else { Issue.record("file_change") }

    if case let .approvalRequest(a)? = items["approval_request"]?.content {
      #expect(a.requestKind == .command)
      #expect(a.options?.map(\.decision) == [.accept, .acceptForSession, .decline])
      #expect(a.grantRoot == nil)
    } else { Issue.record("approval_request") }

    if case let .userInputRequest(u)? = items["user_input_request"]?.content {
      let question = try #require(u.questions.first)
      #expect(question.options.first?.recommended == true)
      #expect(question.options.first?.answerValue == "Postgres")
      #expect(!u.isAnswered)
    } else { Issue.record("user_input_request") }

    if case let .dynamicTool(d)? = items["dynamic_tool"]?.content {
      #expect(d.toolName == "studio_thread_launch")
      #expect(d.input["prompt"]?.stringValue == "Run tests")
      #expect(items["dynamic_tool"]?.toolSource?.kind == "browser")
      #expect(items["dynamic_tool"]?.toolSurface == "browser")
    } else { Issue.record("dynamic_tool") }

    if case let .subagent(s)? = items["subagent"]?.content {
      #expect(s.childThreadId == "thr_child")
      #expect(s.result == nil)
    } else { Issue.record("subagent") }

    if case let .error(e)? = items["error"]?.content {
      #expect(e.failure.failureClass == .usageLimit)
      #expect(e.failure.resetAt == "2026-10-18T09:00:00Z")
      #expect(e.failure.retryable == true)
    } else { Issue.record("error") }

    if case let .notification(n)? = items["notification"]?.content {
      #expect(n.source.isSubagent)
      #expect(n.source.normalizedKind == "subagent")
      #expect(n.source.childThreadId == "thr_child")
      #expect(n.outcome == .completed)
    } else { Issue.record("notification") }
  }

  @Test func threadEvents() throws {
    let raw = try #require(try Fixture.json("threadEvents.json").arrayValue)
    let items = try Fixture.decode([ThreadStreamItem].self, "threadEvents.json")
    #expect(items.count == raw.count)

    var types: [String] = []
    for item in items {
      guard case let .event(_, event) = item else { continue }
      types.append(event.type)
      switch (event.type, event.payload) {
      case ("thread.pinned", .thread(let thread)):
        #expect(thread.isPinned)
        #expect(thread.pinOrderKey == "a0")
      case ("thread.metadata-updated", .thread(let thread)):
        #expect(thread.title == "Fix login flow")
      case ("run.created", .run(let run)):
        #expect(run.status == .queued)
        #expect(run.queuePosition == 1)
        #expect(run.modelSelection.option("fastMode") == .bool(true))
      case ("run.updated", .run(let run)):
        #expect(run.status == .running)
        #expect(event.driver == "claudeAgent")
      case ("message.updated", .message(let message)):
        #expect(message.senderThreadId == "thr_coord")
        #expect(message.attachments.first?.isImage == true)
      case ("turn-item.updated", .turnItem(let item)):
        #expect(item.type == "assistant_message")
      case ("plan.updated", .plan(let plan)):
        #expect(plan.kind == "proposed_plan")
      case ("runtime-request.updated", .runtimeRequest(let request)):
        if request.id == "req_1" {
          #expect(request.responseCapability == .live(providerSessionId: "ps_1"))
          #expect(request.isPending)
        } else {
          #expect(request.responseCapability == .notResumable(reason: "Session ended"))
          #expect(request.answers?["q1"]?.stringValue == "Postgres")
        }
      case ("run-attempt.created", .unknown(let payload)):
        #expect(payload["attemptOrdinal"]?.intValue == 1)
      default:
        Issue.record("Unexpected payload for \(event.type)")
      }
    }
    #expect(types.count == 10)
    #expect(items.last == .synchronized)
    #expect(items.compactMap(\.sequence) == Array(200...209))
  }

  @Test func shellItems() throws {
    let items = try Fixture.decode([ShellStreamItem].self, "shellItems.json")
    #expect(items.map(\.kind) == ["thread.updated", "thread.removed", "project.removed", "project.updated", "project.updated", "project.updated"])
    #expect(items.compactMap(\.sequence) == [50, 51, 52, 53, 54, 55])

    guard case let .threadUpdated(_, location, thread) = items[0] else {
      Issue.record("thread.updated")
      return
    }
    #expect(location == .active)
    #expect(thread.status == .running)
    #expect(thread.isWorking)
    #expect(thread.activityRunStatus == .running)
    #expect(thread.activeWork?.label == "npm test")
    #expect(thread.pendingRuntimeRequest?.kind == .command)
    #expect(thread.latestVisibleMessage?.role == .assistant)
    #expect(thread.planProgress == ThreadPlanProgress(completed: 1, total: 3, current: "Write fix", next: "Test"))
    #expect(thread.pendingBackgroundTasks.map(\.kind) == [.command, .subagent])
    #expect(thread.pendingBackgroundTasks.last?.childThreadId == "thr_child")
    #expect(thread.providerInstanceHistory == ["codex", "claudeAgent"])
    #expect(thread.goal?.objective == "Ship login fix")
    #expect(thread.heldQueuedCount == 2)
    #expect(thread.titleRegeneration?.requestId == "cmd_t")
    #expect(thread.isPinned)
    // latestRunCompletedAt (06:04) is before lastVisitedAt (06:05).
    #expect(!thread.isUnread)

    guard case let .threadRemoved(_, removedLocation, removedId) = items[1] else {
      Issue.record("thread.removed")
      return
    }
    #expect(removedLocation == .archive)
    #expect(removedId == "thr_old")

    guard case let .projectUpdated(_, aide) = items[3] else {
      Issue.record("project.updated")
      return
    }
    #expect(aide.isPersonal)
    #expect(aide.projectIcon == .personalAssistant)
    #expect(aide.coordinatorThreadId == "project-coordinator:proj_aide")
    #expect(aide.workspaceSettings?.autoResume == true)
    #expect(aide.workspaceSettings?.workerMachine?.machineId == "m1")
    #expect(aide.workspaceSettings?.environment.repositories.first?.id == "web")
    #expect(aide.repositoryIdentity?.displayName == "acme/web")
    #expect(aide.scripts.first?.command == "npm run dev")

    guard case let .projectUpdated(_, mono) = items[4], case let .projectUpdated(_, emoji) = items[5] else {
      Issue.record("icon projects")
      return
    }
    #expect(mono.projectIcon == .monogram(text: "MO", color: "teal"))
    #expect(emoji.projectIcon == .emoji("\u{1F680}"))
  }

  /// Inbound models re-encode to JSON that decodes to the same value, so they can be cached.
  @Test func cacheRoundTrip() throws {
    func check<T: Codable & Equatable>(_ type: T.Type, _ name: String) throws {
      let value = try Fixture.decode(T.self, name)
      let again = try WireCoding.decoder.decode(T.self, from: WireCoding.encoder.encode(value))
      #expect(again == value, "\(name)")
    }
    try check(ShellStreamItem.self, "shellStreamItem.snapshot.json")
    try check([ShellStreamItem].self, "shellItems.json")
    try check(ThreadProjection.self, "threadProjection.json")
    try check([ThreadStreamItem].self, "threadEvents.json")
    try check(ThreadStreamItem.self, "threadStreamItem.snapshot.json")
    try check([TurnItem].self, "turnItems.json")
    try check(ServerSettings.self, "serverSettings.default.json")
    try check(ProjectShell.self, "projectShell.json")
  }

  @Test func rpcPayloadResults() throws {
    let payloads = try #require(try Fixture.json("rpcPayloads.json").objectValue)
    func value(_ key: String) throws -> JSONValue { try #require(payloads[key]) }

    let coordinator = try value("coordinatorResult").decode(CoordinatorResult.self)
    #expect(coordinator == CoordinatorResult(threadId: "project-coordinator:proj_1", created: true))

    let read = try value("workspaceReadResult").decode(WorkspaceReadResult.self)
    #expect(read.settings.goal == "Ship v2")
    #expect(read.settings.coordinatorThreadId == nil)
    #expect(read.settings.coordinatorModelSelection == ModelSelection(instanceId: "codex", model: "gpt-6"))
    #expect(read.memory.files.first?.name == "MEMORY.md")
    #expect(read.memory.totalBytes == 10)

    let project = try value("project").decode(ProjectShell.self)
    #expect(project.title == "SpecWeave 2")
    #expect(project.deletedAt == nil)
    #expect(project.workspaceSettings == nil)
    #expect(project.kind == .code)
    #expect(project.coordinatorThreadId == "project-coordinator:proj_1")

    let created = try value("createNewResult").decode(CreateNewProjectResult.self)
    #expect(created.existing == true)
    #expect(created.commitError == nil)

    #expect(try value("dispatchResult").decode(DispatchResult.self) == DispatchResult(sequence: 7))
  }
}
