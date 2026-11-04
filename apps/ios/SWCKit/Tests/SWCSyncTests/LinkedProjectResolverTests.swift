import Foundation
import Testing
import SWCWire
@testable import SWCSync

@Suite struct LinkedProjectResolverTests {
  typealias Copy = LinkedProjectResolver.Copy
  static let now = TestData.date("2026-11-03T15:00:00.000Z")

  func member(_ env: String) -> LogicalProjectMember {
    LogicalProjectMember(environmentId: env, projectId: "p-\(env)", coordinatorThreadId: "project-coordinator:p-\(env)")
  }

  func copy(_ env: String, epoch: Int = 1, state: CoordinatorBindingState = .active, online: Bool = true, switchedOff: Bool = false, settled: Bool = true, lastSeen: Date? = nil, predecessor: String? = nil, standby: String? = nil, canTakeOver: Bool = true) -> Copy {
    let binding = CoordinatorBinding(epoch: epoch, state: state, predecessor: predecessor.map(member), standby: standby.map { CoordinatorStandby(member: member($0), afterMinutes: 15) })
    return Copy(ref: ProjectRef(environmentId: env, projectId: "p-\(env)"), machineLabel: env.uppercased(), machineOnline: online, machineSwitchedOff: switchedOff, machineSettled: settled, lastSeenAt: lastSeen, logicalProjectId: "lp", listedMembers: ["m1", "m3", "m4"].map(member), binding: binding, canTakeOver: canTakeOver, canRearm: true)
  }

  // MARK: Which copy opens

  @Test func theActiveCopyWithTheHighestEpochOpensWhateverIsListedFirst() {
    let copies = [copy("m1", epoch: 2), copy("m4", epoch: 5), copy("m3", epoch: 5, state: .transferred)]
    #expect(LinkedProjectResolver.coordinator(copies)?.ref.environmentId == "m4")
    #expect(LinkedProjectResolver.coordinatorProblem(copies) == nil)
  }

  @Test func anActiveCopyBeatsAHandoffInProgress() {
    let copies = [copy("m1", epoch: 6, state: .transferring), copy("m4", epoch: 5)]
    #expect(LinkedProjectResolver.coordinator(copies)?.ref.environmentId == "m4")
    let pendingOnly = [copy("m1", epoch: 6, state: .transferring), copy("m4", epoch: 5, state: .transferred)]
    #expect(LinkedProjectResolver.coordinator(pendingOnly)?.ref.environmentId == "m1")
    #expect(LinkedProjectResolver.coordinatorProblem(pendingOnly) == LinkedProjectResolver.pendingProblem)
  }

  @Test func aCopyTakenOverFromIsSupersededEvenWhileStillActive() {
    // M4 was unreachable; M1 took over at epoch 4 and M4 still thinks it coordinates.
    let copies = [copy("m4", epoch: 3), copy("m1", epoch: 4, predecessor: "m4")]
    let found = LinkedProjectResolver.coordinators(copies)
    #expect(found.coordinators.map(\.ref.environmentId) == ["m1"])
    #expect(found.superseded.map(\.ref.environmentId) == ["m4"])
  }

  @Test func aSameEpochSuccessorIsContested() {
    let copies = [copy("m4", epoch: 4), copy("m1", epoch: 4, predecessor: "m4")]
    #expect(LinkedProjectResolver.coordinators(copies).contested.count == 2)
    #expect(LinkedProjectResolver.coordinatorProblem(copies) == LinkedProjectResolver.contestedProblem)
  }

  @Test func withoutABindingNoCopyCoordinates() {
    let copies = [Copy(ref: ProjectRef(environmentId: "a", projectId: "p"), machineLabel: "A", machineOnline: true)]
    #expect(LinkedProjectResolver.coordinator(copies) == nil)
    #expect(LinkedProjectResolver.coordinatorProblem(copies) == LinkedProjectResolver.unavailableProblem)
  }

  @Test func theProjectRowOpensTheNewestOfSeveralActiveCoordinators() throws {
    func linked(_ id: String, epoch: Int) throws -> ProjectShell {
      var project = try TestData.project(id: id, title: "Specweave")
      project.workspaceSettings?.logicalProject = LogicalProject(id: "lp1", title: "Specweave", coordinatorId: "c")
      project.workspaceSettings?.coordinatorBinding = CoordinatorBinding(epoch: epoch, state: .active)
      return project
    }
    // Minis is listed first and has the newest thread; M4 coordinates at the higher epoch.
    let output = ShellSummaries.build([
      ShellSummaries.Machine(environmentId: "a-minis", label: "Minis", online: true, snapshot: ShellSnapshot(threads: [try TestData.thread(id: "b", projectId: "pm")], projects: [try linked("pm", epoch: 2)])),
      ShellSummaries.Machine(environmentId: "m4", label: "M4", online: true, snapshot: ShellSnapshot(threads: [], projects: [try linked("p4", epoch: 7)])),
    ])
    let row = try #require(output.projects.first)
    #expect(row.ref == ProjectRef(environmentId: "m4", projectId: "p4"))
    #expect(row.members.first?.isCoordinator == true)
  }

  // MARK: Unreachable and takeover

  @Test func takeoverWaitsTenMinutesFromWhenTheMachineWasLastSeen() {
    let at = { (seconds: TimeInterval) in
      LinkedProjectResolver.takeoverAvailability(coordinatorConnected: false, unreachableSince: Self.now, now: Self.now.addingTimeInterval(seconds))
    }
    #expect(at(0) == .init(available: false, wait: 600))
    #expect(at(599) == .init(available: false, wait: 1))
    #expect(at(600) == .init(available: true, wait: 0))
    #expect(!LinkedProjectResolver.takeoverAvailability(coordinatorConnected: true, unreachableSince: Self.now, now: Self.now.addingTimeInterval(3600)).available)
    #expect(!LinkedProjectResolver.takeoverAvailability(coordinatorConnected: false, unreachableSince: nil, now: Self.now).available)
  }

  @Test func aMachineNeverSeenStartsTheClockWhenFirstFoundGone() {
    var gone: [String: Date] = [:]
    #expect(LinkedProjectResolver.unreachableSince(environmentId: "m4", connected: false, lastSeenAt: nil, firstSeenGone: &gone, now: Self.now) == Self.now)
    let later = Self.now.addingTimeInterval(300)
    #expect(LinkedProjectResolver.unreachableSince(environmentId: "m4", connected: false, lastSeenAt: nil, firstSeenGone: &gone, now: later) == Self.now)
    let seen = Self.now.addingTimeInterval(-3600)
    #expect(LinkedProjectResolver.unreachableSince(environmentId: "m4", connected: false, lastSeenAt: seen, firstSeenGone: &gone, now: later) == seen)
    #expect(LinkedProjectResolver.unreachableSince(environmentId: "m4", connected: true, lastSeenAt: seen, firstSeenGone: &gone, now: later) == nil)
    #expect(gone.isEmpty)
  }

  @Test func unreachableLabelNamesTheMachineAndLastSync() {
    var utc = Calendar(identifier: .gregorian)
    utc.timeZone = TimeZone(identifier: "UTC")!
    let text = LinkedProjectResolver.unreachableLabel(machine: "M4", lastSyncedAt: TestData.date("2026-11-03T14:05:00.000Z"), now: Self.now, calendar: utc, locale: Locale(identifier: "en_US"))
    #expect(text.replacingOccurrences(of: "\u{202F}", with: " ") == "M4 unreachable · last synced 2:05 PM")
    #expect(LinkedProjectResolver.unreachableLabel(machine: "M4", lastSyncedAt: nil, now: Self.now) == "M4 unreachable · last synced: Unknown")
  }

  @Test func lastSyncedIsTheNewestReplicaPassWithTheCoordinator() {
    // The phone saw M4 a minute ago, but its notes last reached a copy 3 h ago.
    let coordinator = copy("m4", online: false, lastSeen: TestData.date("2026-11-03T14:59:00.000Z"))
    let minis = ProjectRef(environmentId: "m1", projectId: "p-m1")
    let statuses = [
      minis: ProjectLinkSyncStatus(pairs: [
        LinkedServerSyncPair(peerEnvironmentId: "m4", peerProjectId: "p-m4", kind: "replica", lastSuccessAt: "2026-11-03T12:00:00.000Z"),
        LinkedServerSyncPair(peerEnvironmentId: "m4", peerProjectId: "p-m4", kind: "memory", lastSuccessAt: "2026-11-03T14:50:00.000Z"),
        LinkedServerSyncPair(peerEnvironmentId: "m3", peerProjectId: "p-m3", kind: "replica", lastSuccessAt: "2026-11-03T14:59:00.000Z"),
      ]),
      // The coordinator's own report is cached from before it went away.
      coordinator.ref: ProjectLinkSyncStatus(pairs: [
        LinkedServerSyncPair(peerEnvironmentId: "m1", peerProjectId: "p-m1", kind: "replica", lastSuccessAt: "2026-11-03T14:40:00.000Z"),
      ]),
    ]
    #expect(LinkedProjectResolver.lastSynced(with: coordinator, statuses: statuses) == TestData.date("2026-11-03T12:00:00.000Z"))
    // Without any replica report, when the phone last saw it, as the desktop shows.
    #expect(LinkedProjectResolver.lastSynced(with: coordinator, statuses: [:]) == coordinator.lastSeenAt)
    // Replica passes that never succeeded: unknown.
    let failed = [minis: ProjectLinkSyncStatus(pairs: [LinkedServerSyncPair(peerEnvironmentId: "m4", peerProjectId: "p-m4", kind: "replica", lastError: "unreachable")])]
    #expect(LinkedProjectResolver.lastSynced(with: coordinator, statuses: failed) == nil)
  }

  @Test func aCoordinatorSwitchedOffOnThePhoneIsNeverTakenOverFrom() {
    let copies = [copy("m4", epoch: 3, online: false, switchedOff: true), copy("m1", epoch: 3, state: .transferred)]
    #expect(LinkedProjectResolver.reach(copies[0]) == .switchedOff)
    let rows = LinkedProjectResolver.rows(copies, now: Self.now, unreachableSince: Self.now.addingTimeInterval(-3600))
    #expect(rows[1].takeover == .unavailable("Turn on M4 on this phone first."))
    #expect(rows[1].note?.contains("switched off on this phone") == true)
  }

  @Test func aCoordinatorStillConnectingSinceLaunchOffersNoTakeover() {
    let copies = [copy("m4", epoch: 3, online: false, settled: false), copy("m1", epoch: 3, state: .transferred)]
    #expect(LinkedProjectResolver.reach(copies[0]) == .checking)
    let rows = LinkedProjectResolver.rows(copies, now: Self.now, unreachableSince: Self.now.addingTimeInterval(-3600))
    #expect(rows.allSatisfy { $0.takeover == .hidden })
  }

  @Test func rowsOfferTakeoverOnlyOnReachableWorkerCopiesAfterTheWait() {
    let copies = [
      copy("m4", epoch: 3, online: false, standby: "m1"),
      copy("m1", epoch: 3, state: .transferred),
      copy("m3", epoch: 3, state: .transferred, canTakeOver: false),
    ]
    let early = LinkedProjectResolver.rows(copies, now: Self.now, unreachableSince: Self.now.addingTimeInterval(-4 * 60))
    #expect(early.map(\.copy.ref.environmentId) == ["m4", "m1", "m3"])
    #expect(early.map(\.role) == [.coordinator, .workers, .workers])
    #expect(early[0].takeover == .hidden)
    #expect(early[1].takeover == .waiting(minutes: 6))
    #expect(early[1].isStandby)
    #expect(early[2].takeover == .unavailable("Update SpecWithCode on M3 to take over."))
    let late = LinkedProjectResolver.rows(copies, now: Self.now, unreachableSince: Self.now.addingTimeInterval(-11 * 60))
    #expect(late[1].takeover == .ready)
    #expect(late[1].note?.hasPrefix("M4 has been unreachable for 10 minutes or more.") == true)
    // A reachable coordinator offers nothing.
    var online = copies
    online[0].machineOnline = true
    #expect(LinkedProjectResolver.rows(online, now: Self.now, unreachableSince: nil).allSatisfy { $0.takeover == .hidden })
  }

  @Test func takeoverGoesAboveTheHighestEpochAndNamesThePredecessor() {
    let copies = [copy("m4", epoch: 3, online: false), copy("m1", epoch: 5, state: .transferred)]
    #expect(LinkedProjectResolver.highestEpoch(copies) == 5)
    #expect(copies[0].member == member("m4"))
  }

  // MARK: Standby and re-arm

  @Test func standbyShowsTheArmedMachineAndWait() {
    let copies = [copy("m4", epoch: 3, standby: "m1"), copy("m1", epoch: 3, state: .transferred), copy("m3", epoch: 3, state: .transferred)]
    let consent = ProjectStandbyRearmStatus.Consent(chainId: "c", members: [member("m1"), member("m3")], afterMinutes: 15)
    let standby = LinkedProjectResolver.standby(coordinator: copies[0], copies: copies, rearm: ProjectStandbyRearmStatus(consent: consent), now: Self.now)
    #expect(standby.title == "If M4 goes quiet")
    #expect(standby.standbyMachine == "M1")
    #expect(standby.after == "15 minutes")
    #expect(standby.armNext == "If it takes over, arm next: M3")
    #expect(standby.rearmStatus == nil)
    let off = LinkedProjectResolver.standby(coordinator: copy("m4"), copies: copies, rearm: nil, now: Self.now)
    #expect(off.standbyMachine == nil && off.after == nil && off.armNext == nil)
  }

  @Test func rearmStatusMirrorsTheDesktopWording() {
    let label = { (id: String) in id.uppercased() }
    typealias Run = ProjectStandbyRearmStatus.Run
    #expect(LinkedProjectResolver.rearmStatusText(nil, label: label) == nil)
    #expect(LinkedProjectResolver.rearmStatusText(Run(state: "pending", reason: "unreachable", detail: "M4"), label: label) == "No standby armed yet: M4 did not answer. Trying again.")
    #expect(LinkedProjectResolver.rearmStatusText(Run(state: "pending", reason: "no_consent"), label: label) == "No standby armed yet: The next machine is not on your current list. Save the list again. Waiting for you.")
    #expect(LinkedProjectResolver.rearmStatusText(Run(state: "pending", reason: nil), label: label) == "No standby armed yet: No other machine on your list. Trying again.")
    #expect(LinkedProjectResolver.rearmStatusText(Run(state: "pending", reason: "lease_failed", standby: member("m3")), label: label) == "M3 is still named as the standby: M3 did not answer its first check. Trying again later.")
    #expect(LinkedProjectResolver.rearmStatusText(Run(state: "verifying", standby: member("m3")), label: label) == "Checking M3.")
    #expect(LinkedProjectResolver.rearmStatusText(Run(state: "armed", standby: member("m3")), label: label) == "Armed M3 automatically after taking over.")
    #expect(LinkedProjectResolver.rearmStatusText(Run(state: "stopped", reason: "off"), label: label) == nil)
  }

  @Test func automaticTakeoverSaysWhoTookOver() {
    var minis = copy("m1", epoch: 4, predecessor: "m4")
    minis.binding?.takenOverBy = "auto"
    minis.binding?.takenOverAt = "2026-11-03T14:20:00.000Z"
    let standby = LinkedProjectResolver.standby(coordinator: minis, copies: [minis, copy("m4", epoch: 3, online: false)], rearm: nil, now: Self.now)
    #expect(standby.tookOver?.hasPrefix("M1 took over from M4 at ") == true)
    #expect(standby.tookOver?.hasSuffix(". M4 went quiet.") == true)
  }

  // MARK: Switched-off machines

  @Test func switchedOffPromptListsEachMachineOnceAndAsksOnce() {
    let copies = [copy("m4"), copy("m1", switchedOff: true), copy("m3", switchedOff: true), copy("m1", switchedOff: true)]
    let off = LinkedProjectResolver.switchedOffMachines(copies)
    #expect(off.map(\.ref.environmentId) == ["m1", "m3"])
    #expect(LinkedProjectResolver.switchedOffPromptTitle(off) == "Turn on M1 and M3?")
    #expect(LinkedProjectResolver.shouldPromptSwitchedOff(projectKey: "lp", copies: copies, asked: []))
    #expect(!LinkedProjectResolver.shouldPromptSwitchedOff(projectKey: "lp", copies: copies, asked: ["lp"]))
    #expect(!LinkedProjectResolver.shouldPromptSwitchedOff(projectKey: "lp", copies: [copy("m4")], asked: []))
  }

  // MARK: Wire

  @Test func bindingDecodesStandbyAndTakeoverFields() throws {
    let json = #"{"epoch":4,"state":"active","predecessor":{"environmentId":"m4","projectId":"p","coordinatorThreadId":"t"},"takenOverAt":"2026-11-03T14:20:00.000Z","takenOverBy":"auto","standby":{"member":{"environmentId":"m3","projectId":"q","coordinatorThreadId":"u"},"afterMinutes":30,"enabledAt":"2026-11-03T14:21:00.000Z"}}"#
    let binding = try JSONDecoder().decode(CoordinatorBinding.self, from: Data(json.utf8))
    #expect(binding.takenOverBy == "auto")
    #expect(binding.standby?.member.environmentId == "m3")
    #expect(binding.standby?.afterMinutes == 30)
    // A standby shaped differently reads as off; the binding still decodes.
    let odd = try JSONDecoder().decode(CoordinatorBinding.self, from: Data(#"{"epoch":1,"state":"active","standby":{"x":1}}"#.utf8))
    #expect(odd.standby == nil && odd.epoch == 1)
  }

  @Test func syncStatusDecodesRearmRunAndToleratesOlderServers() throws {
    let json = #"{"pairs":[{"peerEnvironmentId":"m4","peerProjectId":"p","kind":"replica","lastSuccessAt":null,"lastAttemptAt":null,"lastError":"unreachable"}],"standbyRearm":{"consent":null,"run":{"state":"pending","reason":"no_candidates","detail":null,"standby":null,"epoch":4,"since":"2026-11-03T14:21:00.000Z"}}}"#
    let status = try JSONDecoder().decode(ProjectLinkSyncStatus.self, from: Data(json.utf8))
    #expect(status.pairs.first?.lastError == "unreachable")
    #expect(status.standbyRearm?.run?.reason == "no_candidates")
    let old = try JSONDecoder().decode(ProjectLinkSyncStatus.self, from: Data(#"{"pairs":[]}"#.utf8))
    #expect(old.standbyRearm == nil)
  }

  @Test func disarmSendsAnExplicitNullStandby() throws {
    let data = try JSONEncoder().encode(ProjectStandbyDisarmInput(projectId: "p", logicalProjectId: "lp", belowEpoch: 5))
    let object = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    #expect(object["standby"] is NSNull)
    #expect(object["belowEpoch"] as? Int == 5)
  }
}

extension LinkedProjectResolverTests {
  @Test func aSupersededCopySaysItGivesWay() {
    let copies = [copy("m4", epoch: 3, online: false), copy("m1", epoch: 4, predecessor: "m4")]
    let rows = LinkedProjectResolver.rows(copies, now: Self.now, unreachableSince: nil)
    #expect(rows.map(\.copy.ref.environmentId) == ["m1", "m4"])
    #expect(rows[1].note == "M1 took over while this machine was unreachable. It gives way when both machines are reachable.")
    #expect(rows.allSatisfy { $0.takeover == .hidden })
  }

  @Test func switchedOffPromptReadsForOneOrSeveral() {
    let one = [copy("m1", switchedOff: true)]
    #expect(LinkedProjectResolver.switchedOffPromptMessage(one, project: "SpecWeave") == "M1 has a copy of SpecWeave and is switched off on this phone. Turn it on to see its threads and coordinator.")
    let two = one + [copy("m3", switchedOff: true)]
    #expect(LinkedProjectResolver.switchedOffPromptMessage(two, project: "SpecWeave").hasPrefix("2 machines with a copy of SpecWeave are switched off"))
  }
}
