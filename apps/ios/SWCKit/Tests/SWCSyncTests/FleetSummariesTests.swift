import Foundation
import Testing
import SWCWire
@testable import SWCSync

@Suite struct FleetSummariesTests {
  static let seen = TestData.date("2026-10-20T21:05:00.000Z")

  func machine(_ env: String, label: String, online: Bool = true, threads: [ThreadShell], projects: [ProjectShell], lastSeenAt: Date? = nil) -> ShellSummaries.Machine {
    ShellSummaries.Machine(environmentId: env, label: label, online: online, snapshot: ShellSnapshot(threads: threads, projects: projects), lastSeenAt: lastSeenAt)
  }

  var utc: Calendar {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC")!
    return calendar
  }

  func plain(_ text: String) -> String { text.replacingOccurrences(of: "\u{202F}", with: " ") }

  // MARK: Placement

  @Test func rowShowsWhereTheThreadLivesAndRuns() throws {
    var local = try TestData.thread(id: "local")
    local.title = "Local"
    var remote = try TestData.thread(id: "remote")
    remote.ownerMachineId = "m4"
    remote.executionMachineId = "minis"
    remote.executionState = .running
    let output = ShellSummaries.build([
      machine("m4", label: "Sam's M4", threads: [local, remote], projects: [try TestData.project()]),
      machine("minis", label: "Minis", threads: [], projects: []),
    ])
    let rows = Dictionary(uniqueKeysWithValues: output.recentThreads.map { ($0.ref.threadId, $0) })
    #expect(rows["local"]?.placement.label == "M4")
    #expect(rows["remote"]?.placement.label == "M4 → Minis")
    #expect(rows["remote"]?.isUnknown == false)
  }

  @Test func nicknamesNameEveryMachineIncludingRosterOnlyOnes() throws {
    var remote = try TestData.thread(id: "remote")
    remote.executionMachineId = "env-mini"
    let output = ShellSummaries.build(
      [machine("m4", label: "Sam's MacBook M4MAX", threads: [remote], projects: [try TestData.project()])],
      names: ["env-mini": "Sam's Mac mini"],
      nicknames: ["m4": "M4", "env-mini": "Minis"]
    )
    #expect(output.recentThreads.first?.placement.label == "M4 → Minis")
    #expect(output.recentThreads.first?.machineLabel == "M4")
  }

  @Test func executionMachineNameComesFromTheRosterOrTheServer() throws {
    var fromRoster = try TestData.thread(id: "a")
    fromRoster.executionMachineId = "env-mini"
    var fromServer = try TestData.thread(id: "b")
    fromServer.executionMachineId = "env-studio"
    fromServer.executionMachineLabel = "Sam's Mac Studio"
    let output = ShellSummaries.build(
      [machine("m4", label: "M4", threads: [fromRoster, fromServer], projects: [try TestData.project()])],
      names: ["env-mini": "Sam's Mac mini"]
    )
    let labels = Dictionary(uniqueKeysWithValues: output.recentThreads.map { ($0.ref.threadId, $0.placement.label) })
    #expect(labels == ["a": "M4 → Mac mini", "b": "M4 → Mac Studio"])
  }

  @Test func unreachableMachineThreadsStayListedAsUnknown() throws {
    var running = try TestData.thread(id: "thr_1")
    running.status = .running
    let output = ShellSummaries.build([
      machine("m4", label: "M4", online: false, threads: [running], projects: [try TestData.project()], lastSeenAt: Self.seen),
    ])
    let row = try #require(output.recentThreads.first)
    #expect(row.isUnknown)
    #expect(row.placement.unknown == ThreadPlacement.Unknown(machine: "M4", lastSeenAt: Self.seen))
    let subtitle = plain(row.placement.subtitle(now: Self.seen.addingTimeInterval(600), calendar: utc, locale: Locale(identifier: "en_US")))
    #expect(subtitle == "M4 · Unknown · last seen 9:05 PM")
    // An unknown thread is never counted as working.
    #expect(output.projects.first?.workingCount == 0)
    #expect(output.threadsByProject[ProjectRef(environmentId: "m4", projectId: "proj_1")]?.count == 1)
  }

  @Test func threadIsUnknownWhenTheMachineRunningItIsUnreachable() throws {
    var reported = try TestData.thread(id: "reported")
    reported.executionMachineId = "minis"
    reported.executionState = .unknown
    reported.executionLastSeenAt = Self.seen
    var observed = try TestData.thread(id: "observed")
    observed.executionMachineId = "minis"
    observed.executionState = .running
    let output = ShellSummaries.build([
      machine("m4", label: "M4", threads: [reported, observed], projects: [try TestData.project()]),
      machine("minis", label: "Minis", online: false, threads: [], projects: [], lastSeenAt: Self.seen.addingTimeInterval(60)),
    ])
    let rows = Dictionary(uniqueKeysWithValues: output.recentThreads.map { ($0.ref.threadId, $0) })
    // The phone's own last-seen time wins over the server's.
    #expect(rows["reported"]?.placement.unknown == ThreadPlacement.Unknown(machine: "Minis", lastSeenAt: Self.seen.addingTimeInterval(60)))
    #expect(rows["observed"]?.isUnknown == true)
    #expect(rows["observed"]?.placement.label == "M4 → Minis")

    let alone = ShellSummaries.build([machine("m4", label: "M4", threads: [reported], projects: [try TestData.project()])])
    #expect(alone.recentThreads.first?.placement.unknown == ThreadPlacement.Unknown(machine: "Another machine", lastSeenAt: Self.seen))
  }

  @Test func handedOffCopyIsHiddenOnlyWhileItsContinuationIsListed() throws {
    var source = try TestData.thread(id: "src")
    source.executionState = .fenced
    source.executionMachineId = "minis"
    source.movedTo = ThreadMoveLink(threadId: "dst", projectId: "proj_1", kind: "handoff", environmentId: "minis", machineLabel: "Minis")
    let continued = try TestData.thread(id: "dst")
    let both = ShellSummaries.build([
      machine("m4", label: "M4", threads: [source], projects: [try TestData.project()]),
      machine("minis", label: "Minis", threads: [continued], projects: [try TestData.project()]),
    ])
    #expect(both.recentThreads.map(\.ref) == [ThreadRef(environmentId: "minis", threadId: "dst")])

    // Minis is not paired: the copy stays, and says where the thread went.
    let one = ShellSummaries.build([machine("m4", label: "M4", threads: [source], projects: [try TestData.project()])])
    let row = try #require(one.recentThreads.first)
    #expect(row.ref.threadId == "src")
    #expect(row.placement.label == "M4 → Minis")
    #expect(!row.isUnknown)
  }

  // MARK: Linked projects

  func linked(_ id: String, epoch: Int? = nil, state: CoordinatorBindingState = .active) throws -> ProjectShell {
    var project = try TestData.project(id: id, title: "Specweave")
    project.workspaceSettings?.logicalProject = LogicalProject(id: "lp1", title: "Specweave", coordinatorId: "c")
    if let epoch { project.workspaceSettings?.coordinatorBinding = CoordinatorBinding(epoch: epoch, state: state) }
    return project
  }

  @Test func linkedProjectIsOneRowWithEveryMachinesThreads() throws {
    let output = ShellSummaries.build([
      machine("m4", label: "M4", threads: [try TestData.thread(id: "a", projectId: "p4")], projects: [try linked("p4")]),
      machine("minis", label: "Minis", threads: [try TestData.thread(id: "b", projectId: "pm")], projects: [try linked("pm", epoch: 2)]),
    ])
    #expect(output.projects.count == 1)
    let project = try #require(output.projects.first)
    #expect(project.ref == ProjectRef(environmentId: "minis", projectId: "pm"))
    #expect(project.members.map(\.machineLabel) == ["Minis", "M4"])
    #expect(project.members.map(\.isCoordinator) == [true, false])
    #expect(project.contains(ProjectRef(environmentId: "m4", projectId: "p4")))
    for member in project.members {
      #expect(Set(output.threadsByProject[member.ref]?.map(\.ref.threadId) ?? []) == ["a", "b"])
    }
  }

  @Test func offlineCoordinatorStaysTheRowsMachine() throws {
    let output = ShellSummaries.build([
      machine("m4", label: "M4", online: false, threads: [try TestData.thread(id: "a", projectId: "p4")], projects: [try linked("p4", epoch: 3)], lastSeenAt: Self.seen),
      machine("minis", label: "Minis", threads: [try TestData.thread(id: "b", projectId: "pm")], projects: [try linked("pm", epoch: 1)]),
    ])
    let project = try #require(output.projects.first)
    // Switching machines is the person's choice; the row never fails over.
    #expect(project.ref.environmentId == "m4")
    #expect(project.members.first?.machineOnline == false)
    #expect(project.members.first?.lastSeenAt == Self.seen)
    let rows = Dictionary(uniqueKeysWithValues: (output.threadsByProject[project.ref] ?? []).map { ($0.ref.threadId, $0.isUnknown) })
    #expect(rows == ["a": true, "b": false])
  }

  @Test func withoutAnActiveCoordinatorTheRowOpensAReachableMachine() throws {
    let output = ShellSummaries.build([
      machine("a-m4", label: "M4", online: false, threads: [], projects: [try linked("p4")]),
      machine("minis", label: "Minis", threads: [], projects: [try linked("pm")]),
    ])
    #expect(output.projects.first?.ref.environmentId == "minis")
    #expect(output.projects.first?.members.allSatisfy { !$0.isCoordinator } == true)
  }
}

@Suite struct MachineNicknameTests {
  @Test func nicknameWinsThenShortName() {
    #expect(MachineNickname.shortName("Sam's MacBook M4MAX") == "MacBook M4MAX")
    #expect(MachineNickname.shortName("Sam’s Mac mini") == "Mac mini")
    #expect(MachineNickname.shortName("M4") == "M4")
    #expect(MachineNickname.resolve(environmentId: "e", label: "Sam's Mac mini", nicknames: ["e": "  Minis "]) == "Minis")
    #expect(MachineNickname.resolve(environmentId: "e", label: "Sam's Mac mini", nicknames: ["e": " "]) == "Mac mini")
    #expect(MachineNickname.resolve(environmentId: "e", label: "x", nicknames: ["e": String(repeating: "a", count: 40)]).count == MachineNickname.maximumLength)
  }

  @Test func nicknamesFollowTheWebRules() {
    func resolve(_ name: String?, label: String = "Anton's MacBook M4MAX") -> String {
      MachineNickname.resolve(environmentId: "env-9", label: label, nicknames: name.map { ["env-9": $0] } ?? [:])
    }
    #expect(resolve("  Mini \t  two ") == "Mini two")
    // Cut at 16, then trimmed again.
    #expect(resolve("abcdefghijklmno pqr") == "abcdefghijklmno")
    // 16 UTF-16 units, as JavaScript counts: each emoji is two.
    #expect(resolve(String(repeating: "😀", count: 9)) == String(repeating: "😀", count: 8))
    #expect(resolve("") == "MacBook M4MAX")
    #expect(resolve(nil, label: "  Anton’s Mac mini ") == "Mac mini")
    #expect(resolve(nil, label: "Anton's") == "Anton's")
    #expect(resolve(nil, label: "   ") == "env-9")
    #expect(MachineNickname.normalize("  ") == "")
  }

  @Test func configStreamCarriesSettingsUpdates() throws {
    let json = #"{"version":1,"type":"settingsUpdated","payload":{"settings":{"providerInstances":{},"machineNicknames":{"env-1":{"name":"Desk","updatedAt":"2026-10-20T22:00:00.000Z"}}}}}"#
    let item = try WireCoding.decoder.decode(ServerConfigStreamItem.self, from: Data(json.utf8))
    guard case let .settingsUpdated(settings) = item else {
      Issue.record("Expected settingsUpdated, got \(item)")
      return
    }
    #expect(settings.machineNicknames["env-1"]?.name == "Desk")
    let other = try WireCoding.decoder.decode(ServerConfigStreamItem.self, from: Data(#"{"version":1,"type":"keybindingsUpdated","payload":{}}"#.utf8))
    guard case .other(type: "keybindingsUpdated", raw: _) = other else {
      Issue.record("Expected other, got \(other)")
      return
    }
  }

  @Test func mergeKeepsTheNewestRenameAndBreaksTiesByName() {
    func entry(_ name: String, _ at: String) -> MachineNicknameEntry { MachineNicknameEntry(name: name, updatedAt: at) }
    let older = ["a": entry("Old", "2026-10-20T10:00:00.000Z"), "b": entry("Bee", "2026-10-20T10:00:00.000Z")]
    let newer = ["a": entry("New", "2026-10-20T11:00:00.000Z"), "b": entry("Ant", "2026-10-20T10:00:00.000Z"), "c": entry("", "not a date")]
    #expect(MachineNickname.merge([older, newer]) == ["a": "New", "b": "Bee", "c": ""])
    #expect(MachineNickname.merge([newer, older]) == ["a": "New", "b": "Bee", "c": ""])
    // A reset to the default name, stamped later, beats an older rename.
    let reset = ["a": entry("", "2026-10-20T12:00:00.000Z")]
    #expect(MachineNickname.merge([older, reset])["a"] == "")
    #expect(MachineNickname.resolve(environmentId: "a", label: "Sam's Mac mini", nicknames: MachineNickname.merge([older, reset])) == "Mac mini")
    // An unreadable stamp loses to a real one.
    #expect(MachineNickname.merge([["a": entry("Real", "2026-10-20T09:00:00.000Z")], ["a": entry("Zed", "garbage")]])["a"] == "Real")
  }

  @Test func settingsCarryNicknamesAndSkipBadEntries() throws {
    let json = #"{"defaultRuntimeMode":"auto","providerInstances":{},"machineNicknames":{"env-1":{"name":"Office","updatedAt":"2026-10-20T21:00:00.000Z"},"env-2":{"name":7},"env-3":"Minis"}}"#
    let settings = try WireCoding.decoder.decode(ServerSettings.self, from: Data(json.utf8))
    #expect(settings.machineNicknames == ["env-1": MachineNicknameEntry(name: "Office", updatedAt: "2026-10-20T21:00:00.000Z")])
    let older = try WireCoding.decoder.decode(ServerSettings.self, from: Data(#"{"providerInstances":{}}"#.utf8))
    #expect(older.machineNicknames.isEmpty)
    let broken = try WireCoding.decoder.decode(ServerSettings.self, from: Data(#"{"machineNicknames":[1,2]}"#.utf8))
    #expect(broken.machineNicknames.isEmpty)
  }

  @Test func unknownLabelNamesTheMissingMachineOnlyWhenNeeded() {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC")!
    let locale = Locale(identifier: "en_US")
    let seen = TestData.date("2026-10-20T14:05:00.000Z")
    let now = seen.addingTimeInterval(300)
    func label(_ placement: ThreadPlacement, at now: Date = now) -> String? {
      placement.unknownLabel(now: now, calendar: calendar, locale: locale)?.replacingOccurrences(of: "\u{202F}", with: " ")
    }
    #expect(label(ThreadPlacement(owner: "M4")) == nil)
    #expect(label(ThreadPlacement(owner: "M4", unknown: .init(machine: "M4", lastSeenAt: seen))) == "Unknown · last seen 2:05 PM")
    #expect(label(ThreadPlacement(owner: "M4", runsOn: "Minis", unknown: .init(machine: "Minis", lastSeenAt: seen))) == "Unknown · last seen 2:05 PM")
    #expect(label(ThreadPlacement(owner: "M4", runsOn: "Minis", unknown: .init(machine: "M4", lastSeenAt: seen))) == "Unknown · M4 last seen 2:05 PM")
    #expect(label(ThreadPlacement(owner: "M4", unknown: .init(machine: "M4", lastSeenAt: nil))) == "Unknown · not reached yet")
    #expect(label(ThreadPlacement(owner: "M4", unknown: .init(machine: "M4", lastSeenAt: seen)), at: now.addingTimeInterval(86_400))?.hasPrefix("Unknown · last seen Oct 20") == true)
  }
}

@Suite struct ThreadExecutionWireTests {
  @Test func decodesWhereAThreadRuns() throws {
    var json = try JSONSerialization.jsonObject(with: Data(FixtureJSON.threadShell.utf8)) as! [String: Any]
    json["ownerMachineId"] = "m4"
    json["executionMachineId"] = "minis"
    json["executionMachineLabel"] = "Minis"
    json["executionState"] = "fenced"
    json["executionLastSeenAt"] = "2026-10-20T21:05:00.000Z"
    json["movedTo"] = ["threadId": "t2", "projectId": "p2", "kind": "handoff", "environmentId": "minis", "machineLabel": "Minis"]
    let thread = try WireCoding.decoder.decode(ThreadShell.self, from: JSONSerialization.data(withJSONObject: json))
    #expect(thread.ownerMachineId == "m4")
    #expect(thread.executionMachineId == "minis")
    #expect(thread.executionMachineLabel == "Minis")
    #expect(thread.executionState == .fenced)
    #expect(thread.executionLastSeenAt == TestData.date("2026-10-20T21:05:00.000Z"))
    #expect(thread.movedTo?.isHandoff == true)
    #expect(thread.movedTo?.environmentId == "minis")
  }

  @Test func olderOrNewerValuesDoNotBreakTheThread() throws {
    var json = try JSONSerialization.jsonObject(with: Data(FixtureJSON.threadShell.utf8)) as! [String: Any]
    json["executionState"] = "paused-somewhere"
    json["executionLastSeenAt"] = NSNull()
    json["movedTo"] = ["threadId": "t2", "projectId": "p2"]
    let thread = try WireCoding.decoder.decode(ThreadShell.self, from: JSONSerialization.data(withJSONObject: json))
    #expect(thread.executionState == nil)
    #expect(thread.executionLastSeenAt == nil)
    #expect(thread.movedTo?.isHandoff == false)
    #expect(thread.ownerMachineId == nil)
  }
}
