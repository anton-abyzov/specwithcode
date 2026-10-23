import Foundation
import Testing
@testable import SWCFeatures
import SWCSync

/// The fleet fixture's scripted faults, which the simulator screenshots show:
/// a machine drops mid-session, its threads stay listed as unknown, and when
/// it comes back the rows are the same ones, with no duplicates.
@MainActor
@Suite("Fleet fixture faults")
struct FleetFixtureTests {
  private let m4 = "env-m4"
  private let minis = "env-minis"

  private func make(_ scenario: FixtureScenario, step: Duration = .milliseconds(40)) -> AppModel {
    let engine = FixtureEngine(scenario: scenario)
    engine.latency = .zero
    engine.streamDelay = .zero
    engine.faultStep = step
    return AppModel(engine: engine)
  }

  private func threads(_ model: AppModel) throws -> [ThreadSummary] {
    model.threads(in: try #require(model.projects.first).ref)
  }

  private func waitFor(_ condition: () -> Bool) async {
    for _ in 0..<400 where !condition() { try? await Task.sleep(for: .milliseconds(5)) }
  }

  @Test func fleetScenarioMergesBothMachinesIntoOneProject() throws {
    let model = make(.fleet)
    let project = try #require(model.projects.first)
    #expect(model.projects.count == 1)
    #expect(project.members.map(\.machineLabel) == ["M4", "Minis"])
    #expect(project.members.first?.isCoordinator == true)
    let rows = try threads(model)
    #expect(rows.count == 5)
    #expect(rows.allSatisfy { !$0.isUnknown })
    #expect(rows.first { $0.ref.threadId == "f-windows" }?.placement.label == "M4 → Minis")
    #expect(rows.first { $0.ref.threadId == "f-linux" }?.placement.label == "Minis")
  }

  @Test func m4OffMidSessionThenBackKeepsTheSameRows() async throws {
    let model = make(.m4Blip)
    let before = try threads(model).map(\.ref)

    await waitFor { model.machine(m4)?.status.isOnline == false }
    let during = try threads(model)
    #expect(during.map(\.ref).sorted { $0.threadId < $1.threadId } == before.sorted { $0.threadId < $1.threadId })
    let unknown = during.filter(\.isUnknown).map(\.ref.threadId).sorted()
    #expect(unknown == ["f-phone", "f-release", "f-windows"])
    #expect(during.filter(\.isUnknown).allSatisfy { $0.placement.unknown?.machine == "M4" && $0.placement.unknown?.lastSeenAt != nil })
    let windows = try #require(during.first { $0.ref.threadId == "f-windows" })
    #expect(windows.placement.subtitle().hasPrefix("M4 → Minis · Unknown · M4 last seen "))
    let member = try #require(model.projects.first?.members.first { $0.ref.environmentId == m4 })
    #expect(!member.machineOnline)
    #expect(OrchestratorSwitcher.detail(member).hasPrefix("Coordinator · Offline · last seen "))

    await waitFor { model.machine(m4)?.status.isOnline == true }
    let after = try threads(model)
    #expect(after.count == before.count)
    #expect(Set(after.map(\.ref)).count == after.count)
    #expect(after.allSatisfy { !$0.isUnknown })
  }

  @Test func minisOffWhileViewedLeavesM4Working() async throws {
    let model = make(.minisBlip)
    let router = AppRouter()
    router.pendingLaunchRoute = .orchestrator
    #expect(router.applyLaunchRoute(in: model))
    let target = ChatTarget.project(ProjectRef(environmentId: minis, projectId: "specweave"))
    #expect(router.main.path.isEmpty)
    #expect(router.landing(in: model) == target)
    let session = model.session(for: target)
    model.openSession(session)
    #expect(session.machineOnline)

    await waitFor { model.machine(minis)?.status.isOnline == false }
    #expect(!session.machineOnline)
    #expect(session.sendBlockedReason != nil)
    let rows = try threads(model)
    #expect(rows.count == 5)
    #expect(rows.filter(\.isUnknown).map(\.ref.threadId).sorted() == ["f-docs", "f-linux", "f-windows"])
    let windows = try #require(rows.first { $0.ref.threadId == "f-windows" })
    #expect(windows.placement.subtitle().hasPrefix("M4 → Minis · Unknown · last seen "))
    #expect(rows.first { $0.ref.threadId == "f-phone" }?.isUnknown == false)
    let coordinator = try #require(model.projects.first?.members.first)
    #expect(coordinator.machineOnline && coordinator.isCoordinator)

    await waitFor { model.machine(minis)?.status.isOnline == true }
    #expect(session.machineOnline)
    #expect(try threads(model).allSatisfy { !$0.isUnknown })
  }

  @Test func m4CoordinatorViewedWhileM4DropsGoesOfflineAndBack() async throws {
    let model = make(.m4Blip)
    let target = ChatTarget.project(ProjectRef(environmentId: m4, projectId: "specweave"))
    let session = model.session(for: target)
    model.openSession(session)
    #expect(session.machineOnline)

    await waitFor { model.machine(m4)?.status.isOnline == false }
    #expect(!session.machineOnline)
    #expect(session.sendBlockedReason != nil)

    await waitFor { model.machine(m4)?.status.isOnline == true }
    #expect(session.machineOnline)
  }

  @Test func coordinatorRouteOpensTheActiveCoordinator() {
    let model = make(.fleet)
    let router = AppRouter()
    router.pendingLaunchRoute = .coordinator
    #expect(router.applyLaunchRoute(in: model))
    #expect(router.main.path.isEmpty)
    #expect(router.landing(in: model) == .project(ProjectRef(environmentId: m4, projectId: "specweave")))
  }

  /// The root chat and a pushed copy of it share one session; the copy that
  /// leaves last must not stop the one still on screen from updating.
  @Test func aChatOnScreenTwiceKeepsUpdatingWhenOneCopyCloses() async throws {
    let model = make(.m4Blip)
    let session = model.session(for: .project(ProjectRef(environmentId: m4, projectId: "specweave")))
    model.openSession(session)
    model.openSession(session)
    model.closeSession(session)

    await waitFor { model.machine(m4)?.status.isOnline == false }
    #expect(!session.machineOnline)
    await waitFor { model.machine(m4)?.status.isOnline == true }
    #expect(session.machineOnline)
    model.closeSession(session)
  }

  @Test func blipScenariosParseFromLaunchArguments() {
    #expect(LaunchOptions.parse(["app", "-SWCFixture", "m4-blip", "-SWCRoute", "overview"]).fixture == .m4Blip)
    #expect(LaunchOptions.parse(["app", "-SWCFixture", "Minis-Blip", "-SWCRoute", "orchestrator"]).route == .orchestrator)
  }

  @Test func defaultScenarioListsTheOfflineLaptopsThreadsAsUnknown() throws {
    let model = make(.default)
    let docs = try #require(model.projects.first { $0.title == "Docs site" })
    let rows = model.threads(in: docs.ref)
    #expect(!rows.isEmpty)
    #expect(rows.allSatisfy { $0.placement.unknown?.machine == "Travel laptop" && $0.placement.unknown?.lastSeenAt != nil })
    #expect(ThreadGroups(rows).idle.count == rows.filter { !$0.isResolved }.count)
  }
}
